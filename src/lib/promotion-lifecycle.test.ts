import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { PromotionStatus, ChangeSessionStatus } from "@/generated/prisma/enums";

const dbMock = {
  promotion: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn() },
  changeSession: { updateMany: vi.fn() },
  hallOfFameEntry: { createMany: vi.fn() },
  performanceSnapshot: { findMany: vi.fn(), createMany: vi.fn() },
  user: { findMany: vi.fn() },
};
const getLeaderboardMock = vi.fn();
const awardCloseOnlyBadgesMock = vi.fn();
const revalidateTagMock = vi.fn();
const getPromotionPerformanceSeriesMock = vi.fn();

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/gamification/get-leaderboard", () => ({ getLeaderboard: getLeaderboardMock }));
vi.mock("@/lib/gamification/award-close-only-badges", () => ({ awardCloseOnlyBadges: awardCloseOnlyBadgesMock }));
vi.mock("@/lib/gamification/get-promotion-performance-series", () => ({
  getPromotionPerformanceSeries: getPromotionPerformanceSeriesMock,
}));
vi.mock("next/cache", () => ({ revalidateTag: revalidateTagMock }));

const { closePromotionIfEnded, closeEndedPromotions, finalizePromotionClosure } = await import(
  "./promotion-lifecycle"
);

// Horloge figée APRÈS l'endDate du concours — pour la clôture automatique
// `endDate <= now`, donc asOf = min(endDate, now) = endDate (déterministe).
const NOW = new Date("2026-09-01T00:00:00Z");
const END = new Date("2026-08-28T10:00:00Z"); // 12:00 Paris — endDate du concours
const PROMO = {
  id: "promo-1",
  name: "Promotion Août 2026",
  status: PromotionStatus.CLOSED,
  endDate: END,
  initialCapital: 1_000_000,
};

function resetMocks() {
  Object.values(dbMock).forEach((g) => Object.values(g).forEach((fn) => fn.mockReset()));
  [getLeaderboardMock, awardCloseOnlyBadgesMock, revalidateTagMock, getPromotionPerformanceSeriesMock].forEach(
    (fn) => fn.mockReset(),
  );
  dbMock.promotion.findUniqueOrThrow.mockResolvedValue(PROMO);
  dbMock.promotion.findMany.mockResolvedValue([]);
  dbMock.changeSession.updateMany.mockResolvedValue({ count: 0 });
  dbMock.hallOfFameEntry.createMany.mockResolvedValue({ count: 2 });
  dbMock.performanceSnapshot.findMany.mockResolvedValue([]);
  dbMock.performanceSnapshot.createMany.mockResolvedValue({ count: 2 });
  dbMock.user.findMany.mockResolvedValue([
    { id: "u1", avatarUrl: "data:image/jpeg;base64,alice" },
    { id: "u2", avatarUrl: null },
  ]);
  awardCloseOnlyBadgesMock.mockResolvedValue([]);
  getLeaderboardMock.mockResolvedValue([
    { userId: "u1", name: "Alice", portfolioId: "p1", totalValue: 1_120_000, cumulativeReturnPct: 12, rank: 1 },
    { userId: "u2", name: "Bob", portfolioId: "p2", totalValue: 980_000, cumulativeReturnPct: -2, rank: 2 },
  ]);
  getPromotionPerformanceSeriesMock.mockResolvedValue({
    points: [
      {
        date: "2026-08-28",
        label: "28/08/2026",
        values: { Alice: { totalValue: 1_120_000, cumulativeReturnPct: 12, dailyReturnPct: 0 } },
      },
    ],
    participantNames: ["Alice", "Bob"],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetMocks();
});
afterAll(() => {
  vi.useRealTimers();
});

describe("closePromotionIfEnded", () => {
  it("ne fait rien si la garde atomique ne transitionne pas (count 0)", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 0 });
    const result = await closePromotionIfEnded("promo-1", new Date("2026-08-28T08:00:00Z"));
    expect(result).toEqual({ closed: false });
    expect(dbMock.promotion.updateMany).toHaveBeenCalledWith({
      where: { id: "promo-1", status: PromotionStatus.ACTIVE, endDate: { lte: new Date("2026-08-28T08:00:00Z") } },
      data: { status: PromotionStatus.CLOSED },
    });
    expect(getLeaderboardMock).not.toHaveBeenCalled();
  });

  it("finalise une seule fois quand la garde transitionne (count 1)", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
    const result = await closePromotionIfEnded("promo-1", new Date("2026-08-28T10:30:00Z"));
    expect(result).toEqual({ closed: true });
    expect(getLeaderboardMock).toHaveBeenCalledWith("promo-1", END, { frozen: true });
    expect(awardCloseOnlyBadgesMock).toHaveBeenCalledWith("promo-1", END, expect.any(Array));
    expect(dbMock.changeSession.updateMany).toHaveBeenCalledWith({
      where: { promotionId: "promo-1", status: { not: ChangeSessionStatus.CLOSED } },
      data: { status: ChangeSessionStatus.CLOSED },
    });
  });

  it("écrit le classement figé en un seul createMany atomique (skipDuplicates), avec snapshot des photos", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
    await closePromotionIfEnded("promo-1", new Date("2026-08-28T10:30:00Z"));
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledTimes(1);
    expect(dbMock.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["u1", "u2"] } },
      select: { id: true, avatarUrl: true },
    });
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledWith({
      data: [
        {
          promotionId: "promo-1",
          userId: "u1",
          userName: "Alice",
          promotionName: "Promotion Août 2026",
          finalReturnPct: 12,
          finalPnlEur: 120_000,
          finalRank: 1,
          avatarUrl: "data:image/jpeg;base64,alice",
          closedAt: END,
        },
        {
          promotionId: "promo-1",
          userId: "u2",
          userName: "Bob",
          promotionName: "Promotion Août 2026",
          finalReturnPct: -2,
          finalPnlEur: -20_000,
          finalRank: 2,
          avatarUrl: null,
          closedAt: END,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("invalide le cache du classement et du tableau de bord (bascule en valorisation figée)", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
    await closePromotionIfEnded("promo-1", new Date("2026-08-28T10:30:00Z"));
    expect(revalidateTagMock).toHaveBeenCalledWith("leaderboard", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("portfolio-view", "max");
    expect(revalidateTagMock).not.toHaveBeenCalledWith("hall-of-fame", "max");
  });

  it("écrit un PerformanceSnapshot terminal par portefeuille, horodaté à l'endDate", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
    await closePromotionIfEnded("promo-1", new Date("2026-08-28T10:30:00Z"));
    expect(dbMock.performanceSnapshot.findMany).toHaveBeenCalledWith({
      where: { portfolioId: { in: ["p1", "p2"] }, timestamp: END },
      select: { portfolioId: true },
    });
    expect(dbMock.performanceSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        { portfolioId: "p1", timestamp: END, totalValue: 1_120_000, dailyReturnPct: 0, cumulativeReturnPct: 12, rank: 1 },
        { portfolioId: "p2", timestamp: END, totalValue: 980_000, dailyReturnPct: 0, cumulativeReturnPct: -2, rank: 2 },
      ],
    });
  });

  it("ne réécrit pas un PerformanceSnapshot terminal déjà présent (rejouable)", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
    dbMock.performanceSnapshot.findMany.mockResolvedValue([{ portfolioId: "p1" }]);
    await closePromotionIfEnded("promo-1", new Date("2026-08-28T10:30:00Z"));
    expect(dbMock.performanceSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        { portfolioId: "p2", timestamp: END, totalValue: 980_000, dailyReturnPct: 0, cumulativeReturnPct: -2, rank: 2 },
      ],
    });
  });

  it("ne casse pas si revalidateTag lève (rendu RSC hors server action)", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
    revalidateTagMock.mockImplementation(() => {
      throw new Error('used "revalidateTag" during render which is unsupported');
    });
    await expect(
      closePromotionIfEnded("promo-1", new Date("2026-08-28T10:30:00Z")),
    ).resolves.toEqual({ closed: true });
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledTimes(1);
  });
});

describe("closeEndedPromotions", () => {
  it("retourne les ids effectivement clôturés (balayage ACTIVE)", async () => {
    const now = new Date("2026-08-28T10:30:00Z");

    // 1er findMany = candidats ACTIVE ; 2e findMany = promotions CLOSED bloquées (aucune ici).
    dbMock.promotion.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([]);
    dbMock.promotion.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const result = await closeEndedPromotions(now);

    expect(result).toEqual(["a"]);
    expect(dbMock.promotion.findMany).toHaveBeenNthCalledWith(1, {
      where: { status: PromotionStatus.ACTIVE, endDate: { lte: now } },
      select: { id: true },
    });
  });

  it("rejoue la finalisation des promotions CLOSED sans entrée Hall of Fame (filet)", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    dbMock.promotion.findMany
      .mockResolvedValueOnce([]) // aucun candidat ACTIVE
      .mockResolvedValueOnce([{ id: "stuck-1" }]); // une promo CLOSED à moitié finalisée

    const result = await closeEndedPromotions(now);

    expect(result).toEqual([]);
    expect(dbMock.promotion.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: PromotionStatus.CLOSED,
        endDate: { lte: now },
        hallOfFameEntries: { none: {} },
      },
      select: { id: true },
    });
    // finalizePromotionClosure a bien tourné pour la promo bloquée.
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledTimes(1);
  });

  it("ne rejoue pas la finalisation d'une promo CLOSED qui a déjà ses entrées", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    dbMock.promotion.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // le filtre hallOfFameEntries: none exclut celles déjà finalisées

    await closeEndedPromotions(now);

    expect(dbMock.hallOfFameEntry.createMany).not.toHaveBeenCalled();
  });
});

describe("finalizePromotionClosure", () => {
  it("est rejouable sans effet — createMany({ skipDuplicates }) appelé une fois par rejeu", async () => {
    await finalizePromotionClosure("promo-1");
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledTimes(1);
    expect(dbMock.hallOfFameEntry.createMany.mock.calls[0][0]).toHaveProperty("skipDuplicates", true);

    resetMocks();

    // Rejeu : skipDuplicates rend le second createMany équivalent à un no-op.
    await finalizePromotionClosure("promo-1");
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledTimes(1);
    expect(dbMock.hallOfFameEntry.createMany.mock.calls[0][0]).toHaveProperty("skipDuplicates", true);
  });

  it("cohorte vide : findMany({ id: { in: [] } }) et createMany({ data: [] }) sans planter", async () => {
    getLeaderboardMock.mockResolvedValue([]);

    await expect(finalizePromotionClosure("promo-1")).resolves.toBeUndefined();

    expect(dbMock.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
      select: { id: true, avatarUrl: true },
    });
    expect(dbMock.hallOfFameEntry.createMany).toHaveBeenCalledWith({ data: [], skipDuplicates: true });
  });

  it("clôture anticipée : asOf = now quand endDate est dans le futur (pas de date de fin future)", async () => {
    const futureEnd = new Date("2026-10-01T00:00:00Z"); // après l'horloge figée (2026-09-01)
    dbMock.promotion.findUniqueOrThrow.mockResolvedValue({ ...PROMO, endDate: futureEnd });

    await finalizePromotionClosure("promo-1");

    expect(getLeaderboardMock).toHaveBeenCalledWith("promo-1", NOW, { frozen: true });
    expect(awardCloseOnlyBadgesMock).toHaveBeenCalledWith("promo-1", NOW, expect.any(Array));
    const data = dbMock.hallOfFameEntry.createMany.mock.calls[0][0].data as { closedAt: Date }[];
    expect(data.every((row) => row.closedAt.getTime() === NOW.getTime())).toBe(true);
  });
});

describe("finalizePromotionClosure — snapshot final du graphique", () => {
  it("écrit finalChartSnapshot une seule fois (garde finalChartSnapshot: Prisma.DbNull)", async () => {
    await finalizePromotionClosure("promo-1");

    expect(getPromotionPerformanceSeriesMock).toHaveBeenCalledWith("promo-1");
    expect(dbMock.promotion.updateMany).toHaveBeenCalledWith({
      where: { id: "promo-1", finalChartSnapshot: { equals: Prisma.DbNull } },
      data: {
        finalChartSnapshot: {
          points: [
            {
              date: "2026-08-28",
              label: "28/08/2026",
              values: { Alice: { totalValue: 1_120_000, cumulativeReturnPct: 12, dailyReturnPct: 0 } },
            },
          ],
          participantNames: ["Alice", "Bob"],
          participantAvatars: { Alice: "data:image/jpeg;base64,alice", Bob: null },
        },
      },
    });
  });

  it("retombe sur null pour un participant absent du classement final (garde-fou)", async () => {
    getPromotionPerformanceSeriesMock.mockResolvedValue({
      // Non vide : un tableau `points` vide ne déclenche plus l'écriture (voir garde
      // "n'écrit pas de snapshot quand la reconstruction est vide" ci-dessous) — ce
      // test porte sur le fallback participantAvatars, pas sur ce garde-fou.
      points: [{ date: "2026-08-28", label: "28/08/2026", values: {} }],
      participantNames: ["Alice", "Charlie"], // Charlie n'est pas dans getLeaderboardMock
    });

    await finalizePromotionClosure("promo-1");

    const call = dbMock.promotion.updateMany.mock.calls[0][0] as {
      data: { finalChartSnapshot: { participantAvatars: Record<string, string | null> } };
    };
    expect(call.data.finalChartSnapshot.participantAvatars).toEqual({
      Alice: "data:image/jpeg;base64,alice",
      Charlie: null,
    });
  });

  it("appelle getPromotionPerformanceSeries après l'écriture du snapshot terminal (ordre)", async () => {
    const callOrder: string[] = [];
    dbMock.performanceSnapshot.createMany.mockImplementation(async () => {
      callOrder.push("createMany-snapshot-terminal");
      return { count: 2 };
    });
    getPromotionPerformanceSeriesMock.mockImplementation(async () => {
      callOrder.push("getPromotionPerformanceSeries");
      return { points: [], participantNames: [] };
    });

    await finalizePromotionClosure("promo-1");

    expect(callOrder).toEqual(["createMany-snapshot-terminal", "getPromotionPerformanceSeries"]);
  });

  it("n'écrit pas de snapshot quand la reconstruction est vide (rien à afficher)", async () => {
    getPromotionPerformanceSeriesMock.mockResolvedValue({ points: [], participantNames: [] });

    await finalizePromotionClosure("promo-1");

    expect(dbMock.promotion.updateMany).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { PromotionStatus, ChangeSessionStatus } from "@/generated/prisma/enums";

const dbMock = {
  promotion: { findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  hallOfFameEntry: { findMany: vi.fn(), deleteMany: vi.fn() },
  performanceSnapshot: { deleteMany: vi.fn() },
  userBadge: { deleteMany: vi.fn() },
  changeSession: { findMany: vi.fn(), updateMany: vi.fn() },
  auditLog: { findMany: vi.fn() },
  $transaction: vi.fn(),
};
const revalidateTagMock = vi.fn();

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("next/cache", () => ({ revalidateTag: revalidateTagMock }));
vi.mock("@/lib/gamification/get-leaderboard", () => ({ getLeaderboard: vi.fn() }));
vi.mock("@/lib/gamification/award-close-only-badges", () => ({ awardCloseOnlyBadges: vi.fn() }));
vi.mock("@/lib/gamification/get-promotion-performance-series", () => ({ getPromotionPerformanceSeries: vi.fn() }));
vi.mock("@/lib/gamification/badges/catalog", () => ({
  CLOSE_ONLY_CODES: new Set(["CHAMPION_DU_CONCOURS", "SANS_FAUTE"]),
}));

const { reopenPromotion, statusToRestoreOnReopen } = await import("./promotion-lifecycle");

const NOW = new Date("2026-10-02T10:00:00Z");
const CLOSED_AT = new Date("2026-10-02T09:30:00Z");

beforeEach(() => {
  for (const group of Object.values(dbMock)) {
    if (typeof group === "function") group.mockReset();
    else Object.values(group).forEach((fn) => fn.mockReset());
  }
  revalidateTagMock.mockReset();
  dbMock.$transaction.mockImplementation(async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock));
  dbMock.promotion.findUniqueOrThrow.mockResolvedValue({
    status: PromotionStatus.CLOSED,
    endDate: new Date("2026-11-30T17:00:00Z"),
  });
  dbMock.promotion.findFirst.mockResolvedValue(null);
  dbMock.promotion.updateMany.mockResolvedValue({ count: 1 });
  dbMock.hallOfFameEntry.findMany.mockResolvedValue([{ closedAt: CLOSED_AT }]);
  dbMock.hallOfFameEntry.deleteMany.mockResolvedValue({ count: 12 });
  dbMock.performanceSnapshot.deleteMany.mockResolvedValue({ count: 12 });
  dbMock.userBadge.deleteMany.mockResolvedValue({ count: 5 });
  dbMock.changeSession.findMany.mockResolvedValue([{ id: "s-past" }, { id: "s-future" }, { id: "s-manual" }]);
  dbMock.auditLog.findMany.mockResolvedValue([
    { target: "s-manual", after: { status: ChangeSessionStatus.CLOSED } },
    { target: "s-manual", after: { status: ChangeSessionStatus.OPEN } },
  ]);
  dbMock.changeSession.updateMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({
    count: where.id.in.length,
  }));
});

describe("statusToRestoreOnReopen", () => {
  it("revient à SCHEDULED sans dérogation manuelle (l'horloge décide)", () => {
    expect(statusToRestoreOnReopen(undefined)).toBe(ChangeSessionStatus.SCHEDULED);
    expect(statusToRestoreOnReopen(ChangeSessionStatus.SCHEDULED)).toBe(ChangeSessionStatus.SCHEDULED);
  });

  it("conserve la dernière dérogation manuelle de l'admin", () => {
    expect(statusToRestoreOnReopen(ChangeSessionStatus.CLOSED)).toBe(ChangeSessionStatus.CLOSED);
    expect(statusToRestoreOnReopen(ChangeSessionStatus.OPEN)).toBe(ChangeSessionStatus.OPEN);
  });
});

describe("reopenPromotion", () => {
  it("défait tout ce qu'écrit la clôture et repasse la promotion en ACTIVE", async () => {
    const result = await reopenPromotion("promo-1", NOW);

    expect(result).toEqual({
      reopened: true,
      restoredSessions: 2,
      removedHallOfFameEntries: 12,
      removedBadges: 5,
      removedFinalSnapshots: 12,
    });
    expect(dbMock.promotion.updateMany).toHaveBeenCalledWith({
      where: { id: "promo-1", status: PromotionStatus.CLOSED },
      data: { status: PromotionStatus.ACTIVE, finalChartSnapshot: Prisma.DbNull },
    });
    expect(dbMock.performanceSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { portfolio: { promotionId: "promo-1" }, timestamp: { in: [CLOSED_AT] } },
    });
    expect(dbMock.hallOfFameEntry.deleteMany).toHaveBeenCalledWith({ where: { promotionId: "promo-1" } });
    expect(dbMock.userBadge.deleteMany).toHaveBeenCalledWith({
      where: { promotionId: "promo-1", badge: { code: { in: ["CHAMPION_DU_CONCOURS", "SANS_FAUTE"] } } },
    });
    // s-manual : dernière dérogation (la plus récente en premier) = CLOSED → reste fermée.
    expect(dbMock.changeSession.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.changeSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s-past", "s-future"] } },
      data: { status: ChangeSessionStatus.SCHEDULED },
    });
    expect(revalidateTagMock).toHaveBeenCalledWith("leaderboard", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("portfolio-view", "max");
  });

  it("refuse si la promotion n'est pas clôturée", async () => {
    dbMock.promotion.findUniqueOrThrow.mockResolvedValue({ status: PromotionStatus.ACTIVE, endDate: new Date("2026-11-30") });
    const result = await reopenPromotion("promo-1", NOW);
    expect(result.reopened).toBe(false);
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("refuse si la date de fin est passée (le concours se refermerait aussitôt)", async () => {
    dbMock.promotion.findUniqueOrThrow.mockResolvedValue({
      status: PromotionStatus.CLOSED,
      endDate: new Date("2026-10-01T17:00:00Z"),
    });
    const result = await reopenPromotion("promo-1", NOW);
    expect(result).toEqual({ reopened: false, error: expect.stringContaining("Paramètres") });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("refuse si une autre promotion est déjà en cours", async () => {
    dbMock.promotion.findFirst.mockResolvedValue({ name: "Promotion Hiver" });
    const result = await reopenPromotion("promo-1", NOW);
    expect(result).toEqual({ reopened: false, error: expect.stringContaining("Promotion Hiver") });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("ne touche à rien si un autre onglet a déjà rouvert entre-temps", async () => {
    dbMock.promotion.updateMany.mockResolvedValue({ count: 0 });
    const result = await reopenPromotion("promo-1", NOW);
    expect(result).toEqual({ reopened: false, error: "Cette promotion a déjà été rouverte." });
    expect(dbMock.hallOfFameEntry.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.userBadge.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.changeSession.updateMany).not.toHaveBeenCalled();
  });

  it("ne supprime aucun snapshot si la finalisation n'avait écrit aucune entrée Hall of Fame", async () => {
    dbMock.hallOfFameEntry.findMany.mockResolvedValue([]);
    dbMock.hallOfFameEntry.deleteMany.mockResolvedValue({ count: 0 });
    const result = await reopenPromotion("promo-1", NOW);
    expect(result).toMatchObject({ reopened: true, removedFinalSnapshots: 0 });
    expect(dbMock.performanceSnapshot.deleteMany).not.toHaveBeenCalled();
  });
});

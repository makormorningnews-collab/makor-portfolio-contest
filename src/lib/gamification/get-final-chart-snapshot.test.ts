import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = { promotion: { findUnique: vi.fn() } };
vi.mock("@/lib/db", () => ({ db: dbMock }));

const { getFinalChartSnapshot } = await import("./get-final-chart-snapshot");

beforeEach(() => {
  dbMock.promotion.findUnique.mockReset();
});

describe("getFinalChartSnapshot", () => {
  it("renvoie null si le champ est absent (promotion pas encore clôturée)", async () => {
    dbMock.promotion.findUnique.mockResolvedValue({ finalChartSnapshot: null });
    const result = await getFinalChartSnapshot("promo-1");
    expect(result).toBeNull();
  });

  it("renvoie null si la promotion n'existe pas", async () => {
    dbMock.promotion.findUnique.mockResolvedValue(null);
    const result = await getFinalChartSnapshot("promo-1");
    expect(result).toBeNull();
  });

  it("parse et renvoie le snapshot quand il est présent", async () => {
    const snapshot = {
      points: [
        {
          date: "2026-08-28",
          label: "28/08/2026",
          values: { Alice: { totalValue: 1_120_000, cumulativeReturnPct: 12, dailyReturnPct: 0 } },
        },
      ],
      participantNames: ["Alice", "Bob"],
      participantAvatars: { Alice: "data:image/jpeg;base64,alice", Bob: null },
    };
    dbMock.promotion.findUnique.mockResolvedValue({ finalChartSnapshot: snapshot });

    const result = await getFinalChartSnapshot("promo-1");

    expect(result).toEqual(snapshot);
    expect(dbMock.promotion.findUnique).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      select: { finalChartSnapshot: true },
    });
  });

  it("lève si le JSON stocké ne correspond pas au schéma attendu", async () => {
    dbMock.promotion.findUnique.mockResolvedValue({ finalChartSnapshot: { points: "not-an-array" } });
    await expect(getFinalChartSnapshot("promo-1")).rejects.toThrow();
  });
});

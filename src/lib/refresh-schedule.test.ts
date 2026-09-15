import { describe, it, expect } from "vitest";
import {
  getRefreshTier,
  isMarketHours,
  getPollIntervalMs,
  MORNING_INTERVAL_MS,
  GOLDEN_INTERVAL_MS,
  EVENING_INTERVAL_MS,
} from "./refresh-schedule";

// Toutes les heures ci-dessous sont en UTC ; converties en heure de Paris (été, CEST, UTC+2) sauf mention contraire.

describe("getRefreshTier", () => {
  it("is 'morning' just inside 9h-15h30 (summer, CEST, UTC+2)", () => {
    expect(getRefreshTier(new Date("2026-08-13T07:00:00.000Z"))).toBe("morning"); // 9h00 Paris
    expect(getRefreshTier(new Date("2026-08-13T13:29:00.000Z"))).toBe("morning"); // 15h29 Paris
  });

  it("is 'golden' just inside 15h30-18h (summer, CEST, UTC+2)", () => {
    expect(getRefreshTier(new Date("2026-08-13T13:30:00.000Z"))).toBe("golden"); // 15h30 Paris
    expect(getRefreshTier(new Date("2026-08-13T15:59:00.000Z"))).toBe("golden"); // 17h59 Paris
  });

  it("is 'evening' just inside 18h-22h (summer, CEST, UTC+2)", () => {
    expect(getRefreshTier(new Date("2026-08-13T16:00:00.000Z"))).toBe("evening"); // 18h00 Paris
    expect(getRefreshTier(new Date("2026-08-13T19:59:00.000Z"))).toBe("evening"); // 21h59 Paris
  });

  it("is 'night' from 22h to 9h, including the exact boundaries", () => {
    expect(getRefreshTier(new Date("2026-08-13T20:00:00.000Z"))).toBe("night"); // 22h00 Paris
    expect(getRefreshTier(new Date("2026-08-13T06:59:00.000Z"))).toBe("night"); // 8h59 Paris
    expect(getRefreshTier(new Date("2026-08-13T02:00:00.000Z"))).toBe("night"); // 4h00 Paris
  });

  it("respects the winter (CET, UTC+1) offset too", () => {
    expect(getRefreshTier(new Date("2026-01-15T14:30:00.000Z"))).toBe("golden"); // 15h30 Paris
    expect(getRefreshTier(new Date("2026-01-15T17:00:00.000Z"))).toBe("evening"); // 18h00 Paris
    expect(getRefreshTier(new Date("2026-01-15T08:00:00.000Z"))).toBe("morning"); // 9h00 Paris
    expect(getRefreshTier(new Date("2026-01-15T05:00:00.000Z"))).toBe("night"); // 6h00 Paris
  });
});

describe("isMarketHours", () => {
  it("is true during morning, golden and evening, false at night", () => {
    expect(isMarketHours(new Date("2026-08-13T07:00:00.000Z"))).toBe(true);
    expect(isMarketHours(new Date("2026-08-13T13:30:00.000Z"))).toBe(true);
    expect(isMarketHours(new Date("2026-08-13T16:00:00.000Z"))).toBe(true);
    expect(isMarketHours(new Date("2026-08-13T20:00:00.000Z"))).toBe(false);
    expect(isMarketHours(new Date("2026-08-13T02:00:00.000Z"))).toBe(false);
  });
});

describe("getPollIntervalMs", () => {
  it("returns the 1-minute tier during the golden hour", () => {
    expect(getPollIntervalMs(new Date("2026-08-13T13:30:00.000Z"))).toBe(GOLDEN_INTERVAL_MS);
  });

  it("returns the 10-minute tier in the evening", () => {
    expect(getPollIntervalMs(new Date("2026-08-13T16:00:00.000Z"))).toBe(EVENING_INTERVAL_MS);
  });

  it("returns the 5-minute tier in the morning and at night", () => {
    expect(getPollIntervalMs(new Date("2026-08-13T07:00:00.000Z"))).toBe(MORNING_INTERVAL_MS);
    expect(getPollIntervalMs(new Date("2026-08-13T02:00:00.000Z"))).toBe(MORNING_INTERVAL_MS);
  });
});

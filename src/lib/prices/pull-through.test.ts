import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetType } from "@/generated/prisma/enums";
import type { Asset } from "@/generated/prisma/client";
import type { PriceProvider } from "@/lib/prices/types";
import { STOCK_PRICE_STALE_MS, CRYPTO_PRICE_STALE_MS, COINGECKO_PRICE_STALE_MS } from "@/lib/prices/staleness";

const priceFindManyMock = vi.fn();
const priceCreateMock = vi.fn();
const assetFindManyMock = vi.fn();
const getPriceProvidersMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    price: { findMany: priceFindManyMock, create: priceCreateMock },
    asset: { findMany: assetFindManyMock },
  },
}));

vi.mock("@/lib/prices", () => ({
  getPriceProviders: getPriceProvidersMock,
}));

const { refreshAssetPricesIfStale, refreshAssetPriceIfStale } = await import("./pull-through");

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    type: AssetType.STOCK,
    sector: null,
    currency: "USD",
    isActive: true,
    createdAt: new Date(),
    externalId: null,
    logoUrl: null,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<PriceProvider> = {}): PriceProvider {
  return {
    source: "test-provider",
    supports: () => true,
    fetchPrice: async () => ({ price: 100, timestamp: new Date(), source: "test-provider" }),
    ...overrides,
  };
}

beforeEach(() => {
  priceFindManyMock.mockReset();
  priceCreateMock.mockReset();
  assetFindManyMock.mockReset();
  getPriceProvidersMock.mockReset();
  // Par défaut : aucun actif figé (concours clos).
  assetFindManyMock.mockResolvedValue([]);
});

describe("refreshAssetPricesIfStale", () => {
  it("returns an empty map without querying anything when given no assets", async () => {
    const result = await refreshAssetPricesIfStale([]);

    expect(result.size).toBe(0);
    expect(priceFindManyMock).not.toHaveBeenCalled();
  });

  it("returns the existing price without calling a provider when it is fresh", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const timestamp = new Date(now.getTime() - 1000);
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 150, timestamp }]);

    const result = await refreshAssetPricesIfStale([makeAsset()], now);

    expect(getPriceProvidersMock).not.toHaveBeenCalled();
    expect(result.get("asset-1")).toEqual({ price: 150, timestamp, isStale: false });
  });

  it("never calls a provider for an asset held only in closed contests — returns its last known price", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const timestamp = new Date(now.getTime() - STOCK_PRICE_STALE_MS - 60_000); // périmé
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 100, timestamp }]);
    assetFindManyMock.mockResolvedValue([{ id: "asset-1" }]); // figé

    const result = await refreshAssetPricesIfStale([makeAsset()], now);

    expect(getPriceProvidersMock).not.toHaveBeenCalled();
    expect(priceCreateMock).not.toHaveBeenCalled();
    expect(result.get("asset-1")).toEqual({ price: 100, timestamp, isStale: false });
  });

  it("fetches and stores a fresh quote when the latest price is stale", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    priceFindManyMock.mockResolvedValue([
      { assetId: "asset-1", price: 100, timestamp: new Date(now.getTime() - STOCK_PRICE_STALE_MS - 1000) },
    ]);
    const quote = { price: 180, timestamp: now, source: "test-provider" };
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice: async () => quote })]);

    const result = await refreshAssetPricesIfStale([makeAsset()], now);

    expect(priceCreateMock).toHaveBeenCalledWith({
      data: { assetId: "asset-1", timestamp: quote.timestamp, price: quote.price, source: quote.source },
    });
    expect(result.get("asset-1")).toEqual({ price: 180, timestamp: now, isStale: false });
  });

  it("refreshes multiple assets in parallel with a single batched price lookup", async () => {
    priceFindManyMock.mockResolvedValue([]);
    getPriceProvidersMock.mockReturnValue([
      makeProvider({ fetchPrice: async (asset) => ({ price: asset.symbol === "AAPL" ? 180 : 250, timestamp: new Date(), source: "test" }) }),
    ]);

    const result = await refreshAssetPricesIfStale([
      makeAsset({ id: "asset-1", symbol: "AAPL" }),
      makeAsset({ id: "asset-2", symbol: "MSFT" }),
    ]);

    expect(priceFindManyMock).toHaveBeenCalledTimes(1);
    expect(result.get("asset-1")?.price).toBe(180);
    expect(result.get("asset-2")?.price).toBe(250);
  });

  it("falls back to the stale price marked isStale when no provider supports the asset", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const timestamp = new Date(now.getTime() - STOCK_PRICE_STALE_MS - 1000);
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 100, timestamp }]);
    getPriceProvidersMock.mockReturnValue([makeProvider({ supports: () => false })]);

    const result = await refreshAssetPricesIfStale([makeAsset()], now);

    expect(priceCreateMock).not.toHaveBeenCalled();
    expect(result.get("asset-1")).toEqual({ price: 100, timestamp, isStale: true });
  });

  it("omits the asset entirely when it has no price and no quote could be fetched", async () => {
    priceFindManyMock.mockResolvedValue([]);
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice: async () => null })]);

    const result = await refreshAssetPricesIfStale([makeAsset()]);

    expect(result.has("asset-1")).toBe(false);
  });

  it("coalesces concurrent refreshes of the same stale asset into a single provider call", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const timestamp = new Date(now.getTime() - STOCK_PRICE_STALE_MS - 1000);
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 100, timestamp }]);

    // Un léger délai (au lieu d'une résolution immédiate) laisse le temps aux deux appels
    // concurrents d'atteindre tous les deux `refreshWithDedupe` avant que le premier n'ait
    // fini — sans quoi le second arriverait toujours après coup et ne testerait rien.
    const fetchPrice = vi.fn(
      () =>
        new Promise<{ price: number; timestamp: Date; source: string }>((resolve) =>
          setTimeout(() => resolve({ price: 180, timestamp: now, source: "test-provider" }), 10),
        ),
    );
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice })]);

    // Deux appels concurrents (dashboard + classement chargés au même instant, par ex.)
    // pour le même actif périmé, avant que le premier n'ait eu le temps d'écrire son résultat.
    const [firstResult, secondResult] = await Promise.all([
      refreshAssetPricesIfStale([makeAsset()], now),
      refreshAssetPricesIfStale([makeAsset()], now),
    ]);

    expect(fetchPrice).toHaveBeenCalledTimes(1);
    expect(priceCreateMock).toHaveBeenCalledTimes(1);
    expect(firstResult.get("asset-1")).toEqual({ price: 180, timestamp: now, isStale: false });
    expect(secondResult.get("asset-1")).toEqual({ price: 180, timestamp: now, isStale: false });
  });

  it("does not coalesce refreshes of different assets", async () => {
    priceFindManyMock.mockResolvedValue([]);
    const fetchPrice = vi.fn(async (asset: { symbol: string }) => ({
      price: asset.symbol === "AAPL" ? 180 : 250,
      timestamp: new Date(),
      source: "test-provider",
    }));
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice })]);

    await Promise.all([
      refreshAssetPricesIfStale([makeAsset({ id: "asset-1", symbol: "AAPL" })]),
      refreshAssetPricesIfStale([makeAsset({ id: "asset-2", symbol: "MSFT" })]),
    ]);

    expect(fetchPrice).toHaveBeenCalledTimes(2);
  });

  it("applies the shorter crypto staleness threshold instead of the stock one", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const timestamp = new Date(now.getTime() - CRYPTO_PRICE_STALE_MS - 1000);
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 100, timestamp }]);
    const quote = { price: 105, timestamp: now, source: "test-provider" };
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice: async () => quote })]);

    // This timestamp is well within STOCK_PRICE_STALE_MS but past CRYPTO_PRICE_STALE_MS —
    // a refresh happening here proves the shorter crypto threshold was applied.
    const result = await refreshAssetPricesIfStale([makeAsset({ type: AssetType.CRYPTO })], now);

    expect(result.get("asset-1")).toEqual({ price: 105, timestamp: now, isStale: false });
  });

  it("applies the longer CoinGecko threshold to a crypto whose last price came from CoinGecko", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    // Past CRYPTO_PRICE_STALE_MS but within COINGECKO_PRICE_STALE_MS — must NOT refresh,
    // otherwise every page view would burn CoinGecko's ~30 req/min free quota.
    const timestamp = new Date(now.getTime() - CRYPTO_PRICE_STALE_MS - 1000);
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 0.14, timestamp, source: "coingecko" }]);
    const fetchPrice = vi.fn();
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice })]);

    const result = await refreshAssetPricesIfStale([makeAsset({ type: AssetType.CRYPTO })], now);

    expect(fetchPrice).not.toHaveBeenCalled();
    expect(result.get("asset-1")).toEqual({ price: 0.14, timestamp, isStale: false });

    const later = new Date(now.getTime() + COINGECKO_PRICE_STALE_MS);
    fetchPrice.mockResolvedValue({ price: 0.15, timestamp: later, source: "coingecko" });
    await refreshAssetPricesIfStale([makeAsset({ type: AssetType.CRYPTO })], later);
    expect(fetchPrice).toHaveBeenCalledTimes(1);
  });
});

describe("refreshAssetPriceIfStale", () => {
  it("delegates to the batched refresh for a single asset", async () => {
    priceFindManyMock.mockResolvedValue([]);
    const quote = { price: 42, timestamp: new Date(), source: "test-provider" };
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice: async () => quote })]);

    await refreshAssetPriceIfStale(makeAsset());

    expect(priceCreateMock).toHaveBeenCalled();
  });

  it("forces a refresh for the purchase target even when it is only held in closed contests", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const timestamp = new Date(now.getTime() - STOCK_PRICE_STALE_MS - 60_000); // périmé
    priceFindManyMock.mockResolvedValue([{ assetId: "asset-1", price: 100, timestamp }]);
    assetFindManyMock.mockResolvedValue([{ id: "asset-1" }]); // figé (concours clos)
    const quote = { price: 175, timestamp: now, source: "test-provider" };
    getPriceProvidersMock.mockReturnValue([makeProvider({ fetchPrice: async () => quote })]);

    await refreshAssetPriceIfStale(makeAsset(), now);

    expect(priceCreateMock).toHaveBeenCalledWith({
      data: { assetId: "asset-1", timestamp: now, price: 175, source: "test-provider" },
    });
  });
});

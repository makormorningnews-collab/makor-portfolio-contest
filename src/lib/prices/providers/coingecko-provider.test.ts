import { describe, it, expect } from "vitest";
import { parseCoinGeckoSimplePrice } from "./coingecko-provider";

describe("parseCoinGeckoSimplePrice", () => {
  it("extrait le cours de la réponse simple/price (cas réel : FARTCOIN, absent de Binance spot)", () => {
    expect(parseCoinGeckoSimplePrice({ fartcoin: { eur: 0.139417 } }, "fartcoin", "eur")).toBe(0.139417);
  });

  it("renvoie null si la crypto ou la devise est absente de la réponse", () => {
    expect(parseCoinGeckoSimplePrice({}, "fartcoin", "eur")).toBeNull();
    expect(parseCoinGeckoSimplePrice({ fartcoin: { usd: 0.16 } }, "fartcoin", "eur")).toBeNull();
  });

  it("renvoie null pour une réponse inattendue", () => {
    expect(parseCoinGeckoSimplePrice(null, "fartcoin", "eur")).toBeNull();
    expect(parseCoinGeckoSimplePrice({ fartcoin: { eur: "0.13" } }, "fartcoin", "eur")).toBeNull();
  });
});

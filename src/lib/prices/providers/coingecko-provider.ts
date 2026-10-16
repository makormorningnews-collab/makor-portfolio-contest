import { AssetType } from "@/generated/prisma/enums";
import type { Asset } from "@/generated/prisma/client";
import type { FetchedPrice, HistoryPoint, HistoryRequest, PriceProvider } from "@/lib/prices/types";

type AssetForCoinGecko = Pick<Asset, "symbol" | "currency" | "externalId">;

/** Identifiant CoinGecko de l'actif (ex. "fartcoin"), renseigné par la recherche — à défaut, le ticker en minuscules. */
function coinIdOf(asset: AssetForCoinGecko): string {
  return asset.externalId ?? asset.symbol.toLowerCase();
}

/** Extrait le cours de la réponse `simple/price` — pure, donc testable sans mock réseau. */
export function parseCoinGeckoSimplePrice(body: unknown, coinId: string, vsCurrency: string): number | null {
  if (!body || typeof body !== "object") return null;
  const price = (body as Record<string, Record<string, unknown> | undefined>)[coinId]?.[vsCurrency];
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

/**
 * CoinGecko, API publique sans clé — fournisseur de prix crypto de SECOURS,
 * placé après Binance dans src/lib/prices/index.ts. La recherche de tickers
 * crypto passe par CoinGecko (src/lib/assets/search-providers.ts) et propose
 * donc des cryptos que Binance spot ne cote pas du tout (ex. FARTCOIN : toutes
 * les paires FARTCOIN* répondent "Invalid symbol") — sans ce secours, ces
 * actifs apparaissaient dans la recherche mais l'achat échouait faute de
 * cotation. Le quota gratuit étant limité (~30 req/min), les prix issus de
 * cette source ont un seuil de péremption plus long (voir staleness.ts).
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly source = "coingecko";

  supports(asset: Pick<Asset, "type">): boolean {
    return asset.type === AssetType.CRYPTO;
  }

  async fetchPrice(asset: AssetForCoinGecko): Promise<FetchedPrice | null> {
    const coinId = coinIdOf(asset);
    const vsCurrency = asset.currency.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=${encodeURIComponent(vsCurrency)}`;

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      console.error(`[ingest:coingecko] ${coinId}: HTTP ${response.status} — ${await response.text()}`);
      return null;
    }

    const price = parseCoinGeckoSimplePrice(await response.json(), coinId, vsCurrency);
    if (price == null) return null;
    return { price, timestamp: new Date(), source: this.source };
  }

  /** https://docs.coingecko.com/reference/coins-id-market-chart — granularité auto selon `days` côté API publique. */
  async fetchHistory(asset: AssetForCoinGecko, request: HistoryRequest): Promise<HistoryPoint[] | null> {
    const coinId = coinIdOf(asset);
    const vsCurrency = asset.currency.toLowerCase();
    const days = Math.max(1, Math.ceil(request.days));
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=${encodeURIComponent(vsCurrency)}&days=${days}`;

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;

    const body = (await response.json()) as { prices?: [number, number][] };
    if (!Array.isArray(body.prices)) return null;

    return body.prices
      .map(([ms, price]) => ({ timestamp: new Date(ms), price }))
      .filter((point) => Number.isFinite(point.price))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}

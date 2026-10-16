import "server-only";
import { BinanceProvider } from "@/lib/prices/providers/binance-provider";
import { CoinGeckoProvider } from "@/lib/prices/providers/coingecko-provider";
import { TwelveDataProvider } from "@/lib/prices/providers/twelve-data-provider";
import { YahooProvider } from "@/lib/prices/providers/yahoo-provider";
import { TradingViewProvider } from "@/lib/prices/providers/tradingview-provider";
import { MockPriceProvider } from "@/lib/prices/providers/mock-provider";
import type { PriceProvider } from "@/lib/prices/types";

/**
 * Order matters: callers try each supporting provider in turn until one
 * succeeds (see provider-fallback.ts), not just the first match. For
 * stocks, Yahoo goes first (primary — see yahoo-provider.ts for why Twelve
 * Data can't hold that role), then TradingView and Twelve Data as
 * exchange-suffix-shaped fallbacks: TradingView.supports() only matches
 * dotted (mostly European) symbols, TwelveData.supports() only matches
 * non-dotted (US-shaped) ones, so the two never compete for the same asset —
 * order between them doesn't matter for correctness, only for reading order.
 * For crypto, Binance goes first (near real-time, no quota) and CoinGecko
 * covers coins Binance spot doesn't list (see coingecko-provider.ts).
 * Add a new source by pushing another provider here in the right position —
 * nothing else needs to change.
 */
export function getPriceProviders(): PriceProvider[] {
  const providers: PriceProvider[] = [
    new BinanceProvider(),
    new CoinGeckoProvider(),
    new YahooProvider(),
    new TradingViewProvider(),
  ];

  if (process.env.TWELVE_DATA_API_KEY) {
    providers.push(new TwelveDataProvider(process.env.TWELVE_DATA_API_KEY));
  } else {
    // No real stock provider configured yet — fall back to the mock so
    // the ingestion pipeline and downstream features stay testable locally.
    providers.push(new MockPriceProvider());
  }

  return providers;
}

import "server-only";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import {
  getRefreshTier,
  MORNING_INTERVAL_MS,
  GOLDEN_INTERVAL_MS,
  EVENING_INTERVAL_MS,
  NIGHT_REVALIDATE_MS,
} from "@/lib/refresh-schedule";
import { buildTrades } from "./match-closing-trades";

export interface PersonalRecords {
  bestDayPct: number | null;
  /** ISO — jamais un `Date` brut : ce type traverse unstable_cache (voir getCachedPersonalRecords
   * plus bas), qui sérialise/désérialise la valeur et ne préserve pas les instances Date. */
  bestDayDate: string | null;
  bestTradePct: number | null;
  bestTradeAssetSymbol: string | null;
  longestHoldDays: number | null;
  longestHoldAssetSymbol: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Records personnels — meilleure journée, meilleur trade, plus longue détention. Dérivé des
 * mêmes primitives que get-participant-stats.ts (buildTrades) ; fichier séparé pour ne pas
 * mélanger avec les stats déjà consommées par /statistiques. */
export async function getPersonalRecords(portfolioId: string): Promise<PersonalRecords> {
  const [bestDaySnapshot, positions, transactions] = await Promise.all([
    db.performanceSnapshot.findFirst({ where: { portfolioId }, orderBy: { dailyReturnPct: "desc" } }),
    db.position.findMany({
      where: { portfolioId },
      include: { asset: { select: { symbol: true, prices: { orderBy: { timestamp: "desc" }, take: 1 } } } },
    }),
    db.transaction.findMany({
      where: { portfolioId },
      select: { assetId: true, type: true, price: true, quantity: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const currentPriceByAsset = new Map(
    positions.map((position) => [position.assetId, Number(position.asset.prices[0]?.price ?? position.avgEntryPrice)]),
  );
  const trades = buildTrades(
    positions.map((position) => ({
      id: position.id,
      assetId: position.assetId,
      avgEntryPrice: Number(position.avgEntryPrice),
      quantity: Number(position.quantity),
      openedAt: position.openedAt,
      closedAt: position.closedAt,
    })),
    transactions.map((t) => ({
      assetId: t.assetId,
      type: t.type,
      price: Number(t.price),
      quantity: Number(t.quantity),
      createdAt: t.createdAt,
    })),
    currentPriceByAsset,
  );

  const symbolByAssetId = new Map(positions.map((position) => [position.assetId, position.asset.symbol]));
  const bestTrade = trades.reduce<(typeof trades)[number] | null>(
    (best, trade) => (!best || trade.pnlPct > best.pnlPct ? trade : best),
    null,
  );

  const now = new Date();
  const longestHold = positions.reduce<{ symbol: string; days: number } | null>((best, position) => {
    const days = ((position.closedAt ?? now).getTime() - position.openedAt.getTime()) / DAY_MS;
    if (!best || days > best.days) return { symbol: position.asset.symbol, days };
    return best;
  }, null);

  return {
    bestDayPct: bestDaySnapshot ? Number(bestDaySnapshot.dailyReturnPct) : null,
    bestDayDate: bestDaySnapshot ? bestDaySnapshot.timestamp.toISOString() : null,
    bestTradePct: bestTrade?.pnlPct ?? null,
    bestTradeAssetSymbol: bestTrade ? (symbolByAssetId.get(bestTrade.assetId) ?? null) : null,
    longestHoldDays: longestHold ? Math.round(longestHold.days) : null,
    longestHoldAssetSymbol: longestHold?.symbol ?? null,
  };
}

/**
 * Variante mise en cache — voir {@link getCachedLeaderboard} pour le raisonnement.
 *
 * Clé "-v2" (pas juste "personal-records") : `unstable_cache` persiste ses entrées
 * à travers les déploiements, et sa clé de cache dépend du texte source de CETTE
 * fonction wrapper, pas du code interne de `getPersonalRecords` qu'elle appelle —
 * changer `bestDayDate` de `Date` à `string` n'a donc pas invalidé les entrées déjà
 * en cache. Le suffixe de version force une clé neuve, garantissant une génération
 * fraîche avec le code corrigé dès la prochaine requête plutôt que d'attendre les
 * 15 minutes de `revalidate`. Réutiliser ce réflexe (bump de version) à chaque futur
 * changement de la forme des données retournées par une fonction déjà en cache.
 */
const getCachedPersonalRecordsMorning = unstable_cache(
  (portfolioId: string) => getPersonalRecords(portfolioId),
  ["personal-records-v2", "morning"],
  { revalidate: MORNING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPersonalRecordsGolden = unstable_cache(
  (portfolioId: string) => getPersonalRecords(portfolioId),
  ["personal-records-v2", "golden"],
  { revalidate: GOLDEN_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPersonalRecordsEvening = unstable_cache(
  (portfolioId: string) => getPersonalRecords(portfolioId),
  ["personal-records-v2", "evening"],
  { revalidate: EVENING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPersonalRecordsNight = unstable_cache(
  (portfolioId: string) => getPersonalRecords(portfolioId),
  ["personal-records-v2", "night"],
  { revalidate: NIGHT_REVALIDATE_MS / 1000, tags: ["portfolio-view"] },
);
export function getCachedPersonalRecords(portfolioId: string): Promise<PersonalRecords> {
  const tier = getRefreshTier();
  if (tier === "golden") return getCachedPersonalRecordsGolden(portfolioId);
  if (tier === "evening") return getCachedPersonalRecordsEvening(portfolioId);
  if (tier === "morning") return getCachedPersonalRecordsMorning(portfolioId);
  return getCachedPersonalRecordsNight(portfolioId);
}

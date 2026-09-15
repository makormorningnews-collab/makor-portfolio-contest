import "server-only";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { getCachedPromotionValuation } from "@/lib/trading/promotion-valuation";
import {
  getRefreshTier,
  MORNING_INTERVAL_MS,
  GOLDEN_INTERVAL_MS,
  EVENING_INTERVAL_MS,
  NIGHT_REVALIDATE_MS,
} from "@/lib/refresh-schedule";
import { buildTrades } from "./match-closing-trades";
import type { LeaderboardRow } from "./get-leaderboard";

export interface AllocationSlice {
  key: string;
  valuePct: number;
}

export interface AssetLeader {
  symbol: string;
  name: string;
  participantCount: number;
  totalValueEur: number;
}

export interface AssetPerformance {
  symbol: string;
  name: string;
  avgPnlPct: number;
}

export interface BestTrade {
  participantName: string;
  symbol: string;
  pnlEur: number;
  pnlPct: number;
}

export interface RankMove {
  participantName: string;
  rankChange: number;
}

export interface BestWeeklyReturn {
  participantName: string;
  weeklyReturnPct: number;
}

export interface BestContestDay {
  participantName: string;
  date: string;
  dailyReturnPct: number;
}

export interface ContestStats {
  mostHeldAsset: AssetLeader | null;
  bestPerformingAsset: AssetPerformance | null;
  worstPerformingAsset: AssetPerformance | null;
  sectorAllocation: AllocationSlice[];
  assetClassAllocation: AllocationSlice[];
  bestTrade: BestTrade | null;
  biggestRankGain: RankMove | null;
  biggestRankDrop: RankMove | null;
  bestWeeklyReturn: BestWeeklyReturn | null;
  bestContestDay: BestContestDay | null;
  totalTransactionCount: number;
}

function buildAllocation(entries: { key: string; value: number }[]): AllocationSlice[] {
  const totalValue = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (totalValue <= 0) return [];

  const byKey = new Map<string, number>();
  for (const entry of entries) byKey.set(entry.key, (byKey.get(entry.key) ?? 0) + entry.value);

  return [...byKey.entries()]
    .map(([key, value]) => ({ key, valuePct: (value / totalValue) * 100 }))
    .sort((a, b) => b.valuePct - a.valuePct);
}

function pickRankMove(rows: LeaderboardRow[], comparator: (a: number, b: number) => number): RankMove | null {
  const withMovement = rows.filter((row) => row.rankChange !== 0);
  if (withMovement.length === 0) return null;
  const best = withMovement.reduce((champion, row) => (comparator(row.rankChange, champion.rankChange) > 0 ? row : champion));
  return { participantName: best.name, rankChange: best.rankChange };
}

/**
 * Statistiques globales du concours, calculées à partir du classement déjà
 * calculé (`getLeaderboard`, passé en paramètre) plus des requêtes dédiées
 * pour ce qu'il ne fournit pas (répartition, meilleur actif, meilleur trade,
 * meilleure journée).
 */
export async function getContestStats(promotionId: string, leaderboard: LeaderboardRow[]): Promise<ContestStats> {
  const portfolios = await db.portfolio.findMany({
    where: { promotionId },
    include: {
      user: { select: { name: true } },
      positions: { include: { asset: { include: { prices: { orderBy: { timestamp: "desc" }, take: 1 } } } } },
      transactions: { select: { assetId: true, type: true, price: true, quantity: true, createdAt: true } },
      snapshots: { select: { timestamp: true, dailyReturnPct: true } },
    },
  });

  const allOpenPositions = portfolios.flatMap((portfolio) =>
    portfolio.positions
      .filter((position) => Number(position.quantity) > 0 && position.closedAt === null)
      .map((position) => ({ ...position, participantName: portfolio.user.name })),
  );
  // Cours courants : valorisation partagée de la promotion (même source que le
  // classement, le tableau de bord et les stats participant) — une seule
  // résolution de prix, cohérente entre tous les onglets.
  const valuation = await getCachedPromotionValuation(promotionId);
  const currentPricesByAsset = new Map(
    allOpenPositions.map((position) => [
      position.assetId,
      valuation.pricesByAsset[position.assetId] ?? Number(position.asset.prices[0]?.price ?? 0),
    ]),
  );

  // --- actif le plus détenu + performance moyenne pondérée par actif -------
  const byAsset = new Map<
    string,
    { symbol: string; name: string; participants: Set<string>; totalValueEur: number; weightedPnlPct: number }
  >();
  for (const position of allOpenPositions) {
    const currentPrice = currentPricesByAsset.get(position.assetId) ?? Number(position.avgEntryPrice);
    const value = currentPrice * Number(position.quantity);
    const avgEntryPrice = Number(position.avgEntryPrice);
    const pnlPct = avgEntryPrice > 0 ? ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100 : 0;

    const entry = byAsset.get(position.assetId) ?? {
      symbol: position.asset.symbol,
      name: position.asset.name,
      participants: new Set<string>(),
      totalValueEur: 0,
      weightedPnlPct: 0,
    };
    entry.participants.add(position.participantName);
    entry.totalValueEur += value;
    entry.weightedPnlPct += pnlPct * value;
    byAsset.set(position.assetId, entry);
  }

  const assetSummaries = [...byAsset.values()].map((entry) => ({
    symbol: entry.symbol,
    name: entry.name,
    participantCount: entry.participants.size,
    totalValueEur: entry.totalValueEur,
    avgPnlPct: entry.totalValueEur > 0 ? entry.weightedPnlPct / entry.totalValueEur : 0,
  }));

  const mostHeldAsset =
    assetSummaries.length > 0
      ? [...assetSummaries].sort(
          (a, b) => b.participantCount - a.participantCount || b.totalValueEur - a.totalValueEur,
        )[0]
      : null;
  const bestPerformingAsset =
    assetSummaries.length > 0 ? [...assetSummaries].sort((a, b) => b.avgPnlPct - a.avgPnlPct)[0] : null;
  const worstPerformingAsset =
    assetSummaries.length > 0 ? [...assetSummaries].sort((a, b) => a.avgPnlPct - b.avgPnlPct)[0] : null;

  // --- répartitions ---------------------------------------------------------
  const sectorAllocation = buildAllocation(
    allOpenPositions.map((position) => ({
      key: position.asset.sector ?? "Non renseigné",
      value: (currentPricesByAsset.get(position.assetId) ?? 0) * Number(position.quantity),
    })),
  );
  const assetClassAllocation = buildAllocation(
    allOpenPositions.map((position) => ({
      key: position.asset.type,
      value: (currentPricesByAsset.get(position.assetId) ?? 0) * Number(position.quantity),
    })),
  );

  // --- meilleure transaction de tout le concours ----------------------------
  let bestTrade: BestTrade | null = null;
  let totalTransactionCount = 0;
  for (const portfolio of portfolios) {
    totalTransactionCount += portfolio.transactions.length;
    const portfolioPricesByAsset = new Map(
      portfolio.positions.map((position) => [
        position.assetId,
        currentPricesByAsset.get(position.assetId) ?? Number(position.avgEntryPrice),
      ]),
    );
    const trades = buildTrades(
      portfolio.positions.map((position) => ({
        id: position.id,
        assetId: position.assetId,
        avgEntryPrice: Number(position.avgEntryPrice),
        quantity: Number(position.quantity),
        openedAt: position.openedAt,
        closedAt: position.closedAt,
      })),
      portfolio.transactions.map((transaction) => ({
        assetId: transaction.assetId,
        type: transaction.type,
        price: Number(transaction.price),
        quantity: Number(transaction.quantity),
        createdAt: transaction.createdAt,
      })),
      portfolioPricesByAsset,
    );
    for (const trade of trades) {
      if (!bestTrade || trade.pnlEur > bestTrade.pnlEur) {
        const asset = portfolio.positions.find((position) => position.assetId === trade.assetId)?.asset;
        bestTrade = {
          participantName: portfolio.user.name,
          symbol: asset?.symbol ?? "?",
          pnlEur: trade.pnlEur,
          pnlPct: trade.pnlPct,
        };
      }
    }
  }

  // --- meilleure journée du concours -----------------------------------------
  let bestContestDay: BestContestDay | null = null;
  for (const portfolio of portfolios) {
    for (const snapshot of portfolio.snapshots) {
      const dailyReturnPct = Number(snapshot.dailyReturnPct);
      if (!bestContestDay || dailyReturnPct > bestContestDay.dailyReturnPct) {
        bestContestDay = {
          participantName: portfolio.user.name,
          date: snapshot.timestamp.toISOString().slice(0, 10),
          dailyReturnPct,
        };
      }
    }
  }

  return {
    mostHeldAsset,
    bestPerformingAsset,
    worstPerformingAsset,
    sectorAllocation,
    assetClassAllocation,
    bestTrade,
    biggestRankGain: pickRankMove(leaderboard, (a, b) => a - b),
    biggestRankDrop: pickRankMove(leaderboard, (a, b) => b - a),
    bestWeeklyReturn:
      leaderboard
        .filter((row) => row.weeklyReturnPct !== null)
        .sort((a, b) => b.weeklyReturnPct! - a.weeklyReturnPct!)
        .map((row) => ({ participantName: row.name, weeklyReturnPct: row.weeklyReturnPct! }))[0] ?? null,
    bestContestDay,
    totalTransactionCount,
  };
}

/** Variante mise en cache — voir {@link getCachedLeaderboard} pour le raisonnement (même pattern
 * à quatre variantes matin/golden/soir/nuit selon l'heure). */
const getCachedContestStatsMorning = unstable_cache(
  (promotionId: string, leaderboard: LeaderboardRow[]) => getContestStats(promotionId, leaderboard),
  ["contest-stats", "morning"],
  { revalidate: MORNING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedContestStatsGolden = unstable_cache(
  (promotionId: string, leaderboard: LeaderboardRow[]) => getContestStats(promotionId, leaderboard),
  ["contest-stats", "golden"],
  { revalidate: GOLDEN_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedContestStatsEvening = unstable_cache(
  (promotionId: string, leaderboard: LeaderboardRow[]) => getContestStats(promotionId, leaderboard),
  ["contest-stats", "evening"],
  { revalidate: EVENING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedContestStatsNight = unstable_cache(
  (promotionId: string, leaderboard: LeaderboardRow[]) => getContestStats(promotionId, leaderboard),
  ["contest-stats", "night"],
  { revalidate: NIGHT_REVALIDATE_MS / 1000, tags: ["portfolio-view"] },
);
export function getCachedContestStats(promotionId: string, leaderboard: LeaderboardRow[]): Promise<ContestStats> {
  const tier = getRefreshTier();
  if (tier === "golden") return getCachedContestStatsGolden(promotionId, leaderboard);
  if (tier === "evening") return getCachedContestStatsEvening(promotionId, leaderboard);
  if (tier === "morning") return getCachedContestStatsMorning(promotionId, leaderboard);
  return getCachedContestStatsNight(promotionId, leaderboard);
}

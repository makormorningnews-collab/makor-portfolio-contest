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
import {
  getCachedPromotionValuation,
  getPromotionValuation,
  type ValuedPosition,
} from "@/lib/trading/promotion-valuation";
import { rankEntries, computeRankChange } from "./ranking";

export interface BestWorstPosition {
  symbol: string;
  name: string;
  pnlPct: number;
}

export interface LeaderboardRow {
  userId: string;
  name: string;
  avatarUrl: string | null;
  portfolioId: string;
  totalValue: number;
  cumulativeReturnPct: number;
  rank: number;
  previousRank: number | null;
  /** Évolution du rang depuis la veille (positif = progression). */
  rankChange: number;
  /** Rendement sur les 7 derniers jours, ou null si l'historique est trop court. */
  weeklyReturnPct: number | null;
  bestPosition: BestWorstPosition | null;
  worstPosition: BestWorstPosition | null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

function pickBestWorst(positions: ValuedPosition[]): { best: BestWorstPosition | null; worst: BestWorstPosition | null } {
  if (positions.length === 0) return { best: null, worst: null };
  const sorted = [...positions].sort((a, b) => b.pnlPct - a.pnlPct);
  const toBestWorst = (position: ValuedPosition): BestWorstPosition => ({
    symbol: position.symbol,
    name: position.name,
    pnlPct: position.pnlPct,
  });
  return { best: toBestWorst(sorted[0]), worst: toBestWorst(sorted[sorted.length - 1]) };
}

export async function getLeaderboard(
  promotionId: string,
  now: Date = new Date(),
  { frozen = false }: { frozen?: boolean } = {},
): Promise<LeaderboardRow[]> {
  // Valeur de chaque portefeuille : lue dans la valorisation partagée de la
  // promotion (un seul rafraîchissement de prix, un seul cache) — c'est la même
  // source que `getPortfolioView` (tableau de bord) et les statistiques, donc
  // classement et portefeuille affichent le même euro.
  const valuation = frozen
    ? await getPromotionValuation(promotionId, now, { frozen: true })
    : await getCachedPromotionValuation(promotionId);
  const initialCapital = valuation.initialCapital;

  const portfolios = await db.portfolio.findMany({
    where: { promotionId },
    include: { user: { select: { id: true, name: true } } },
  });

  const yesterday = new Date(now.getTime() - ONE_DAY_MS);
  const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);

  const historyByPortfolio = await Promise.all(
    portfolios.map(async (portfolio) => {
      const [dayAgo, weekAgo] = await Promise.all([
        db.performanceSnapshot.findFirst({
          where: { portfolioId: portfolio.id, timestamp: { lte: yesterday } },
          orderBy: { timestamp: "desc" },
        }),
        db.performanceSnapshot.findFirst({
          where: { portfolioId: portfolio.id, timestamp: { lte: sevenDaysAgo } },
          orderBy: { timestamp: "desc" },
        }),
      ]);
      return [portfolio.id, { dayAgo, weekAgo }] as const;
    }),
  ).then((entries) => new Map(entries));

  const currentEntries = portfolios.map((portfolio) => {
    const valued = valuation.byPortfolio[portfolio.id];
    return {
      portfolioId: portfolio.id,
      totalValue: valued?.totalValue ?? initialCapital,
      cumulativeReturnPct: valued?.cumulativeReturnPct ?? 0,
    };
  });

  const previousDayEntries = portfolios
    .map((portfolio) => ({ portfolio, dayAgo: historyByPortfolio.get(portfolio.id)!.dayAgo }))
    .filter(({ dayAgo }) => dayAgo !== null)
    .map(({ portfolio, dayAgo }) => ({
      portfolioId: portfolio.id,
      cumulativeReturnPct: Number(dayAgo!.cumulativeReturnPct),
    }));

  const rankedCurrent = rankEntries(currentEntries);
  const rankedPreviousDay = rankEntries(previousDayEntries);
  const previousRankByPortfolio = new Map(rankedPreviousDay.map((entry) => [entry.portfolioId, entry.rank]));

  // Photo de profil (data URL base64, ~15 Ko) de TOUS les participants, pas
  // seulement le podium. Le repli podium-only datait de l'incident egress
  // Supabase du 2026-08 (retransmettre ~30 photos à chaque tick AutoRefresh) —
  // c'est désormais le cache serveur partagé `unstable_cache`
  // (getCachedLeaderboard) qui plafonne l'egress : une seule lecture par fenêtre
  // de revalidation, quel que soit le nombre de ticks. Le repli faisait
  // disparaître la photo d'un participant dès qu'il sortait du top 3 — un
  // classement serré la faisait clignoter à chaque rafraîchissement.
  // ponytail: surcoût de payload négligeable pour une cohorte de stagiaires
  // (~30) ; repasser à une miniature dédiée si les promos atteignent plusieurs
  // centaines de participants.
  const avatars = await db.user.findMany({
    where: { id: { in: portfolios.map((portfolio) => portfolio.user.id) } },
    select: { id: true, avatarUrl: true },
  });
  const avatarByUserId = new Map(avatars.map((user) => [user.id, user.avatarUrl]));

  return rankedCurrent
    .map((entry) => {
      const portfolio = portfolios.find((candidate) => candidate.id === entry.portfolioId)!;
      const { weekAgo } = historyByPortfolio.get(entry.portfolioId)!;
      const previousRank = previousRankByPortfolio.get(entry.portfolioId) ?? null;
      const weekAgoValue = weekAgo ? Number(weekAgo.totalValue) : null;
      const weeklyReturnPct =
        weekAgoValue && weekAgoValue !== 0 ? ((entry.totalValue - weekAgoValue) / weekAgoValue) * 100 : null;
      const { best, worst } = pickBestWorst(valuation.byPortfolio[entry.portfolioId]?.positions ?? []);

      return {
        userId: portfolio.user.id,
        name: portfolio.user.name,
        avatarUrl: avatarByUserId.get(portfolio.user.id) ?? null,
        portfolioId: portfolio.id,
        totalValue: entry.totalValue,
        cumulativeReturnPct: entry.cumulativeReturnPct,
        rank: entry.rank,
        previousRank,
        rankChange: computeRankChange(entry.rank, previousRank),
        weeklyReturnPct,
        bestPosition: best,
        worstPosition: worst,
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Variante mise en cache de {@link getLeaderboard}, à utiliser dans les pages
 * plutôt que la fonction brute — un rafraîchissement manuel (F5) ou une
 * navigation ne passent pas par `AutoRefresh` et n'étaient donc pas couverts
 * par l'intervalle de poll : sans ce cache serveur partagé, chaque
 * chargement de page, quel qu'en soit le déclencheur, ré-exécutait toutes
 * les requêtes Supabase. `unstable_cache` mutualise le résultat entre tous
 * les participants et toutes les requêtes pendant `revalidate` secondes,
 * donc même un utilisateur qui spam le rafraîchissement ne génère plus
 * qu'une requête réelle par fenêtre, peu importe le nombre de rechargements.
 *
 * Quatre variantes (matin/golden/soir/nuit, voir refresh-schedule.ts) plutôt
 * qu'une seule : `revalidate` est figé à la définition d'`unstable_cache`,
 * impossible à calculer dynamiquement à l'appel — `getCachedLeaderboard`
 * choisit entre les quatre selon l'heure. Même tag sur les quatre :
 * `updateTag("leaderboard")` (voir profil/actions.ts) invalide la variante
 * active quelle qu'elle soit.
 */
const getCachedLeaderboardMorning = unstable_cache(
  (promotionId: string) => getLeaderboard(promotionId),
  ["leaderboard", "morning"],
  { revalidate: MORNING_INTERVAL_MS / 1000, tags: ["leaderboard"] },
);
const getCachedLeaderboardGolden = unstable_cache(
  (promotionId: string) => getLeaderboard(promotionId),
  ["leaderboard", "golden"],
  { revalidate: GOLDEN_INTERVAL_MS / 1000, tags: ["leaderboard"] },
);
const getCachedLeaderboardEvening = unstable_cache(
  (promotionId: string) => getLeaderboard(promotionId),
  ["leaderboard", "evening"],
  { revalidate: EVENING_INTERVAL_MS / 1000, tags: ["leaderboard"] },
);
const getCachedLeaderboardNight = unstable_cache(
  (promotionId: string) => getLeaderboard(promotionId),
  ["leaderboard", "night"],
  { revalidate: NIGHT_REVALIDATE_MS / 1000, tags: ["leaderboard"] },
);
export function getCachedLeaderboard(promotionId: string): Promise<LeaderboardRow[]> {
  const tier = getRefreshTier();
  if (tier === "golden") return getCachedLeaderboardGolden(promotionId);
  if (tier === "evening") return getCachedLeaderboardEvening(promotionId);
  if (tier === "morning") return getCachedLeaderboardMorning(promotionId);
  return getCachedLeaderboardNight(promotionId);
}

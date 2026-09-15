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

export interface ParticipantSnapshotMetrics {
  totalValue: number;
  cumulativeReturnPct: number;
  dailyReturnPct: number;
}

export interface PromotionPerformancePoint {
  /** Clé de fusion triable (YYYY-MM-DD), pas affichée telle quelle. */
  date: string;
  /** Libellé affiché sur le graphique. */
  label: string;
  /** Métriques par nom de participant à cette date — absent si le participant n'a pas d'instantané ce jour-là. */
  values: Record<string, ParticipantSnapshotMetrics>;
}

export interface PromotionPerformanceSeries {
  points: PromotionPerformancePoint[];
  participantNames: string[];
}

/**
 * Évolution de tous les participants (valeur, rendement cumulé, rendement
 * journalier) pour le graphique comparatif du classement — le rang au fil du
 * temps est dérivé côté client à partir de cumulativeReturnPct, puisqu'il
 * dépend de la sélection complète des participants à chaque date.
 */
export async function getPromotionPerformanceSeries(promotionId: string): Promise<PromotionPerformanceSeries> {
  const portfolios = await db.portfolio.findMany({
    where: { promotionId },
    include: {
      user: { select: { name: true } },
      snapshots: { orderBy: { timestamp: "asc" } },
    },
  });

  const pointsByDate = new Map<string, PromotionPerformancePoint>();

  for (const portfolio of portfolios) {
    for (const snapshot of portfolio.snapshots) {
      const dateKey = snapshot.timestamp.toISOString().slice(0, 10);
      const point = pointsByDate.get(dateKey) ?? {
        date: dateKey,
        label: snapshot.timestamp.toLocaleDateString("fr-FR"),
        values: {},
      };
      point.values[portfolio.user.name] = {
        totalValue: Number(snapshot.totalValue),
        cumulativeReturnPct: Number(snapshot.cumulativeReturnPct),
        dailyReturnPct: Number(snapshot.dailyReturnPct),
      };
      pointsByDate.set(dateKey, point);
    }
  }

  const points = Array.from(pointsByDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    points,
    participantNames: portfolios.map((portfolio) => portfolio.user.name),
  };
}

/** Variante mise en cache — voir {@link getCachedLeaderboard} pour le raisonnement (même page,
 * même problème, même pattern à quatre variantes matin/golden/soir/nuit selon l'heure). */
const getCachedPromotionPerformanceSeriesMorning = unstable_cache(
  (promotionId: string) => getPromotionPerformanceSeries(promotionId),
  ["promotion-performance-series", "morning"],
  { revalidate: MORNING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPromotionPerformanceSeriesGolden = unstable_cache(
  (promotionId: string) => getPromotionPerformanceSeries(promotionId),
  ["promotion-performance-series", "golden"],
  { revalidate: GOLDEN_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPromotionPerformanceSeriesEvening = unstable_cache(
  (promotionId: string) => getPromotionPerformanceSeries(promotionId),
  ["promotion-performance-series", "evening"],
  { revalidate: EVENING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPromotionPerformanceSeriesNight = unstable_cache(
  (promotionId: string) => getPromotionPerformanceSeries(promotionId),
  ["promotion-performance-series", "night"],
  { revalidate: NIGHT_REVALIDATE_MS / 1000, tags: ["portfolio-view"] },
);
export function getCachedPromotionPerformanceSeries(promotionId: string): Promise<PromotionPerformanceSeries> {
  const tier = getRefreshTier();
  if (tier === "golden") return getCachedPromotionPerformanceSeriesGolden(promotionId);
  if (tier === "evening") return getCachedPromotionPerformanceSeriesEvening(promotionId);
  if (tier === "morning") return getCachedPromotionPerformanceSeriesMorning(promotionId);
  return getCachedPromotionPerformanceSeriesNight(promotionId);
}

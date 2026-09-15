import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";

const participantSnapshotMetricsSchema = z.object({
  totalValue: z.number(),
  cumulativeReturnPct: z.number(),
  dailyReturnPct: z.number(),
});

const performancePointSchema = z.object({
  date: z.string(),
  label: z.string(),
  values: z.record(z.string(), participantSnapshotMetricsSchema),
});

const finalChartSnapshotSchema = z.object({
  points: z.array(performancePointSchema),
  participantNames: z.array(z.string()),
  participantAvatars: z.record(z.string(), z.string().nullable()),
});

export type FinalChartSnapshot = z.infer<typeof finalChartSnapshotSchema>;

/**
 * Snapshot figé du graphique comparatif d'une promotion clôturée — écrit une seule fois par
 * finalizePromotionClosure (src/lib/promotion-lifecycle.ts). `null` si la promotion n'est pas
 * encore clôturée, ou a été clôturée avant l'introduction de ce champ et jamais rattrapée (voir
 * scripts/backfill-final-chart-snapshot.ts).
 */
export async function getFinalChartSnapshot(promotionId: string): Promise<FinalChartSnapshot | null> {
  const promotion = await db.promotion.findUnique({
    where: { id: promotionId },
    select: { finalChartSnapshot: true },
  });
  if (!promotion?.finalChartSnapshot) return null;
  return finalChartSnapshotSchema.parse(promotion.finalChartSnapshot);
}

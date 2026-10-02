"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { promotionRulesSchema } from "@/lib/promotion-rules";
import { provisionPortfolios } from "@/lib/portfolio-provisioning";
import { ensureInitializationWindow } from "@/lib/initialization-window";
import { finalizePromotionClosure, reopenPromotion as reopenPromotionLifecycle } from "@/lib/promotion-lifecycle";
import { PromotionStatus } from "@/generated/prisma/enums";
import { createPromotionSchema, updatePromotionBasicsSchema } from "./schema";

export interface PromotionFormState {
  error?: string;
}

export async function createPromotion(
  _prevState: PromotionFormState,
  formData: FormData,
): Promise<PromotionFormState> {
  const session = await requireAdmin();

  const parsed = createPromotionSchema.safeParse({
    name: formData.get("name"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    initialCapital: formData.get("initialCapital"),
    minPositionSize: formData.get("minPositionSize"),
    maxPositionSize: formData.get("maxPositionSize"),
    maxPositions: formData.get("maxPositions"),
    maxCryptoPositions: formData.get("maxCryptoPositions"),
    changeSessionsPerWeek: formData.get("changeSessionsPerWeek"),
    maxChangesPerSession: formData.get("maxChangesPerSession"),
    freezeHoursBeforeEnd: formData.get("freezeHoursBeforeEnd"),
    initializationWindowHours: formData.get("initializationWindowHours"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Données invalides" };
  }

  const { name, startDate, endDate, initialCapital, ...ruleFields } = parsed.data;
  const rules = promotionRulesSchema.parse(ruleFields);

  const promotion = await db.promotion.create({
    data: {
      name,
      startDate,
      endDate,
      initialCapital,
      rules,
      status: PromotionStatus.DRAFT,
    },
  });

  await logAudit({
    adminId: session.user.id,
    action: "promotion.create",
    target: promotion.id,
    after: { name, startDate, endDate, initialCapital, rules },
  });

  revalidatePath("/admin/promotions");
  return {};
}

/** Nom uniquement — voir [id]/parametres/actions.ts pour les dates et les règles (capital, positions, cryptos...). */
export async function updatePromotion(
  promotionId: string,
  _prevState: PromotionFormState,
  formData: FormData,
): Promise<PromotionFormState> {
  const session = await requireAdmin();

  const parsed = updatePromotionBasicsSchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Données invalides" };
  }

  const { name } = parsed.data;

  const before = await db.promotion.findUniqueOrThrow({ where: { id: promotionId } });
  await db.promotion.update({
    where: { id: promotionId },
    data: { name },
  });

  await logAudit({
    adminId: session.user.id,
    action: "promotion.update",
    target: promotionId,
    before: { name: before.name },
    after: { name },
  });

  revalidatePath("/admin/promotions");
  revalidatePath(`/admin/promotions/${promotionId}`);
  return {};
}

export async function deletePromotion(promotionId: string) {
  const session = await requireAdmin();

  const promotion = await db.promotion.findUniqueOrThrow({
    where: { id: promotionId },
    include: { _count: { select: { participants: true, portfolios: true } } },
  });

  await db.promotion.delete({ where: { id: promotionId } });

  await logAudit({
    adminId: session.user.id,
    action: "promotion.delete",
    target: promotionId,
    before: {
      name: promotion.name,
      status: promotion.status,
      participantCount: promotion._count.participants,
      portfolioCount: promotion._count.portfolios,
    },
  });

  revalidatePath("/admin/promotions");
}

export async function setPromotionStatus(promotionId: string, status: PromotionStatus) {
  const session = await requireAdmin();

  const before = await db.promotion.findUniqueOrThrow({ where: { id: promotionId } });
  const promotion = await db.promotion.update({
    where: { id: promotionId },
    data: { status },
  });

  let provisionedCount: number | undefined;
  let initializationWindowOpened = false;
  if (status === PromotionStatus.ACTIVE) {
    provisionedCount = await provisionPortfolios(promotionId);
    initializationWindowOpened = (await ensureInitializationWindow(promotionId)) !== null;
  }

  if (status === PromotionStatus.CLOSED) {
    // Clôture manuelle par l'admin : même chemin exact que la clôture
    // automatique (voir src/lib/promotion-lifecycle.ts). Le `update`
    // ci-dessus a déjà passé le statut à CLOSED ; on lance la finalisation.
    await finalizePromotionClosure(promotionId);
  }

  await logAudit({
    adminId: session.user.id,
    action: "promotion.status",
    target: promotionId,
    before: { status: before.status },
    after: {
      status: promotion.status,
      provisionedPortfolios: provisionedCount,
      initializationWindowOpened,
    },
  });

  revalidatePath("/admin/promotions");
}

export interface ReopenPromotionState {
  error?: string;
}

/** Annule une clôture — voir reopenPromotion dans src/lib/promotion-lifecycle.ts. */
export async function reopenPromotion(promotionId: string): Promise<ReopenPromotionState> {
  const session = await requireAdmin();

  const result = await reopenPromotionLifecycle(promotionId);
  if (!result.reopened) return { error: result.error };

  await logAudit({
    adminId: session.user.id,
    action: "promotion.reopen",
    target: promotionId,
    before: { status: PromotionStatus.CLOSED },
    after: {
      status: PromotionStatus.ACTIVE,
      restoredSessions: result.restoredSessions,
      removedHallOfFameEntries: result.removedHallOfFameEntries,
      removedBadges: result.removedBadges,
      removedFinalSnapshots: result.removedFinalSnapshots,
    },
  });

  revalidatePath("/admin/promotions");
  revalidatePath(`/admin/promotions/${promotionId}`);
  return {};
}

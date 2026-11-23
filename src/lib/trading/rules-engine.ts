import { ChangeSessionKind, PromotionStatus } from "@/generated/prisma/enums";
import { computeChangeSessionStatus } from "./change-session-status";
import type { PositionContext, TradeContext, TradeOrderInput, TradeValidationResult } from "./types";

function ok(): TradeValidationResult {
  return { ok: true };
}

function fail(reason: string): TradeValidationResult {
  return { ok: false, reason };
}

function findPosition(positions: PositionContext[], assetId: string): PositionContext | undefined {
  return positions.find((position) => position.assetId === assetId && position.quantity > 0);
}

function isChangeSessionOpen(ctx: TradeContext): boolean {
  const { changeSession, now } = ctx;
  if (!changeSession) return false;
  return computeChangeSessionStatus(changeSession, now) === "OPEN";
}

function isFrozen(ctx: TradeContext): boolean {
  const freezeMs = ctx.promotion.rules.freezeHoursBeforeEnd * 60 * 60 * 1000;
  const freezeStart = new Date(ctx.promotion.endDate.getTime() - freezeMs);
  return ctx.now >= freezeStart;
}

/** Vérifie qu'ouvrir cette nouvelle position ne dépasse pas le nombre de cryptomonnaies distinctes autorisées. */
function checkCryptoPositionLimit(ctx: TradeContext): TradeValidationResult {
  if (ctx.asset.type !== "CRYPTO") {
    return ok();
  }

  const activeCryptoCount = ctx.positions.filter(
    (position) => position.quantity > 0 && position.assetType === "CRYPTO",
  ).length;

  if (activeCryptoCount + 1 > ctx.promotion.rules.maxCryptoPositions) {
    return fail(
      `Le nombre maximal de cryptomonnaies autorisées (${ctx.promotion.rules.maxCryptoPositions}) est déjà atteint.`,
    );
  }
  return ok();
}

function validateBuy(order: Extract<TradeOrderInput, { type: "BUY" }>, ctx: TradeContext): TradeValidationResult {
  if (!ctx.asset.isActive) {
    return fail("Cet actif n'est plus disponible à l'achat.");
  }
  if (findPosition(ctx.positions, order.assetId)) {
    return fail("Cet actif est déjà détenu — utilisez un renforcement plutôt qu'un achat.");
  }

  const activePositionsCount = ctx.positions.filter((position) => position.quantity > 0).length;
  if (activePositionsCount + 1 > ctx.promotion.rules.maxPositions) {
    return fail(`Le nombre maximal de ${ctx.promotion.rules.maxPositions} positions est déjà atteint.`);
  }

  if (order.amount < ctx.promotion.rules.minPositionSize) {
    return fail(`Le montant doit être au moins égal à la taille minimale de position (${ctx.promotion.rules.minPositionSize} €).`);
  }
  if (order.amount > ctx.promotion.rules.maxPositionSize) {
    return fail(`Le montant dépasse la taille maximale de position (${ctx.promotion.rules.maxPositionSize} €).`);
  }
  if (order.amount > ctx.availableCash) {
    return fail("Le capital disponible est insuffisant pour cet achat.");
  }

  return checkCryptoPositionLimit(ctx);
}

function validateIncrease(
  order: Extract<TradeOrderInput, { type: "INCREASE" }>,
  ctx: TradeContext,
): TradeValidationResult {
  const position = findPosition(ctx.positions, order.assetId);
  if (!position) {
    return fail("Impossible de renforcer : aucune position ouverte pour cet actif. Utilisez un achat.");
  }

  const currentValue = position.quantity * position.currentPrice;
  if (currentValue + order.amount > ctx.promotion.rules.maxPositionSize) {
    return fail(`Cette opération dépasserait la taille maximale de position (${ctx.promotion.rules.maxPositionSize} €).`);
  }
  if (order.amount > ctx.availableCash) {
    return fail("Le capital disponible est insuffisant pour ce renforcement.");
  }

  return ok();
}

function validateSellPartial(
  order: Extract<TradeOrderInput, { type: "SELL_PARTIAL" }>,
  ctx: TradeContext,
): TradeValidationResult {
  const position = findPosition(ctx.positions, order.assetId);
  if (!position) {
    return fail("Impossible de vendre : aucune position ouverte pour cet actif.");
  }
  if (order.quantity > position.quantity) {
    return fail("Impossible de vendre plus que la quantité détenue.");
  }
  if (order.quantity >= position.quantity) {
    return fail("Cette vente correspond à la totalité de la position — utilisez une vente totale.");
  }

  const remainingValue = (position.quantity - order.quantity) * position.currentPrice;
  if (remainingValue < ctx.promotion.rules.minPositionSize) {
    return fail(
      `Le reliquat serait inférieur à la taille minimale de position (${ctx.promotion.rules.minPositionSize} €) — vendez la totalité de la position.`,
    );
  }

  return ok();
}

function validateSellFull(
  order: Extract<TradeOrderInput, { type: "SELL_FULL" }>,
  ctx: TradeContext,
): TradeValidationResult {
  const position = findPosition(ctx.positions, order.assetId);
  if (!position) {
    return fail("Impossible de vendre : aucune position ouverte pour cet actif.");
  }
  return ok();
}

export function validateOrder(order: TradeOrderInput, ctx: TradeContext): TradeValidationResult {
  if (ctx.promotion.status !== PromotionStatus.ACTIVE) {
    return fail("Le concours n'est pas actif.");
  }
  if (isFrozen(ctx)) {
    return fail(`Les positions sont gelées dans les ${ctx.promotion.rules.freezeHoursBeforeEnd}h avant la fin du concours.`);
  }
  if (!isChangeSessionOpen(ctx)) {
    return fail("Aucune session de changement n'est ouverte actuellement.");
  }
  const isInitializationWindow = ctx.changeSession!.kind === ChangeSessionKind.INITIALIZATION;
  if (!isInitializationWindow && ctx.changesUsed >= ctx.changeSession!.maxChangesPerParticipant) {
    return fail("Le quota de changements de cette session est atteint.");
  }
  // Règlement : pas de trading intraday pendant la constitution — une ligne
  // achetée ne peut plus être vendue avant la prochaine session de changement.
  if (isInitializationWindow && (order.type === "SELL_PARTIAL" || order.type === "SELL_FULL")) {
    return fail(
      "Les ventes sont interdites pendant la fenêtre de constitution du portefeuille — attendez la prochaine session de changement.",
    );
  }

  switch (order.type) {
    case "BUY":
      return validateBuy(order, ctx);
    case "INCREASE":
      return validateIncrease(order, ctx);
    case "SELL_PARTIAL":
      return validateSellPartial(order, ctx);
    case "SELL_FULL":
      return validateSellFull(order, ctx);
  }
}

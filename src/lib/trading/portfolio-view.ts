import "server-only";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { AssetType, PromotionStatus } from "@/generated/prisma/enums";
import { promotionRulesSchema } from "@/lib/promotion-rules";
import {
  getRefreshTier,
  MORNING_INTERVAL_MS,
  GOLDEN_INTERVAL_MS,
  EVENING_INTERVAL_MS,
  NIGHT_REVALIDATE_MS,
} from "@/lib/refresh-schedule";
import { computeAvailableCash } from "./execute-order";
import { getCachedPromotionValuation, getPromotionValuation } from "./promotion-valuation";

export interface PositionView {
  assetId: string;
  symbol: string;
  name: string;
  assetType: AssetType;
  logoUrl: string | null;
  quantity: number;
  avgEntryPrice: number;
  /** Date d'ouverture de la position (ISO), pour l'historique de cours "depuis l'achat". */
  openedAt: string;
  currentPrice: number;
  /** Montant investi à l'achat (Entry Value). */
  entryValue: number;
  /** Valeur actuelle de la position (Actual Value). */
  actualValue: number;
  /** Poids de la position dans le portefeuille total investi (%). */
  allocationPct: number;
  pnl: number;
  pnlPct: number;
  /** Variation du prix sur les dernières 24h (%), `null` si aucun historique n'existe encore. */
  dailyChangePct: number | null;
}

export interface PortfolioView {
  promotionId: string;
  promotionName: string;
  promotionStatus: PromotionStatus;
  portfolioId: string;
  initialCapital: number;
  availableCash: number;
  /** Nombre maximal de positions autorisées, configuré par l'admin (Promotion.rules) — relu à
   * chaque chargement, s'adapte automatiquement si l'admin modifie la limite en cours de saison. */
  maxPositions: number;
  positions: PositionView[];
  totalMarketValue: number;
  /** Capital disponible + valeur investie — la valeur totale réelle du compte. */
  totalValue: number;
  totalGainEur: number;
  totalGainPct: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pour chaque actif, le prix le plus récent à ou avant `cutoff` — une seule
 * requête groupée (plutôt qu'une par position) grâce à `distinct`.
 */
async function getDailyReferencePrices(assetIds: string[], cutoff: Date): Promise<Map<string, number>> {
  if (assetIds.length === 0) return new Map();

  const rows = await db.price.findMany({
    where: { assetId: { in: assetIds }, timestamp: { lte: cutoff } },
    orderBy: { timestamp: "desc" },
    distinct: ["assetId"],
  });

  return new Map(rows.map((row) => [row.assetId, Number(row.price)]));
}

export async function getPortfolioView(userId: string): Promise<PortfolioView | null> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.promotionId) return null;

  const [portfolio, promotion] = await Promise.all([
    db.portfolio.findUnique({
      where: { userId_promotionId: { userId, promotionId: user.promotionId } },
      select: { id: true },
    }),
    db.promotion.findUnique({ where: { id: user.promotionId } }),
  ]);

  if (!portfolio || !promotion) return null;

  const initialCapital = Number(promotion.initialCapital);

  // Concours clôturé : tout est figé à `endDate` (dernier cours ≤ endDate, aucun
  // appel fournisseur). Sinon : valorisation partagée de la promotion — la MÊME
  // source que le classement (get-leaderboard.ts) et les statistiques, donc le
  // « Valeur du portefeuille » du tableau de bord et la colonne « Valeur » du
  // classement affichent le même euro. Plus de double rafraîchissement de prix,
  // plus de deux caches qui dérivent l'un de l'autre.
  const isClosed = promotion.status === PromotionStatus.CLOSED;
  const valuation = isClosed
    ? await getPromotionValuation(promotion.id, promotion.endDate, { frozen: true })
    : await getCachedPromotionValuation(promotion.id);
  const valued = valuation.byPortfolio[portfolio.id];

  const valuedPositions = valued?.positions ?? [];
  const availableCash = valued?.availableCash ?? (await computeAvailableCash(portfolio.id, initialCapital));
  const totalMarketValue = valued?.marketValue ?? 0;

  // Variation 24 h : cours de référence de la veille — détail propre au tableau
  // de bord, jamais figé sur un concours clos.
  const referencePrices = isClosed
    ? new Map<string, number>()
    : await getDailyReferencePrices(
        valuedPositions.map((position) => position.assetId),
        new Date(Date.now() - DAY_MS),
      );

  const positions: PositionView[] = valuedPositions.map((position) => {
    const actualValue = position.marketValue;
    const entryValue = position.quantity * position.avgEntryPrice;
    const referencePrice = referencePrices.get(position.assetId);

    return {
      assetId: position.assetId,
      symbol: position.symbol,
      name: position.name,
      assetType: position.assetType,
      logoUrl: position.logoUrl,
      quantity: position.quantity,
      avgEntryPrice: position.avgEntryPrice,
      openedAt: position.openedAt,
      currentPrice: position.currentPrice,
      entryValue,
      actualValue,
      allocationPct: totalMarketValue > 0 ? (actualValue / totalMarketValue) * 100 : 0,
      pnl: actualValue - entryValue,
      pnlPct: entryValue > 0 ? ((actualValue - entryValue) / entryValue) * 100 : 0,
      dailyChangePct:
        referencePrice && referencePrice > 0
          ? ((position.currentPrice - referencePrice) / referencePrice) * 100
          : null,
    };
  });

  const totalValue = valued?.totalValue ?? availableCash + totalMarketValue;
  const totalGainEur = totalValue - initialCapital;

  return {
    promotionId: promotion.id,
    promotionName: promotion.name,
    promotionStatus: promotion.status,
    portfolioId: portfolio.id,
    initialCapital,
    availableCash,
    maxPositions: promotionRulesSchema.parse(promotion.rules).maxPositions,
    positions,
    totalMarketValue,
    totalValue,
    totalGainEur,
    totalGainPct: initialCapital > 0 ? (totalGainEur / initialCapital) * 100 : 0,
  };
}

/**
 * Variante mise en cache de {@link getPortfolioView} — même raisonnement que
 * {@link getCachedLeaderboard} (get-leaderboard.ts) : un refresh manuel du
 * dashboard, la page la plus visitée, contournait totalement `AutoRefresh`.
 *
 * `unstable_cache` ne permet pas un tag dynamique par utilisateur (le tag est
 * fixé à la définition, pas à l'appel) — on utilise donc un tag unique
 * `"portfolio-view"`, partagé par tous les participants : le trade d'un seul
 * utilisateur invalide le cache de tout le monde, ce qui reste correct (juste
 * légèrement moins optimal qu'un tag par utilisateur) et bien plus simple à
 * garder juste dans la durée — tout point de mutation (achat/vente côté
 * participant dans dashboard/actions.ts, correction admin dans
 * admin/portfolios/[portfolioId]/actions.ts et
 * admin/promotions/[id]/actions.ts) doit appeler `updateTag("portfolio-view")`
 * après avoir modifié positions/transactions. Si un point de mutation futur
 * oublie cet appel, la fenêtre `revalidate` reste le filet de sécurité.
 *
 * Quatre variantes (matin/golden/soir/nuit, voir refresh-schedule.ts) plutôt
 * qu'une seule : `revalidate` est figé à la définition d'`unstable_cache`,
 * impossible à calculer dynamiquement à l'appel — `getCachedPortfolioView`
 * choisit entre les quatre selon l'heure. Même tag sur les quatre.
 */
const getCachedPortfolioViewMorning = unstable_cache(
  (userId: string) => getPortfolioView(userId),
  ["portfolio-view", "morning"],
  { revalidate: MORNING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPortfolioViewGolden = unstable_cache(
  (userId: string) => getPortfolioView(userId),
  ["portfolio-view", "golden"],
  { revalidate: GOLDEN_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPortfolioViewEvening = unstable_cache(
  (userId: string) => getPortfolioView(userId),
  ["portfolio-view", "evening"],
  { revalidate: EVENING_INTERVAL_MS / 1000, tags: ["portfolio-view"] },
);
const getCachedPortfolioViewNight = unstable_cache(
  (userId: string) => getPortfolioView(userId),
  ["portfolio-view", "night"],
  { revalidate: NIGHT_REVALIDATE_MS / 1000, tags: ["portfolio-view"] },
);
export function getCachedPortfolioView(userId: string): Promise<PortfolioView | null> {
  const tier = getRefreshTier();
  if (tier === "golden") return getCachedPortfolioViewGolden(userId);
  if (tier === "evening") return getCachedPortfolioViewEvening(userId);
  if (tier === "morning") return getCachedPortfolioViewMorning(userId);
  return getCachedPortfolioViewNight(userId);
}

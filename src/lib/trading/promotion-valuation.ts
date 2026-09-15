import "server-only";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { AssetType } from "@/generated/prisma/enums";
import { refreshAssetPricesIfStale } from "@/lib/prices/pull-through";
import {
  getRefreshTier,
  MORNING_INTERVAL_MS,
  GOLDEN_INTERVAL_MS,
  EVENING_INTERVAL_MS,
  NIGHT_REVALIDATE_MS,
} from "@/lib/refresh-schedule";
import { computeAvailableCash } from "./execute-order";

/**
 * Source de vérité UNIQUE de la valeur live d'un portefeuille.
 *
 * Avant : `getLeaderboard`, `getPortfolioView`, `getParticipantStats` et
 * `getContestStats` recalculaient chacun la valeur d'un portefeuille — chacun
 * avec son propre `refreshAssetPricesIfStale` (à un instant différent) et son
 * propre `unstable_cache` (horloge de revalidation indépendante). Résultat : le
 * même portefeuille affichait un euro différent selon l'onglet, dérivant d'une
 * fenêtre de cache entière dès que les marchés bougeaient.
 *
 * Maintenant : un seul rafraîchissement de prix par promotion, une seule
 * arithmétique, un seul cache. Tous les onglets lisent `byPortfolio[id]` tel
 * quel — ils affichent donc, par construction, la même valeur.
 *
 * `frozen` : concours clôturé — chaque position est valorisée au dernier cours
 * connu ≤ `asOf`, sans aucun appel fournisseur (cohérent avec le classement
 * figé et le Hall of Fame).
 */
export interface ValuedPosition {
  assetId: string;
  symbol: string;
  name: string;
  assetType: AssetType;
  logoUrl: string | null;
  /** Date d'ouverture de la position (ISO). */
  openedAt: string;
  quantity: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  pnlPct: number;
}

export interface ValuedPortfolio {
  portfolioId: string;
  userId: string;
  availableCash: number;
  marketValue: number;
  totalValue: number;
  cumulativeReturnPct: number;
  positions: ValuedPosition[];
}

export interface PromotionValuation {
  promotionId: string;
  initialCapital: number;
  /** assetId -> cours courant retenu (résolu une seule fois pour toute la promotion). */
  pricesByAsset: Record<string, number>;
  byPortfolio: Record<string, ValuedPortfolio>;
}

function resolveLogoUrl(asset: { symbol: string; type: AssetType; logoUrl: string | null }): string | null {
  if (asset.logoUrl) return asset.logoUrl;
  if (asset.type === AssetType.STOCK) {
    return `https://images.financialmodelingprep.com/symbol/${asset.symbol}.png`;
  }
  return null;
}

async function loadFrozenPrices(assetIds: string[], asOf: Date): Promise<Map<string, number>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.price.findMany({
    where: { assetId: { in: assetIds }, timestamp: { lte: asOf } },
    orderBy: { timestamp: "desc" },
    distinct: ["assetId"],
  });
  return new Map(rows.map((row) => [row.assetId, Number(row.price)]));
}

export async function getPromotionValuation(
  promotionId: string,
  now: Date = new Date(),
  { frozen = false }: { frozen?: boolean } = {},
): Promise<PromotionValuation> {
  const promotion = await db.promotion.findUniqueOrThrow({ where: { id: promotionId } });
  const initialCapital = Number(promotion.initialCapital);

  const portfolios = await db.portfolio.findMany({
    where: { promotionId },
    select: { id: true, userId: true },
  });

  const positions = await db.position.findMany({
    where: { portfolioId: { in: portfolios.map((portfolio) => portfolio.id) }, quantity: { gt: 0 }, closedAt: null },
    include: { asset: { include: { prices: { orderBy: { timestamp: "desc" }, take: 1 } } } },
  });

  const distinctAssets = new Map(positions.map((position) => [position.assetId, position.asset]));

  const pricesByAsset: Record<string, number> = {};
  if (frozen) {
    const frozenPrices = await loadFrozenPrices([...distinctAssets.keys()], now);
    for (const [assetId, asset] of distinctAssets) {
      pricesByAsset[assetId] = frozenPrices.get(assetId) ?? Number(asset.prices[0]?.price ?? 0);
    }
  } else {
    const refreshed = await refreshAssetPricesIfStale([...distinctAssets.values()], now);
    for (const [assetId, asset] of distinctAssets) {
      pricesByAsset[assetId] = refreshed.get(assetId)?.price ?? Number(asset.prices[0]?.price ?? 0);
    }
  }

  const cashByPortfolio = new Map(
    await Promise.all(
      portfolios.map(async (portfolio) => [portfolio.id, await computeAvailableCash(portfolio.id, initialCapital)] as const),
    ),
  );

  const byPortfolio: Record<string, ValuedPortfolio> = {};
  for (const portfolio of portfolios) {
    byPortfolio[portfolio.id] = {
      portfolioId: portfolio.id,
      userId: portfolio.userId,
      availableCash: cashByPortfolio.get(portfolio.id) ?? initialCapital,
      marketValue: 0,
      totalValue: 0,
      cumulativeReturnPct: 0,
      positions: [],
    };
  }

  for (const position of positions) {
    const bucket = byPortfolio[position.portfolioId];
    if (!bucket) continue;
    const quantity = Number(position.quantity);
    const avgEntryPrice = Number(position.avgEntryPrice);
    const currentPrice = pricesByAsset[position.assetId] || avgEntryPrice;
    const marketValue = quantity * currentPrice;
    bucket.positions.push({
      assetId: position.assetId,
      symbol: position.asset.symbol,
      name: position.asset.name,
      assetType: position.asset.type,
      logoUrl: resolveLogoUrl(position.asset),
      openedAt: position.openedAt.toISOString(),
      quantity,
      avgEntryPrice,
      currentPrice,
      marketValue,
      pnlPct: avgEntryPrice > 0 ? ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100 : 0,
    });
    bucket.marketValue += marketValue;
  }

  for (const bucket of Object.values(byPortfolio)) {
    bucket.totalValue = bucket.availableCash + bucket.marketValue;
    bucket.cumulativeReturnPct =
      initialCapital > 0 ? ((bucket.totalValue - initialCapital) / initialCapital) * 100 : 0;
  }

  return { promotionId, initialCapital, pricesByAsset, byPortfolio };
}

/**
 * Variante mise en cache — voir {@link getPromotionValuation}. Même pattern à
 * quatre paliers (matin / golden / soir / nuit) que `getCachedLeaderboard`. Tags
 * `leaderboard` + `portfolio-view` : tout ordre (participant ou correction
 * admin) invalide déjà ces deux tags, donc la valorisation partagée se
 * rafraîchit au même moment que les vues qui la consomment.
 */
const getCachedPromotionValuationMorning = unstable_cache(
  (promotionId: string) => getPromotionValuation(promotionId),
  ["promotion-valuation", "morning"],
  { revalidate: MORNING_INTERVAL_MS / 1000, tags: ["leaderboard", "portfolio-view"] },
);
const getCachedPromotionValuationGolden = unstable_cache(
  (promotionId: string) => getPromotionValuation(promotionId),
  ["promotion-valuation", "golden"],
  { revalidate: GOLDEN_INTERVAL_MS / 1000, tags: ["leaderboard", "portfolio-view"] },
);
const getCachedPromotionValuationEvening = unstable_cache(
  (promotionId: string) => getPromotionValuation(promotionId),
  ["promotion-valuation", "evening"],
  { revalidate: EVENING_INTERVAL_MS / 1000, tags: ["leaderboard", "portfolio-view"] },
);
const getCachedPromotionValuationNight = unstable_cache(
  (promotionId: string) => getPromotionValuation(promotionId),
  ["promotion-valuation", "night"],
  { revalidate: NIGHT_REVALIDATE_MS / 1000, tags: ["leaderboard", "portfolio-view"] },
);

export function getCachedPromotionValuation(promotionId: string): Promise<PromotionValuation> {
  const tier = getRefreshTier();
  if (tier === "golden") return getCachedPromotionValuationGolden(promotionId);
  if (tier === "evening") return getCachedPromotionValuationEvening(promotionId);
  if (tier === "morning") return getCachedPromotionValuationMorning(promotionId);
  return getCachedPromotionValuationNight(promotionId);
}

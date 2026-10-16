import "server-only";
import { db } from "@/lib/db";
import { PromotionStatus } from "@/generated/prisma/enums";
import { isPriceStale } from "@/lib/prices/staleness";
import { fetchPriceWithFallback } from "@/lib/prices/provider-fallback";
import type { PriceProvider } from "@/lib/prices/types";

export interface IngestResult {
  assetId: string;
  symbol: string;
  status: "ok" | "skipped" | "unsupported" | "failed";
  price?: number;
}

/**
 * Ingestion planifiée (cron) : ne rappelle le fournisseur que pour les actifs
 * dont le prix est périmé (même seuil que le rafraîchissement pull-through,
 * voir staleness.ts) — sert de filet de sécurité pour les actifs que
 * personne ne consulte, sans jamais dupliquer un appel déjà couvert par une
 * consultation récente. C'est ce qui permet de planifier ce job bien plus
 * souvent qu'une fois par jour sans dépasser le quota gratuit des
 * fournisseurs (voir .github/workflows/ingest-prices.yml).
 *
 * Ne rafraîchit que les actifs détenus (position ouverte) dans une promotion
 * ACTIVE : les prix des concours terminés sont figés à la clôture (voir
 * finalizePromotionClosure), inutile de continuer à appeler les fournisseurs —
 * et donc de consommer des crédits — pour eux. S'il n'y a aucune promotion
 * active, ce job ne fait plus aucun appel. Multi-concours : union des actifs
 * de tous les concours actifs.
 */
export async function ingestAssetPrices(providers: PriceProvider[], now: Date = new Date()): Promise<IngestResult[]> {
  const assets = await db.asset.findMany({
    where: {
      isActive: true,
      positions: {
        some: {
          closedAt: null,
          quantity: { gt: 0 },
          portfolio: { promotion: { status: PromotionStatus.ACTIVE } },
        },
      },
    },
  });
  if (assets.length === 0) return [];

  const latestRows = await db.price.findMany({
    where: { assetId: { in: assets.map((asset) => asset.id) } },
    orderBy: { timestamp: "desc" },
    distinct: ["assetId"],
  });
  const latestByAsset = new Map(latestRows.map((row) => [row.assetId, row]));

  const results: IngestResult[] = [];

  for (const asset of assets) {
    const latest = latestByAsset.get(asset.id);
    if (!isPriceStale(latest?.timestamp, asset.type, now, latest?.source)) {
      results.push({ assetId: asset.id, symbol: asset.symbol, status: "skipped", price: latest ? Number(latest.price) : undefined });
      continue;
    }

    const isSupported = providers.some((candidate) => candidate.supports(asset));
    if (!isSupported) {
      results.push({ assetId: asset.id, symbol: asset.symbol, status: "unsupported" });
      continue;
    }

    try {
      const quote = await fetchPriceWithFallback(providers, asset);
      if (!quote) {
        console.error(`[ingest-prices] all providers failed for ${asset.symbol} (${asset.id})`);
        results.push({ assetId: asset.id, symbol: asset.symbol, status: "failed" });
        continue;
      }

      await db.price.create({
        data: {
          assetId: asset.id,
          timestamp: quote.timestamp,
          price: quote.price,
          source: quote.source,
        },
      });

      results.push({ assetId: asset.id, symbol: asset.symbol, status: "ok", price: quote.price });
    } catch (error) {
      console.error(`[ingest-prices] error fetching/storing price for ${asset.symbol} (${asset.id})`, error);
      results.push({ assetId: asset.id, symbol: asset.symbol, status: "failed" });
    }
  }

  return results;
}

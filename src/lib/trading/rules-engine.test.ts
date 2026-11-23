import { describe, it, expect } from "vitest";
import { AssetType, ChangeSessionKind, ChangeSessionStatus, PromotionStatus } from "@/generated/prisma/enums";
import { defaultPromotionRules } from "@/lib/promotion-rules";
import { validateOrder } from "./rules-engine";
import type { TradeContext } from "./types";

const NOW = new Date("2026-09-15T12:00:00Z");

function baseContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    now: NOW,
    promotion: {
      status: PromotionStatus.ACTIVE,
      endDate: new Date("2026-09-30T00:00:00Z"),
      rules: defaultPromotionRules,
    },
    changeSession: {
      kind: ChangeSessionKind.WEEKLY,
      status: ChangeSessionStatus.OPEN,
      opensAt: new Date("2026-09-15T00:00:00Z"),
      closesAt: new Date("2026-09-16T00:00:00Z"),
      maxChangesPerParticipant: 4,
    },
    changesUsed: 0,
    availableCash: 1_000_000,
    positions: [],
    asset: { id: "asset-aapl", type: AssetType.STOCK, isActive: true, currentPrice: 100 },
    ...overrides,
  };
}

describe("validateOrder — garde-fous globaux", () => {
  it("refuse tout ordre si la promotion n'est pas active", () => {
    const ctx = baseContext({ promotion: { ...baseContext().promotion, status: PromotionStatus.DRAFT } });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("pas actif") });
  });

  it("refuse tout ordre pendant la période de gel avant la fin du concours", () => {
    const ctx = baseContext({
      now: new Date("2026-09-29T00:00:00Z"), // 24h avant la fin, gel = 48h
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("gel") });
  });

  it("accepte un ordre juste avant le début de la période de gel", () => {
    const ctx = baseContext({
      now: new Date("2026-09-27T23:59:00Z"), // un peu plus de 48h avant la fin
      changeSession: {
        kind: ChangeSessionKind.WEEKLY,
        status: ChangeSessionStatus.OPEN,
        opensAt: new Date("2026-09-27T00:00:00Z"),
        closesAt: new Date("2026-09-28T00:00:00Z"),
        maxChangesPerParticipant: 4,
      },
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse tout ordre si aucune session de changement n'est ouverte", () => {
    const ctx = baseContext({ changeSession: null });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("session") });
  });

  it("accepte un ordre pour une session au statut SCHEDULED si l'heure actuelle tombe dans sa fenêtre (ouverture automatique, aucune action admin requise)", () => {
    const ctx = baseContext({
      changeSession: { ...baseContext().changeSession!, status: ChangeSessionStatus.SCHEDULED },
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse tout ordre si l'admin a fermé la session par anticipation (statut CLOSED), même pendant sa fenêtre normale", () => {
    const ctx = baseContext({
      changeSession: { ...baseContext().changeSession!, status: ChangeSessionStatus.CLOSED },
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("session") });
  });

  it("refuse tout ordre en dehors du créneau horaire de la session", () => {
    const ctx = baseContext({ now: new Date("2026-09-17T00:00:00Z") });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("session") });
  });

  it("refuse tout ordre si le quota de changements de la session est atteint", () => {
    const ctx = baseContext({ changesUsed: 4 });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("quota") });
  });

  it("accepte quand le quota n'est pas encore atteint", () => {
    const ctx = baseContext({ changesUsed: 3 });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("n'applique aucun quota de changements pendant la fenêtre de constitution du portefeuille", () => {
    const ctx = baseContext({
      changeSession: { ...baseContext().changeSession!, kind: ChangeSessionKind.INITIALIZATION },
      changesUsed: 999,
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result.ok).toBe(true);
  });
});

describe("validateOrder — fenêtre de constitution (pas de trading intraday)", () => {
  const position = { assetId: "asset-aapl", assetType: AssetType.STOCK, quantity: 500, avgEntryPrice: 100, currentPrice: 100 };
  const initCtx = () =>
    baseContext({
      changeSession: { ...baseContext().changeSession!, kind: ChangeSessionKind.INITIALIZATION },
      positions: [position],
    });

  it("refuse une vente totale pendant la constitution", () => {
    const result = validateOrder({ type: "SELL_FULL", assetId: "asset-aapl" }, initCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("fenêtre de constitution");
  });

  it("refuse une vente partielle pendant la constitution", () => {
    const result = validateOrder({ type: "SELL_PARTIAL", assetId: "asset-aapl", quantity: 100 }, initCtx());

    expect(result.ok).toBe(false);
  });

  it("autorise toujours le renforcement pendant la constitution", () => {
    const result = validateOrder({ type: "INCREASE", assetId: "asset-aapl", amount: 10_000 }, initCtx());

    expect(result.ok).toBe(true);
  });

  it("autorise la vente lors d'une session hebdomadaire", () => {
    const result = validateOrder({ type: "SELL_FULL", assetId: "asset-aapl" }, baseContext({ positions: [position] }));

    expect(result.ok).toBe(true);
  });
});

describe("validateOrder — BUY (nouvelle position)", () => {
  it("accepte un achat dans les bornes de taille de position", () => {
    const ctx = baseContext();

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse un achat en dessous de la taille minimale", () => {
    const ctx = baseContext();

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 10_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("minimale") });
  });

  it("refuse un achat au-dessus de la taille maximale", () => {
    const ctx = baseContext();

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 150_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("maximale") });
  });

  it("refuse un achat si le capital disponible est insuffisant", () => {
    const ctx = baseContext({ availableCash: 30_000 });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("capital disponible") });
  });

  it("refuse un achat si le nombre maximal de positions est déjà atteint", () => {
    const positions = Array.from({ length: 20 }, (_, i) => ({
      assetId: `asset-${i}`,
      assetType: AssetType.STOCK,
      quantity: 100,
      avgEntryPrice: 100,
      currentPrice: 100,
    }));
    const ctx = baseContext({ positions });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("20 positions") });
  });

  it("refuse un achat si l'actif est déjà détenu (il faut utiliser INCREASE)", () => {
    const ctx = baseContext({
      positions: [
        { assetId: "asset-aapl", assetType: AssetType.STOCK, quantity: 10, avgEntryPrice: 100, currentPrice: 100 },
      ],
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("déjà détenu") });
  });

  it("refuse un achat sur un actif désactivé par l'admin", () => {
    const ctx = baseContext({ asset: { ...baseContext().asset, isActive: false } });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("disponible") });
  });

  it("refuse un achat crypto qui dépasserait le nombre maximal de cryptomonnaies autorisées", () => {
    const ctx = baseContext({
      asset: { id: "asset-eth", type: AssetType.CRYPTO, isActive: true, currentPrice: 3_000 },
      positions: [
        { assetId: "asset-btc", assetType: AssetType.CRYPTO, quantity: 1, avgEntryPrice: 50_000, currentPrice: 50_000 },
      ],
      // maxCryptoPositions par défaut = 1, une position crypto (BTC) déjà ouverte
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-eth", amount: 30_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("cryptomonnaies") });
  });

  it("accepte un achat crypto qui reste sous le nombre maximal autorisé", () => {
    const ctx = baseContext({
      asset: { id: "asset-btc", type: AssetType.CRYPTO, isActive: true, currentPrice: 50_000 },
      positions: [
        { assetId: "asset-other", assetType: AssetType.STOCK, quantity: 1, avgEntryPrice: 380_000, currentPrice: 380_000 },
      ],
      // maxCryptoPositions par défaut = 1, aucune position crypto encore ouverte
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-btc", amount: 30_000 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse tout achat crypto quand le nombre maximal autorisé est fixé à zéro", () => {
    const ctx = baseContext({
      asset: { id: "asset-btc", type: AssetType.CRYPTO, isActive: true, currentPrice: 50_000 },
      promotion: {
        ...baseContext().promotion,
        rules: { ...defaultPromotionRules, maxCryptoPositions: 0 },
      },
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-btc", amount: 30_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("cryptomonnaies") });
  });

  it("n'applique pas la limite crypto à un achat non-crypto", () => {
    const ctx = baseContext({
      positions: [
        { assetId: "asset-btc", assetType: AssetType.CRYPTO, quantity: 1, avgEntryPrice: 50_000, currentPrice: 50_000 },
      ],
      // maxCryptoPositions par défaut = 1, déjà atteint, mais l'achat porte sur une action
    });

    const result = validateOrder({ type: "BUY", assetId: "asset-aapl", amount: 50_000 }, ctx);

    expect(result.ok).toBe(true);
  });
});

describe("validateOrder — INCREASE (renforcer une position)", () => {
  const existingPosition = {
    assetId: "asset-aapl",
    assetType: AssetType.STOCK,
    quantity: 500,
    avgEntryPrice: 100,
    currentPrice: 100,
  };

  it("accepte un renforcement qui reste sous le plafond de taille", () => {
    const ctx = baseContext({ positions: [existingPosition] });

    const result = validateOrder({ type: "INCREASE", assetId: "asset-aapl", amount: 20_000 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse un renforcement qui dépasserait le plafond de taille de position", () => {
    const ctx = baseContext({ positions: [existingPosition] }); // valeur actuelle = 50 000

    const result = validateOrder({ type: "INCREASE", assetId: "asset-aapl", amount: 60_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("maximale") });
  });

  it("refuse un renforcement si le capital disponible est insuffisant", () => {
    const ctx = baseContext({ positions: [existingPosition], availableCash: 5_000 });

    const result = validateOrder({ type: "INCREASE", assetId: "asset-aapl", amount: 20_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("capital disponible") });
  });

  it("refuse un renforcement si la position n'existe pas encore (il faut utiliser BUY)", () => {
    const ctx = baseContext({ positions: [] });

    const result = validateOrder({ type: "INCREASE", assetId: "asset-aapl", amount: 20_000 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("aucune position") });
  });

  it("accepte de renforcer une position crypto déjà ouverte même si le maximum est atteint", () => {
    const cryptoPosition = {
      assetId: "asset-btc",
      assetType: AssetType.CRYPTO,
      quantity: 1,
      avgEntryPrice: 50_000,
      currentPrice: 50_000,
    };
    const ctx = baseContext({
      asset: { id: "asset-btc", type: AssetType.CRYPTO, isActive: true, currentPrice: 50_000 },
      positions: [cryptoPosition],
      // maxCryptoPositions par défaut = 1, déjà atteint par cette même position — le
      // renforcement n'ouvre pas de nouvelle cryptomonnaie, donc il reste autorisé
    });

    const result = validateOrder({ type: "INCREASE", assetId: "asset-btc", amount: 20_000 }, ctx);

    expect(result.ok).toBe(true);
  });
});

describe("validateOrder — SELL_PARTIAL", () => {
  const existingPosition = {
    assetId: "asset-aapl",
    assetType: AssetType.STOCK,
    quantity: 500,
    avgEntryPrice: 100,
    currentPrice: 100,
  };

  it("accepte une vente partielle qui laisse un reliquat au-dessus du minimum", () => {
    const ctx = baseContext({ positions: [existingPosition] }); // valeur = 50 000

    // vend 200 titres (20 000€) -> reliquat 300 titres = 30 000€, > minimum 25 000€
    const result = validateOrder({ type: "SELL_PARTIAL", assetId: "asset-aapl", quantity: 200 }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse une vente partielle qui laisserait un reliquat sous le minimum", () => {
    const ctx = baseContext({ positions: [existingPosition] });

    // vend 400 titres -> reliquat 100 titres = 10 000€, < minimum 25 000€
    const result = validateOrder({ type: "SELL_PARTIAL", assetId: "asset-aapl", quantity: 400 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("totalité") });
  });

  it("refuse de vendre plus que la quantité détenue", () => {
    const ctx = baseContext({ positions: [existingPosition] });

    const result = validateOrder({ type: "SELL_PARTIAL", assetId: "asset-aapl", quantity: 600 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("détenue") });
  });

  it("refuse une vente partielle égale à la quantité totale (il faut utiliser SELL_FULL)", () => {
    const ctx = baseContext({ positions: [existingPosition] });

    const result = validateOrder({ type: "SELL_PARTIAL", assetId: "asset-aapl", quantity: 500 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("totalité") });
  });

  it("refuse la vente si aucune position n'existe pour cet actif", () => {
    const ctx = baseContext({ positions: [] });

    const result = validateOrder({ type: "SELL_PARTIAL", assetId: "asset-aapl", quantity: 100 }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("aucune position") });
  });
});

describe("validateOrder — SELL_FULL", () => {
  it("accepte la fermeture complète d'une position existante", () => {
    const ctx = baseContext({
      positions: [
        { assetId: "asset-aapl", assetType: AssetType.STOCK, quantity: 500, avgEntryPrice: 100, currentPrice: 100 },
      ],
    });

    const result = validateOrder({ type: "SELL_FULL", assetId: "asset-aapl" }, ctx);

    expect(result.ok).toBe(true);
  });

  it("refuse si aucune position n'existe pour cet actif", () => {
    const ctx = baseContext({ positions: [] });

    const result = validateOrder({ type: "SELL_FULL", assetId: "asset-aapl" }, ctx);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("aucune position") });
  });

  it("permet de vendre entièrement un actif désactivé par l'admin (sortie toujours possible)", () => {
    const ctx = baseContext({
      asset: { ...baseContext().asset, isActive: false },
      positions: [
        { assetId: "asset-aapl", assetType: AssetType.STOCK, quantity: 500, avgEntryPrice: 100, currentPrice: 100 },
      ],
    });

    const result = validateOrder({ type: "SELL_FULL", assetId: "asset-aapl" }, ctx);

    expect(result.ok).toBe(true);
  });
});

"use client";

import { useEffect, useState } from "react";

const currencyFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

interface InitializationWindowBannerProps {
  /** ISO string — les composants client ne doivent pas recevoir de `Date` directement depuis un Server Component. */
  closesAt: string;
  investedAmount: number;
  initialCapital: number;
}

/**
 * Bandeau de la fenêtre de constitution du portefeuille : compte à rebours en
 * direct jusqu'à la fermeture, plus une barre de progression du capital
 * investi (indicatif — aucun ordre n'est bloqué pour capital non investi,
 * voir rules-engine.ts).
 */
export function InitializationWindowBanner({ closesAt, investedAmount, initialCapital }: InitializationWindowBannerProps) {
  const closesAtMs = new Date(closesAt).getTime();
  const [remainingMs, setRemainingMs] = useState(() => closesAtMs - Date.now());

  useEffect(() => {
    const id = setInterval(() => setRemainingMs(closesAtMs - Date.now()), 1000);
    return () => clearInterval(id);
  }, [closesAtMs]);

  const isClosed = remainingMs <= 0;
  const investedPct = initialCapital > 0 ? Math.min(100, Math.max(0, (investedAmount / initialCapital) * 100)) : 0;
  const remainingCapital = Math.max(0, initialCapital - investedAmount);

  return (
    <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground">
      <div className="flex items-center justify-between gap-4">
        <p className="font-medium">🚀 Fenêtre de constitution du portefeuille</p>
        <p className="tabular-nums">{isClosed ? "Fermée" : `⏱ Ferme dans ${formatRemaining(remainingMs)}`}</p>
      </div>
      <p className="mt-1 text-muted-foreground">
        Investissez votre capital initial. Achats et ventes ne sont pas illimités : le trading intraday est
        interdit (aucune vente avant la prochaine session de changement) et les règles de positions et de
        cryptomonnaies restent en vigueur.
      </p>
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Capital investi</span>
          <span className="tabular-nums">
            {currencyFormatter.format(investedAmount)} / {currencyFormatter.format(initialCapital)}
          </span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${investedPct}%` }} />
        </div>
        {remainingCapital > 0 && (
          <p className="mt-2 text-xs font-medium text-foreground">
            ⚠ Il vous reste {currencyFormatter.format(remainingCapital)} non investis avant la fermeture.
          </p>
        )}
      </div>
    </div>
  );
}

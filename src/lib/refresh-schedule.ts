import { getParisHourMinute } from "./timezone";

/**
 * Fréquence de rafraîchissement (poll client `AutoRefresh` et fenêtre
 * `unstable_cache`) adaptée aux horaires de marché, heure de Paris :
 * - 9h-15h30 (Europe ouverte, US fermée) : 5 min
 * - 15h30-18h ("golden hour", Europe + ouverture US) : 1 min — la période la
 *   plus suivie du concours, doit donner une sensation de marché vivant.
 * - 18h-22h (US ouverte, activité déclinante côté stagiaires) : 10 min
 * - 22h-9h (tout fermé) : aucun rafraîchissement automatique — un seul
 *   calcul sert toute la nuit, déclenché par le premier accès (voir
 *   NIGHT_REVALIDATE_MS plus bas).
 *
 * Fréquences recalculées le 2026-09-15 à partir d'une estimation chiffrée de
 * l'egress Supabase (voir docs/DEPLOIEMENT.md) : la valorisation, le
 * classement et chaque portefeuille sont mutualisés côté serveur
 * (`unstable_cache`, voir promotion-valuation.ts / get-leaderboard.ts /
 * portfolio-view.ts) — le coût réel dépend du nombre de FENÊTRES par jour,
 * pas du nombre de participants ni de F5. Un palier à 1 min entre 15h30 et
 * 18h reste très en dessous du seuil de péremption des prix actions (10 min,
 * voir staleness.ts) : il ne rafraîchit pas les cours plus vite que le
 * fournisseur, mais recalcule rang/P&L/écarts à une cadence qui se sent
 * "vivante" sans en payer le prix d'un vrai temps réel (1s-10s).
 */
const MORNING_START_MINUTES = 9 * 60; // 9h00
const GOLDEN_START_MINUTES = 15 * 60 + 30; // 15h30
const EVENING_START_MINUTES = 18 * 60; // 18h00
const NIGHT_START_MINUTES = 22 * 60; // 22h00

export const MORNING_INTERVAL_MS = 5 * 60 * 1000;
export const GOLDEN_INTERVAL_MS = 60 * 1000;
export const EVENING_INTERVAL_MS = 10 * 60 * 1000;
/** Pas un intervalle de poll (la nuit ne rafraîchit jamais automatiquement) — la fenêtre
 * `revalidate` du cache serveur pendant la nuit, dimensionnée sur sa durée totale (22h → 9h,
 * 11h) pour qu'un seul calcul, déclenché par le premier accès de la nuit, serve jusqu'au matin
 * sans jamais expirer entre-temps. */
export const NIGHT_REVALIDATE_MS = 11 * 60 * 60 * 1000;

export type RefreshTier = "morning" | "golden" | "evening" | "night";

export function getRefreshTier(now: Date = new Date()): RefreshTier {
  const { hour, minute } = getParisHourMinute(now);
  const minutesSinceMidnight = hour * 60 + minute;
  if (minutesSinceMidnight >= EVENING_START_MINUTES && minutesSinceMidnight < NIGHT_START_MINUTES) {
    return "evening";
  }
  if (minutesSinceMidnight >= GOLDEN_START_MINUTES && minutesSinceMidnight < EVENING_START_MINUTES) {
    return "golden";
  }
  if (minutesSinceMidnight >= MORNING_START_MINUTES && minutesSinceMidnight < GOLDEN_START_MINUTES) {
    return "morning";
  }
  return "night";
}

/** `false` entre 22h et 9h (heure de Paris) : marchés américains et européens fermés, aucune
 * raison de rafraîchir automatiquement. */
export function isMarketHours(now: Date = new Date()): boolean {
  return getRefreshTier(now) !== "night";
}

/** Cadence de "coup d'œil" côté client (AutoRefresh). La nuit partage celle du matin — seul
 * `isMarketHours` décide si le tick déclenche réellement un `router.refresh()`, voir
 * auto-refresh.tsx — ça permet de détecter la réouverture des marchés à 9h sans jamais rafraîchir
 * entre-temps. */
export function getPollIntervalMs(now: Date = new Date()): number {
  const tier = getRefreshTier(now);
  if (tier === "golden") return GOLDEN_INTERVAL_MS;
  if (tier === "evening") return EVENING_INTERVAL_MS;
  return MORNING_INTERVAL_MS;
}

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getPollIntervalMs, isMarketHours } from "@/lib/refresh-schedule";

/**
 * Ré-exécute le fetch des Server Components de la page courante à intervalle
 * régulier (`router.refresh()`), sans navigation ni perte de l'état client —
 * c'est ce qui fait apparaître automatiquement un nouveau prix, P&L, rang de
 * classement, etc. dès qu'il devient disponible en base, sans que le
 * participant ait besoin de recharger la page. Composant purement
 * comportemental, ne rend rien.
 *
 * En pause quand l'onglet n'est pas visible (`document.hidden`), pour ne pas
 * consommer de rafraîchissements pour un onglet en arrière-plan.
 *
 * Intervalle par défaut volontairement plus proche de la fraîcheur réelle
 * des données (prix rafraîchis au plus toutes les 10-15 min, snapshots de
 * performance calculés une fois par nuit) que d'un vrai temps réel : chaque
 * tick relance un recalcul complet du classement/des stats pour tous les
 * participants côté serveur, un intervalle de 10s multipliait inutilement
 * cette charge par ~6 pour une donnée qui ne change quasiment jamais aussi
 * vite.
 *
 * Intervalle remonté par étapes le 2026-08-13 (60s → 3 min → 5 min → 15 min)
 * après analyse chiffrée de l'egress Supabase (quota gratuit dépassé, voir
 * docs/DEPLOIEMENT.md), une fois les requêtes de page (leaderboard,
 * dashboard, stats) mises en cache serveur partagé (`unstable_cache`, voir
 * get-leaderboard.ts et portfolio-view.ts) : la cadence de poll n'a plus
 * besoin d'être plus courte que la fenêtre de ce cache, qui plafonne déjà
 * l'egress indépendamment de la fréquence de poll — un tick plus rapide ne
 * fait que réveiller l'onglet plus souvent, jamais requêter Supabase plus
 * souvent que la fenêtre `revalidate` active.
 *
 * Sans `intervalMs` explicite, la cadence suit les horaires de marché
 * (`src/lib/refresh-schedule.ts`, heure de Paris) : 5 min de 9h à 15h30
 * (Europe ouverte, US fermée), 1 min de 15h30 à 18h ("golden hour",
 * recalculée le 2026-09-15 pour donner une sensation de marché vivant
 * pendant l'ouverture US — reste au-dessus de STOCK_PRICE_STALE_MS, 10 min,
 * donc ne rafraîchit jamais les cours plus vite que le fournisseur, mais
 * recalcule rang/P&L à une cadence perceptible), 10 min de 18h à 22h (US
 * ouverte, activité déclinante côté stagiaires), et **aucun rafraîchissement
 * entre 22h et 9h** — marchés fermés, rien de nouveau à afficher. Pendant
 * cette fenêtre nocturne, le composant continue de se réveiller (à la
 * cadence du matin) pour détecter la réouverture à 9h, mais sans jamais
 * appeler `router.refresh()` tant que `isMarketHours()` est faux. `setTimeout`
 * récursif plutôt que `setInterval` fixe : chaque tick recalcule le délai
 * et réévalue les horaires, pour s'adapter correctement si l'onglet reste
 * ouvert à cheval sur une bascule de palier. `intervalMs` reste utilisable
 * pour forcer une cadence fixe, y compris hors marché, si un cas
 * particulier en avait besoin.
 *
 * Le délai est calé sur les multiples de l'intervalle depuis l'epoch
 * (`Date.now() % interval`) plutôt que sur un délai relatif au montage du
 * composant : deux onglets montés à des instants différents (ex. classement
 * ouvert à 10h02, dashboard à 10h07) calculent le même prochain instant de
 * réveil au lieu de dériver l'un de l'autre, donc tous les onglets se
 * rafraîchissent au même instant avec les mêmes données de référence — sans
 * changer la durée ni la fréquence des intervalles eux-mêmes.
 */
export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  const router = useRouter();
  const routerRef = useRef(router);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    function scheduleNext() {
      const interval = intervalMs ?? getPollIntervalMs();
      const delay = interval - (Date.now() % interval);
      timeoutId = setTimeout(() => {
        if (!document.hidden && (intervalMs !== undefined || isMarketHours())) {
          routerRef.current.refresh();
        }
        scheduleNext();
      }, delay);
    }

    scheduleNext();
    return () => clearTimeout(timeoutId);
  }, [intervalMs]);

  return null;
}

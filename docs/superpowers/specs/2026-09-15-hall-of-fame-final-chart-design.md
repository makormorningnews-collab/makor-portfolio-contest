# Hall of Fame / Shame — graphique final de chaque promotion clôturée

**Date :** 2026-09-15
**Statut :** validé, prêt pour le plan d'implémentation

## Problème

Le Hall of Fame ne montre que le podium/tableau final de chaque promotion clôturée. La courbe
d'évolution comparée des participants — pourtant déjà affichée pendant la vie du concours sur
`/leaderboard` — disparaît entièrement à la clôture : `FrozenLeaderboardBoard` (utilisé partout
où une promotion `CLOSED` est affichée) ne rend ni le graphique ni aucun lien vers lui. On veut
pouvoir consulter, depuis le Hall of Fame, le graphique final tel qu'il était à la clôture de
chaque saison — y compris pour « Promotion Août 2026 » — et garantir que ce sera automatiquement
vrai pour toutes les promotions futures.

## Contexte technique (état actuel)

- Le graphique comparatif existe déjà et est entièrement générique :
  `PromotionPerformanceChart` (`src/app/leaderboard/promotion-performance-chart.tsx`, Recharts,
  `"use client"`) prend en props pures `points`, `participantNames`, `initialCapital`,
  `participantAvatars` — aucun fetch interne. C'est le composant à réutiliser tel quel.
- Ces props viennent de `getPromotionPerformanceSeries(promotionId)`
  (`src/lib/gamification/get-promotion-performance-series.ts`) : lit **uniquement** les lignes
  `PerformanceSnapshot` déjà stockées, liées à `Portfolio` (lui-même lié en permanence à
  `promotionId` — jamais réassigné, jamais supprimé par du code applicatif, vérifié par
  recherche exhaustive de `deleteMany`/`delete` sur `Portfolio`/`PerformanceSnapshot`). Aucun
  recalcul à partir des prix actuels.
- `finalizePromotionClosure` (`src/lib/promotion-lifecycle.ts`) écrit déjà, à la clôture :
  1. Le classement final figé (`HallOfFameEntry`, une ligne par participant, avatar figé).
  2. Un `PerformanceSnapshot` terminal par portefeuille à `timestamp = asOf`.
- **Vérification directe sur la base de production** (`omhyxzfygpiyqobtqltq`, script read-only
  jetable, supprimé après usage) : pour « Promotion Août 2026 » (06/08 → 28/08), les 3
  participants ont chacun 23/23 jours couverts, 36 snapshots chacun, premier le 06/08 22:51,
  dernier le 28/08 11:00 (= `endDate` exact). **Aucune donnée manquante — l'historique complet
  de la courbe est intact et reconstructible sans invention.**
- Le cron `snapshot-portfolios` ne snapshotte que les promotions `status: ACTIVE` — une
  promotion clôturée n'accumule plus de nouvelles lignes, ce qui explique pourquoi l'historique
  reste stable dans les faits. Mais rien ne rend cette stabilité **explicite** : `PerformanceSnapshot`
  reste la même table que celle utilisée par les concours actifs, sans garantie structurelle
  d'indépendance si une future tâche de maintenance (purge, rétention, migration) y touchait sans
  exclure spécifiquement les promotions closes.
- `getHallOfFame` (`src/lib/gamification/hall-of-fame.ts`) expose déjà `seasons: HallOfFameSeason[]`
  — une entrée par promotion clôturée avec `promotionId`, `promotionName`, `closedAt`, `podium` —
  rendu dans `src/app/hall-of-fame/page.tsx` section « Podiums par saison », un `Card` par saison.
  C'est l'ancrage naturel du nouveau bouton.
- Egress (déjà un incident documenté en août — voir mémoire `project_leaderboard_portfolio_consistency_fix`) :
  les avatars sont des data URLs jusqu'à ~13-14 Ko. `getHallOfFame` limite déjà volontairement les
  avatars chargés sur la page d'index (podium + pire + visiteur seulement). Le nouveau graphique
  ne doit pas réintroduire ce risque : ses avatars ne doivent être chargés que lorsqu'on consulte
  la page dédiée d'**une seule** saison, jamais en bloc sur l'index.

## Décisions produit (validées avec l'utilisateur)

1. **Snapshot JSON dédié et immuable**, indépendant de `PerformanceSnapshot` — pas une simple
   lecture à la demande de la table live. Nouveau champ `Promotion.finalChartSnapshot Json?`,
   écrit une seule fois à la clôture, jamais modifié ensuite.
2. Générique pour toutes les promotions, pas un correctif ad hoc pour Août 2026 — le mécanisme
   d'écriture vit dans `finalizePromotionClosure`, appelé pour toute clôture (auto ou admin).
3. Pour Août 2026 spécifiquement : le graphique doit reconstruire l'état exact de la clôture, pas
   recalculer depuis les valeurs actuelles des portefeuilles. Les données existantes ayant été
   vérifiées complètes, le script de rattrapage agrège l'historique déjà stocké — aucune
   invention nécessaire.
4. Design du graphique inchangé — réutilisation intégrale de `PromotionPerformanceChart`.

## Approche retenue

### 1. Schéma

Migration Prisma ajoutant un seul champ nullable sur `Promotion` :

```prisma
model Promotion {
  // ...
  /// Snapshot figé du graphique comparatif à la clôture — { points,
  /// participantNames, participantAvatars }, même forme que les props de
  /// PromotionPerformanceChart (initialCapital déjà sur Promotion). Écrit une
  /// seule fois par finalizePromotionClosure, jamais modifié ensuite : lecture
  /// totalement indépendante de PerformanceSnapshot / des prix / des concours
  /// actifs. Nul tant que la promotion n'est pas clôturée (ou clôturée avant
  /// l'introduction de ce champ, cas couvert par un message dédié côté lecture).
  finalChartSnapshot Json?
}
```

Pas de nouvelle table : un blob par promotion suffit (pas de relation à modéliser, pas de
jointure à la lecture).

### 2. Écriture — générique, automatique

Dans `finalizePromotionClosure`, après l'écriture des `PerformanceSnapshot` terminaux :

1. Appeler `getPromotionPerformanceSeries(promotionId)` — inclut désormais le point terminal
   qui vient d'être écrit, donc la courbe se termine exactement à `asOf`.
2. Construire `participantAvatars: Record<string, string | null>` en réutilisant
   `avatarByUserId` (déjà calculé pour `HallOfFameEntry` juste au-dessus dans la même fonction) —
   zippé avec `finalRows` pour obtenir `name -> avatarUrl`. Mêmes photos figées que le Hall of
   Fame, pas de nouvelle requête.
3. Écrire avec un `updateMany({ where: { id: promotionId, finalChartSnapshot: null }, data: { finalChartSnapshot: {...} } })`
   — garde d'immuabilité applicative : write-once, cohérent avec le style déjà en place dans ce
   fichier (`createMany skipDuplicates`, `updateMany` conditionnel). Un rejeu (clôture paresseuse
   + self-heal `/resultats` + balayage `stuck`) est un no-op sur ce champ.

### 3. Lecture

Nouvelle fonction `getFinalChartSnapshot(promotionId): Promise<FinalChartSnapshot | null>` dans
`src/lib/gamification/get-final-chart-snapshot.ts` — lit `Promotion.finalChartSnapshot`, renvoie
`null` si absent (promotion pas encore clôturée, ou clôturée avant ce champ et jamais
rattrapée).

Nouvelle page `src/app/hall-of-fame/[promotionId]/graphique/page.tsx` (Server Component) :
- Vérifie la session (même garde que `/hall-of-fame`).
- Charge la promotion (nom) + `getFinalChartSnapshot(promotionId)`.
- Si absent : message clair « Historique du graphique indisponible pour cette saison » — pas
  d'invention, pas de recalcul de repli.
- Si présent : rend `PromotionPerformanceChart` (composant existant, inchangé) dans un `Card`,
  avec `initialCapital` lu sur la promotion. Lien de retour vers `/hall-of-fame`.

### 4. UI — Hall of Fame

Dans `src/app/hall-of-fame/page.tsx`, section « Podiums par saison », chaque `Card` de saison
gagne un lien/bouton « Voir le graphique final » dans son `CardHeader` (à côté de la date),
pointant vers `/hall-of-fame/[promotionId]/graphique`.

### 5. Rattrapage Août 2026

Script ponctuel `scripts/backfill-final-chart-snapshot.ts` (même gabarit que
`fix-august-contest.ts` : dry-run par défaut, `--commit` pour écrire, garde-fou sur l'id de la
base de prod) :
- Pour chaque promotion `CLOSED` avec `finalChartSnapshot: null` : recalcule via
  `getPromotionPerformanceSeries` + avatars `HallOfFameEntry` (déjà figés), écrit le snapshot.
- Rejouable : ne touche que les promotions sans snapshot.
- Généralise le rattrapage au-delà du seul cas Août 2026 (toute promotion déjà close avant ce
  déploiement en bénéficie automatiquement).

## Hors périmètre (explicitement exclu)

- `/leaderboard` et `/directeur/promotions/[id]/classement` continuent de ne pas afficher de
  graphique une fois la promotion close (même lacune, non demandée ici — `FrozenLeaderboardBoard`
  inchangé).
- Pas de pagination/compression du JSON (volumes triviaux : quelques Ko de points + avatars déjà
  bornés au nombre de participants d'une seule promotion, jamais agrégés entre saisons).
- Aucun changement à `PerformanceSnapshot`, au cron `snapshot-portfolios`, ni à la logique de prix.
- Pas de nouveau composant graphique — réutilisation stricte de `PromotionPerformanceChart`.

## Risques / points d'attention pour le plan d'implémentation

- La garde `finalChartSnapshot: null` dans le `updateMany` d'écriture doit être testée en
  situation de rejeu (clôture paresseuse + self-heal), comme le reste de
  `finalizePromotionClosure`.
- Le script de rattrapage doit être testé en dry-run contre prod avant `--commit`, avec le même
  garde-fou d'identité de base que `fix-august-contest.ts`.
- Vérifier que `participantAvatars` construit à l'écriture correspond bien aux mêmes clés
  (`name`) que `participantNames`/`points` — `getPromotionPerformanceSeries` clé tout par
  `portfolio.user.name`, donc le zip avec `avatarByUserId` doit passer par le nom, pas
  directement par `userId`.

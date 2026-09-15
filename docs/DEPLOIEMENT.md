# Déploiement — Vercel + Supabase

Architecture retenue : **Vercel** (hébergement Next.js, gratuit sur le plan Hobby) + **Supabase**
(PostgreSQL managé, gratuit sur le plan Free). Aucune carte bancaire n'est requise pour ces deux
plans à cette échelle (une trentaine d'utilisateurs par promotion).

**Historique** : le projet a démarré sur Neon plutôt que Supabase, précisément pour éviter le
défaut de Supabase décrit plus bas (pause après inactivité). En pratique, Neon s'est révélé plus
risqué pour un usage continu : son plan gratuit impose un plafond mensuel dur (heures de calcul /
transfert de données) qui, une fois atteint, **met le projet en pause de force** jusqu'au
renouvellement mensuel ou à un upgrade payant — sans marge de manœuvre gratuite pour repartir
immédiatement. Ça s'est produit en plein concours actif, coupant l'accès à tous les participants
sans avertissement préalable. Le projet est donc repassé sur Supabase : son seul vrai défaut
(pause après 7 jours d'inactivité, réactivable en un clic depuis le dashboard, sans dépendre d'un
plafond d'usage cumulé) est sans risque pour un concours actif consulté en continu, et largement
préférable à un mur dur payant en cours de saison.

**Incident du 2026-08-13** : le quota gratuit d'egress Supabase (5 Go/mois) a fini par être
dépassé, plaçant l'organisation en grace period jusqu'au 15 août. Cause racine identifiée : la
page `/leaderboard` retransmettait la photo de profil (base64) de **tous** les participants à
chaque exécution, et `AutoRefresh` (`src/components/auto-refresh.tsx`) rafraîchissait cette page
toutes les 60s — un fan-out qui dominait largement l'egress, bien plus que la fréquence de poll
en elle-même. Corrigé côté code en plusieurs passes le même jour :

- `get-leaderboard.ts` ne récupère plus l'avatar que pour le podium (top 3, indépendant du nombre
  de participants) au lieu de tous.
- **Découverte d'un second trou** : `AutoRefresh` ne protège que le rafraîchissement automatique —
  un rechargement manuel (F5), un premier chargement ou une navigation ré-exécutaient toutes les
  requêtes Supabase sans aucune limite, contournant entièrement l'intervalle de poll. Corrigé en
  enveloppant les requêtes des 4 pages les plus visitées (leaderboard, dashboard, badges,
  statistiques — `get-leaderboard.ts`, `portfolio-view.ts`, `get-contest-stats.ts`,
  `get-personal-records.ts`, `get-participant-stats.ts`, `get-promotion-performance-series.ts`)
  dans `unstable_cache`, un cache serveur **partagé entre tous les participants et toutes les
  requêtes**, pas seulement par utilisateur. Ses actions restent instantanées pour l'auteur grâce à
  `updateTag` appelé à chaque point de mutation (trades participant dans `dashboard/actions.ts`,
  corrections admin dans `admin/portfolios/[portfolioId]/actions.ts` et
  `admin/promotions/[id]/actions.ts`, changement d'avatar dans `profil/actions.ts`) — la fenêtre de
  cache n'est donc plus qu'un filet de sécurité pour les changements passifs (évolution des prix),
  jamais un facteur de latence sur ses propres actions.
- Le cron GitHub Actions d'ingestion des prix est passé de 5 à 15 min.
- Une fois le cache serveur en place, l'intervalle d'`AutoRefresh` et les 6 fenêtres
  `unstable_cache` ont été unifiés à **15 min partout** : rien de plus court n'apporte de fraîcheur
  réelle, les prix ne changeant de toute façon jamais plus vite que `STOCK_PRICE_STALE_MS` (voir
  `staleness.ts`).

Résultat : l'egress ne dépend plus ni de la fréquence de poll ni du comportement des
participants (rafraîchissement manuel compris) — plafond dur d'une requête Supabase réelle par
fenêtre `unstable_cache` et par promotion, quel que soit le trafic.

**Révision du 2026-09-15** (upgrade Pro, 250 Go d'egress inclus au lieu des 5 Go du plan Free) :
la fenêtre unique à 15 min était dimensionnée pour un quota gratuit très serré, pas pour donner une
sensation de marché vivant. Analyse chiffrée (participants actifs × payload avatar/positions ×
fenêtres/jour, voir le commit qui introduit `GOLDEN_INTERVAL_MS`) montrant une marge de >95% même
avec un palier à 1 min pendant l'ouverture US : passage à **4 paliers** au lieu de 3
(`src/lib/refresh-schedule.ts`) — 5 min de 9h à 15h30, **1 min de 15h30 à 18h** (heure la plus
suivie du concours), 10 min de 18h à 22h, aucun rafraîchissement de 22h à 9h. Le mécanisme de cache
mutualisé lui-même (celui qui rend F5 et le nombre de participants sans effet sur l'egress) est
inchangé — seule la durée des fenêtres a été révisée à la hausse pour ce budget.

Comme la mécanique exacte de fin de grace period n'est pas entièrement documentée par Supabase
(voir discussions GitHub officielles sur le sujet), et par prudence pour un concours encore actif,
le projet a aussi été migré vers une **nouvelle organisation Supabase** (quota gratuit totalement
indépendant de celle restreinte, les quotas Supabase sont par organisation et non par compte) en
région **Paris (`eu-west-3`)** — via `pg_dump`/`pg_restore` du schéma + données, puis changement de
`DATABASE_URL`/`DIRECT_URL` sur le même projet Vercel (même URL pour les participants, aucune
interruption). L'ancienne organisation Supabase restreinte n'est plus utilisée et peut être
ignorée ou supprimée.

**Incident du 2026-08-25** : le dashboard Supabase affichait ~2 744 requêtes Postgres sur 24h dont
~2 604 en erreur (95% d'échec), malgré des prix rafraîchis seulement toutes les 15 min — largement
de quoi dépasser à nouveau les limites du plan gratuit (grace period "exceeding usage limits"
déclenchée). Deux causes distinctes, sans rapport avec le rafraîchissement des prix :

- **Cause mineure mais réelle** : `src/proxy.ts` revérifie la session en base à chaque requête
  correspondant à son `matcher` — y compris les requêtes de **prefetch** Next.js, déclenchées dès
  qu'un `<Link>` entre dans le viewport (les 5-6 liens de `SiteHeader` affichés sur chaque page
  protégée), pas seulement au clic. Une seule visite de page pouvait donc déclencher jusqu'à 6
  requêtes Postgres de vérification de session pour des liens jamais cliqués, en plus de celle de
  la page réellement visitée. Corrigé en excluant les requêtes de prefetch (headers
  `next-router-prefetch` / `purpose: prefetch`) du `matcher` de `proxy.ts`, via le pattern
  documenté par Next.js lui-même pour ce cas précis.
- **Cause dominante, indépendante de l'application** : l'essentiel des 2 604 erreurs venait en
  réalité de Supabase lui-même, pas de l'app. Confirmé via Database → Logs → Postgres Logs :
  l'erreur `3F000 schema "pg_pgrst_no_exposed_schemas" does not exist` revenait toutes les ~32
  secondes en continu (≈2 700/jour — quasi exactement le volume constaté). C'est un comportement
  connu et documenté par Supabase : quand **Enable Data API** est désactivé (ce que ce projet fait
  volontairement, voir étape 3 ci-dessous), PostgREST ne s'arrête pas complètement et continue de
  sonder en boucle un schéma placeholder qui n'existe pas exprès — sans impact fonctionnel réel
  ("this should not adversely affect the project", doc Supabase), mais ça gonfle artificiellement
  les stats de requêtes/erreurs du dashboard. Neutralisé avec le correctif officiel Supabase,
  exécuté dans le SQL Editor du projet :
  ```sql
  create schema pgrst_no_exposed_schemas;
  alter role authenticator set pgrst.db_schemas = 'pgrst_no_exposed_schemas';
  notify pgrst;
  ```
  (pour revenir en arrière si le Data API est réactivé un jour :
  `alter role authenticator reset pgrst.db_schemas; notify pgrst;`)

Le compte étant déjà en grace period, le projet a de nouveau été migré vers une organisation
Supabase neuve (même procédure qu'au 2026-08-13 : `pg_dump`/`pg_restore` du schéma **`public`
uniquement** — en excluant délibérément les schémas internes Supabase comme `auth`/`storage`,
vides et gérés par la plateforme, pour ne pas interférer avec leur provisioning sur le nouveau
projet — puis changement de `DATABASE_URL`/`DIRECT_URL` sur le même projet Vercel). Le correctif
`pg_pgrst_no_exposed_schemas` ci-dessus a été appliqué dès la création du nouveau projet, avant
toute accumulation de bruit.

## 1. Créer la base de données (Supabase)

1. Créer un compte sur [supabase.com](https://supabase.com) (gratuit, pas de carte bancaire —
   une adresse email suffit).
2. Créer un nouveau projet — nommez-le par exemple `makor-portfolio-contest`, choisissez une
   région proche des utilisateurs (ex. `eu-west-3` pour la France, `eu-west-1` pour l'Europe en
   général — le projet actuel tourne sur `eu-west-3` depuis l'incident du 2026-08-13 ci-dessus).
3. **Décocher** les options suivantes à la création — aucune n'est utilisée par ce projet, qui se
   connecte directement en Postgres via Prisma et n'utilise jamais l'API publique ni
   l'authentification Supabase (auth maison, voir `src/lib/auth/`) :
   - **Enable Data API** (API REST publique inutile ici)
   - **Automatically expose new tables**
   - **Enable automatic RLS**

   **Important** (voir l'incident du 2026-08-25 ci-dessus) : dès le projet créé, exécuter dans le
   **SQL Editor** le correctif du bruit `pg_pgrst_no_exposed_schemas` — sinon PostgREST génère une
   erreur Postgres toutes les ~30 secondes en continu, qui gonfle artificiellement les stats
   requêtes/erreurs du dashboard et peut à elle seule déclencher un dépassement de quota :
   ```sql
   create schema pgrst_no_exposed_schemas;
   alter role authenticator set pgrst.db_schemas = 'pgrst_no_exposed_schemas';
   notify pgrst;
   ```
4. Une fois le projet créé, dans **Project Settings → Database**, récupérer les deux chaînes de
   connexion (bouton **"Connect"** en haut du dashboard, onglet **ORM → Prisma** donne les deux
   directement formatées) :
   - le pooler **"Transaction mode"** (port `6543`, `?pgbouncer=true`) → variable `DATABASE_URL`
   - le pooler **"Session mode"** (port `5432`) → variable `DIRECT_URL`

   Le mot de passe de la base n'est affiché qu'une seule fois (à la création, ou après un clic
   sur "Reset database password" dans Database Settings) — le noter immédiatement.

   **Attention aux caractères spéciaux** : si le mot de passe contient `@`, `/`, `:` ou autre
   caractère réservé d'URL, il faut l'encoder (`@` → `%40`, etc.) dans les deux chaînes de
   connexion, sinon la connexion échoue silencieusement (le caractère casse le parsing de l'URL).

## 2. Déployer sur Vercel

1. Pousser le dépôt sur GitHub (ou GitLab/Bitbucket).
2. Sur [vercel.com](https://vercel.com), **Add New → Project**, importer le dépôt.
3. Vercel détecte automatiquement Next.js — ne rien changer aux réglages de build.
4. Dans **Environment Variables**, ajouter :
   - `DATABASE_URL` = la chaîne de connexion **Transaction pooler** Supabase (port 6543) —
     utilisée par l'app en fonctionnement (voir `src/lib/db.ts`)
   - `DIRECT_URL` = la chaîne de connexion **Session pooler** Supabase (port 5432) — utilisée
     uniquement par `prisma migrate deploy` au build (voir `prisma.config.ts`). Le pooler
     "transaction mode" de Supabase (PgBouncer) ne supporte pas fiablement les opérations DDL
     des migrations, d'où la nécessité de cette seconde URL, distincte de celle utilisée à
     l'exécution.
   - `TWELVE_DATA_API_KEY` = votre clé gratuite [twelvedata.com](https://twelvedata.com) (optionnel,
     mais recommandé pour une recherche de tickers et des prix fiables en production)
   - `CRON_SECRET` = une valeur aléatoire de votre choix (ex. générée avec
     `openssl rand -base64 32`) — protège les routes `/api/cron/*` contre des appels externes
     non autorisés
5. **Deploy**. Le premier déploiement échouera si la base est vide — c'est normal, on applique
   le schéma à l'étape suivante.

> **Note** : le blocage `P1002` (verrou advisory Postgres bloqué) déjà documenté par le passé sur
> ce projet était spécifique à l'interaction entre PgBouncer et Neon — il ne s'est pas reproduit
> depuis le passage à Supabase. Si un verrou advisory bloquait malgré tout un déploiement futur
> (erreur Prisma `P1002`), la même méthode de résolution s'applique : se connecter à la base (avec
> `DIRECT_URL`), trouver la session bloquante (`select * from pg_locks where locktype =
> 'advisory'`), et la terminer (`select pg_terminate_backend(<pid>)`) — ça ne touche aucune donnée.

## 3. Appliquer le schéma et créer le compte admin

Depuis votre machine locale, avec `DATABASE_URL` et `DIRECT_URL` pointées temporairement vers
Supabase :

```bash
DATABASE_URL="<transaction pooler>" DIRECT_URL="<session pooler>" npx prisma migrate deploy
DATABASE_URL="<transaction pooler>" DIRECT_URL="<session pooler>" ADMIN_INITIAL_PASSWORD="<mot de passe fort>" npm run db:seed
```

La deuxième commande crée le compte administrateur (identifiant `Makor` par défaut, ou
`ADMIN_INITIAL_NAME` si défini). Le mot de passe **doit** être fourni via `ADMIN_INITIAL_PASSWORD`
(8 caractères minimum) — il n'y a pas de valeur par défaut, et le changement est imposé dès la
première connexion. La commande est sûre à relancer : elle ne fait rien si le compte existe déjà.
**Ne jamais lancer `npm run db:seed:demo` contre la base de production** : il crée des comptes de
démonstration avec un mot de passe prévisible.

Redéployer sur Vercel (ou simplement re-déclencher le build) une fois le schéma appliqué.

## 4. Les crons planifiés

`vercel.json` déclare deux crons, tous deux compatibles avec le plan Hobby (limité à une
exécution par jour et par cron) :

```json
{
  "crons": [
    { "path": "/api/cron/ingest-prices", "schedule": "0 21 * * *" },
    { "path": "/api/cron/snapshot-portfolios", "schedule": "0 22 * * *" }
  ]
}
```

Vercel les active automatiquement au déploiement — rien à configurer côté dashboard. Le premier
rafraîchit une dernière fois tous les prix avant que le second calcule l'historique de
performance du jour (classement, badges). Voir la section "Recherche de tickers et
rafraîchissement des prix" du README pour le détail du cache pull-through qui garde les prix à
jour le reste de la journée sans dépendre de ces crons.

Si `CRON_SECRET` est défini sur Vercel, celui-ci est automatiquement envoyé en
`Authorization: Bearer <valeur>` par l'infrastructure de cron de Vercel — aucune configuration
supplémentaire n'est nécessaire.

Un rafraîchissement plus fréquent (`.github/workflows/ingest-prices.yml`, toutes les 15 minutes —
même cadence que le reste de l'app depuis l'incident du 2026-08-13 ci-dessus) tourne en parallèle
via GitHub Actions — voir ce fichier pour les secrets requis (`APP_URL`, `CRON_SECRET`).

## 5. Domaine

Le domaine `<projet>.vercel.app` fourni par défaut est utilisable tel quel — c'est l'URL simple,
accessible depuis n'importe quel navigateur, que les stagiaires utiliseront. Un domaine
personnalisé (ex. `concours.makorgroup.com`) peut être ajouté depuis **Project Settings →
Domains** si souhaité, sans configuration supplémentaire côté application.

## 6. Préparer une nouvelle promotion

Une fois déployé, voir [ADMINISTRATION.md](ADMINISTRATION.md) pour créer un concours, ajouter les
participants de la nouvelle promotion, et transmettre les identifiants.

## Reprise par un futur stagiaire

Toute la configuration nécessaire au redéploiement tient dans les quatre variables
d'environnement listées à l'étape 2. Aucun accès à un compte Google, aucune clé secrète héritée
d'un stagiaire précédent : un nouveau compte Vercel + Supabase (gratuits) suffit pour repartir de
zéro sur un déploiement entièrement neuf.

**Surveiller les limites du plan Supabase actif** (Free : 500 Mo de base, 5 Go de transfert/mois ;
Pro : 8 Go de base, 250 Go de transfert/mois — à vérifier sur supabase.com, ces chiffres évoluent)
pour éviter de revivre l'incident du 2026-08-13 décrit plus haut, qui a nécessité une migration en
urgence. Les mitigations déjà en place (cache serveur partagé `unstable_cache` sur les pages les
plus visitées — donc F5/navigation et nombre de participants n'ont plus d'effet direct sur
l'egress, voir la révision du 2026-09-15 ci-dessus pour le détail des 4 paliers horaires) devraient
largement suffire même en repartant sur un compte Free pour cette échelle de concours (~10-40
participants). Le fan-out d'avatars n'est plus limité au podium (`get-leaderboard.ts` les renvoie
pour tous les participants) : c'est désormais le cache mutualisé, pas un repli d'affichage, qui
plafonne ce coût — voir le commentaire dans ce fichier si ce compromis doit être revisité (au-delà
de quelques centaines de participants). Si l'usage remonte malgré tout près du quota, créer une
nouvelle organisation Supabase (quota gratuit indépendant, voir procédure de l'incident) est un
levier de secours rapide, avant d'envisager un plan payant. Si ce projet grossit significativement
(beaucoup plus de 40 participants, plusieurs promotions actives en parallèle), reposer la question
de l'hébergement auprès de l'entreprise plutôt que de dépendre indéfiniment d'un plan gratuit
personnel.

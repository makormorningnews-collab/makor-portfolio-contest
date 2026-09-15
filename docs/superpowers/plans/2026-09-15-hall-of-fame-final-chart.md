# Hall of Fame — Graphique final de promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depuis le Hall of Fame, permettre d'ouvrir le graphique comparatif final (tel qu'il
était à la clôture) de n'importe quelle promotion terminée — de façon générique pour toutes les
promotions futures, et en reconstruisant l'historique déjà intact pour « Promotion Août 2026 ».

**Architecture:** Un nouveau champ JSON immuable `Promotion.finalChartSnapshot`, écrit une seule
fois par `finalizePromotionClosure` (write-once, indépendant de la table `PerformanceSnapshot`
utilisée par les concours actifs). Une nouvelle page `/hall-of-fame/[promotionId]/graphique` lit
ce snapshot et réutilise tel quel le composant `PromotionPerformanceChart` déjà utilisé par
`/leaderboard`. Un bouton dans chaque carte de saison du Hall of Fame y renvoie. Un script de
rattrapage ponctuel remplit ce champ pour les promotions déjà closes (dont Août 2026).

**Tech Stack:** Next.js (App Router, Server Components), Prisma 7 + Postgres (Supabase), Zod,
Vitest, Recharts (via le composant existant, inchangé).

## Global Constraints

- Le composant `PromotionPerformanceChart` (`src/app/leaderboard/promotion-performance-chart.tsx`)
  ne doit **pas** être modifié — design et props existants réutilisés tels quels.
- `finalChartSnapshot` est écrit **une seule fois** (garde `where: { finalChartSnapshot: null }`)
  — jamais réécrit ensuite, y compris en cas de rejeu de `finalizePromotionClosure`.
- Ne jamais recalculer la courbe depuis les valeurs actuelles des portefeuilles — uniquement
  agréger l'historique déjà stocké (`PerformanceSnapshot`) ou les avatars déjà figés
  (`HallOfFameEntry`).
- **`npm run build` exécute `prisma migrate deploy` contre la base pointée par `.env` (qui est la
  production pour ce projet) avant `next build`.** Ne jamais lancer `npm run build` comme simple
  vérification de compilation pendant ce plan — utiliser `npx tsc --noEmit` pour ça. L'application
  de la migration Prisma (Task 1) et l'exécution du script de rattrapage (Task 6) sont des étapes
  volontaires et isolées, chacune confirmée explicitement avant `--commit`/`migrate deploy`.
- Toutes les nouvelles fonctions lib server-only gardent `import "server-only";` en tête, comme
  le reste du projet.

---

### Task 1 : Schéma Prisma — `Promotion.finalChartSnapshot`

**Files:**
- Modify: `prisma/schema.prisma` (modèle `Promotion`, ~ligne 81-106)
- Create: `prisma/migrations/20260915120000_promotion_final_chart_snapshot/migration.sql`

**Interfaces:**
- Produces : le champ Prisma `Promotion.finalChartSnapshot: Prisma.JsonValue | null`, consommé
  par Task 2 (écriture) et Task 3 (lecture).

- [ ] **Step 1 : Ajouter le champ au schéma**

Dans `prisma/schema.prisma`, dans le modèle `Promotion`, ajouter le champ juste après
`rulesCustomNotes` :

```prisma
model Promotion {
  id               String          @id @default(cuid())
  name             String
  status           PromotionStatus @default(DRAFT)
  startDate        DateTime
  endDate          DateTime
  initialCapital   Decimal         @db.Decimal(18, 2)
  /// PromotionRules: { minPositionSize, maxPositionSize, maxPositions, maxCryptoPositions,
  ///                    changeSessionsPerWeek, maxChangesPerSession, freezeHoursBeforeEnd,
  ///                    initializationWindowHours }
  rules            Json
  /// Paragraphe d'introduction du règlement — éditable par l'admin, sinon un texte par
  /// défaut est généré à l'affichage à partir des paramètres de la promotion.
  rulesIntro       String?         @db.Text
  /// Notes/règles complémentaires libres, affichées en fin de règlement.
  rulesCustomNotes String?         @db.Text
  /// Snapshot figé du graphique comparatif à la clôture — { points, participantNames,
  /// participantAvatars }, même forme que les props de PromotionPerformanceChart
  /// (initialCapital déjà porté par ce modèle). Écrit une seule fois par
  /// finalizePromotionClosure (src/lib/promotion-lifecycle.ts), jamais modifié ensuite :
  /// lecture totalement indépendante de PerformanceSnapshot / des prix / des concours actifs.
  /// Nul tant que non clôturée, ou clôturée avant l'introduction de ce champ (voir
  /// scripts/backfill-final-chart-snapshot.ts pour le rattrapage).
  finalChartSnapshot Json?
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  users             User[]
  portfolios        Portfolio[]
  changeSessions    ChangeSession[]
  userBadges        UserBadge[]
  hallOfFameEntries HallOfFameEntry[]
  participants      PromotionParticipant[]
}
```

- [ ] **Step 2 : Écrire la migration à la main**

Créer `prisma/migrations/20260915120000_promotion_final_chart_snapshot/migration.sql` :

```sql
-- AlterTable
-- Additive, non destructive : snapshot figé (JSON) du graphique comparatif à la clôture
-- d'une promotion. Nul pour toute promotion pas encore clôturée ou clôturée avant ce champ.
ALTER TABLE "Promotion" ADD COLUMN "finalChartSnapshot" JSONB;
```

- [ ] **Step 3 : Régénérer le client Prisma (local, sans toucher à la base)**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client` — aucune connexion base nécessaire pour cette commande.

- [ ] **Step 4 : Vérifier la compilation TypeScript**

Run: `npx tsc --noEmit`
Expected: exit 0 (le nouveau champ `finalChartSnapshot` est maintenant connu du client généré).

- [ ] **Step 5 : Appliquer la migration à la base (action déclarée, volontaire)**

Run: `npx prisma migrate deploy`
Expected: `Applying migration 20260915120000_promotion_final_chart_snapshot` puis
`All migrations have been successfully applied.` — cette commande écrit réellement sur la base
pointée par `DIRECT_URL`/`.env` (production pour ce projet, comme documenté dans
`prisma.config.ts`). C'est un `ALTER TABLE ADD COLUMN` nullable, additif, sans risque de perte de
données — cohérent avec les migrations précédentes de ce projet (ex. `20260828140000_hall_of_fame_avatar`).

- [ ] **Step 6 : Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260915120000_promotion_final_chart_snapshot
git commit -m "$(cat <<'EOF'
feat: add Promotion.finalChartSnapshot field

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2 : Écriture du snapshot à la clôture — `finalizePromotionClosure`

**Files:**
- Modify: `src/lib/promotion-lifecycle.ts` (imports en tête + corps de `finalizePromotionClosure`,
  insertion après le bloc `if (finalSnapshots.length > 0) { ... }`, ~ligne 111-113)
- Modify: `src/lib/promotion-lifecycle.test.ts`

**Interfaces:**
- Consumes : `getPromotionPerformanceSeries(promotionId: string): Promise<PromotionPerformanceSeries>`
  (existant, `src/lib/gamification/get-promotion-performance-series.ts`) — renvoie
  `{ points: PromotionPerformancePoint[], participantNames: string[] }`.
- Consumes : `avatarByUserId: Map<string, string | null>` et `finalRows` (déjà présents plus haut
  dans la même fonction).
- Produces : l'écriture `db.promotion.updateMany({ where: { id, finalChartSnapshot: null }, data: { finalChartSnapshot: { points, participantNames, participantAvatars } } })`,
  consommée en lecture par Task 3.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `src/lib/promotion-lifecycle.test.ts`, ajouter en tête du fichier (après les autres mocks,
avant la ligne `const { closePromotionIfEnded, ... } = await import(...)`) :

```ts
const getPromotionPerformanceSeriesMock = vi.fn();
vi.mock("@/lib/gamification/get-promotion-performance-series", () => ({
  getPromotionPerformanceSeries: getPromotionPerformanceSeriesMock,
}));
```

Dans `resetMocks()`, remplacer la ligne :

```ts
  [getLeaderboardMock, awardCloseOnlyBadgesMock, revalidateTagMock].forEach((fn) => fn.mockReset());
```

par :

```ts
  [getLeaderboardMock, awardCloseOnlyBadgesMock, revalidateTagMock, getPromotionPerformanceSeriesMock].forEach(
    (fn) => fn.mockReset(),
  );
```

Puis, juste avant la fermeture `}` de `resetMocks()` (après la ligne
`getLeaderboardMock.mockResolvedValue([...]);`), ajouter :

```ts
  getPromotionPerformanceSeriesMock.mockResolvedValue({
    points: [
      {
        date: "2026-08-28",
        label: "28/08/2026",
        values: { Alice: { totalValue: 1_120_000, cumulativeReturnPct: 12, dailyReturnPct: 0 } },
      },
    ],
    participantNames: ["Alice", "Bob"],
  });
```

Ajouter un nouveau `describe` en fin de fichier :

```ts
describe("finalizePromotionClosure — snapshot final du graphique", () => {
  it("écrit finalChartSnapshot une seule fois (garde finalChartSnapshot: null)", async () => {
    await finalizePromotionClosure("promo-1");

    expect(getPromotionPerformanceSeriesMock).toHaveBeenCalledWith("promo-1");
    expect(dbMock.promotion.updateMany).toHaveBeenCalledWith({
      where: { id: "promo-1", finalChartSnapshot: null },
      data: {
        finalChartSnapshot: {
          points: [
            {
              date: "2026-08-28",
              label: "28/08/2026",
              values: { Alice: { totalValue: 1_120_000, cumulativeReturnPct: 12, dailyReturnPct: 0 } },
            },
          ],
          participantNames: ["Alice", "Bob"],
          participantAvatars: { Alice: "data:image/jpeg;base64,alice", Bob: null },
        },
      },
    });
  });

  it("retombe sur null pour un participant absent du classement final (garde-fou)", async () => {
    getPromotionPerformanceSeriesMock.mockResolvedValue({
      points: [],
      participantNames: ["Alice", "Charlie"], // Charlie n'est pas dans getLeaderboardMock
    });

    await finalizePromotionClosure("promo-1");

    const call = dbMock.promotion.updateMany.mock.calls[0][0] as {
      data: { finalChartSnapshot: { participantAvatars: Record<string, string | null> } };
    };
    expect(call.data.finalChartSnapshot.participantAvatars).toEqual({
      Alice: "data:image/jpeg;base64,alice",
      Charlie: null,
    });
  });

  it("appelle getPromotionPerformanceSeries après l'écriture du snapshot terminal (ordre)", async () => {
    const callOrder: string[] = [];
    dbMock.performanceSnapshot.createMany.mockImplementation(async () => {
      callOrder.push("createMany-snapshot-terminal");
      return { count: 2 };
    });
    getPromotionPerformanceSeriesMock.mockImplementation(async () => {
      callOrder.push("getPromotionPerformanceSeries");
      return { points: [], participantNames: [] };
    });

    await finalizePromotionClosure("promo-1");

    expect(callOrder).toEqual(["createMany-snapshot-terminal", "getPromotionPerformanceSeries"]);
  });
});
```

- [ ] **Step 2 : Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run src/lib/promotion-lifecycle.test.ts`
Expected: FAIL — `getPromotionPerformanceSeriesMock` jamais appelé, `dbMock.promotion.updateMany`
jamais appelé avec ces arguments (le code de production n'existe pas encore).

- [ ] **Step 3 : Implémenter**

Dans `src/lib/promotion-lifecycle.ts`, ajouter l'import (après la ligne
`import { awardCloseOnlyBadges } from "@/lib/gamification/award-close-only-badges";`) :

```ts
import { getPromotionPerformanceSeries } from "@/lib/gamification/get-promotion-performance-series";
```

Puis, juste après le bloc existant :

```ts
  if (finalSnapshots.length > 0) {
    await db.performanceSnapshot.createMany({ data: finalSnapshots });
  }
```

et avant le commentaire `// Invalidation best-effort du classement live...`, insérer :

```ts
  // Snapshot figé du graphique comparatif — indépendant de PerformanceSnapshot au sens où,
  // une fois écrit ici, il n'est plus jamais relu depuis cette table : un futur changement de
  // rétention/purge sur les concours actifs ne peut pas l'affecter. Lu après l'écriture du
  // snapshot terminal ci-dessus, donc la courbe se termine exactement à `asOf`. Garde
  // `finalChartSnapshot: null` : write-once, un rejeu (clôture paresseuse, self-heal
  // /resultats, balayage `stuck`) est un no-op sur ce champ.
  const performanceSeries = await getPromotionPerformanceSeries(promotionId);
  const avatarByName = new Map(finalRows.map((row) => [row.name, avatarByUserId.get(row.userId) ?? null]));
  const participantAvatars: Record<string, string | null> = Object.fromEntries(
    performanceSeries.participantNames.map((name) => [name, avatarByName.get(name) ?? null]),
  );
  await db.promotion.updateMany({
    where: { id: promotionId, finalChartSnapshot: null },
    data: {
      finalChartSnapshot: {
        points: performanceSeries.points,
        participantNames: performanceSeries.participantNames,
        participantAvatars,
      },
    },
  });
```

- [ ] **Step 4 : Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run src/lib/promotion-lifecycle.test.ts`
Expected: PASS — tous les tests, y compris les 3 nouveaux.

- [ ] **Step 5 : Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6 : Commit**

```bash
git add src/lib/promotion-lifecycle.ts src/lib/promotion-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat: write immutable final chart snapshot on promotion closure

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3 : Lecture du snapshot — `getFinalChartSnapshot`

**Files:**
- Create: `src/lib/gamification/get-final-chart-snapshot.ts`
- Create: `src/lib/gamification/get-final-chart-snapshot.test.ts`

**Interfaces:**
- Consumes : `db.promotion.findUnique` (Prisma).
- Produces : `getFinalChartSnapshot(promotionId: string): Promise<FinalChartSnapshot | null>` et
  le type `FinalChartSnapshot = { points: PromotionPerformancePoint[]; participantNames: string[]; participantAvatars: Record<string, string | null> }`,
  consommés par Task 4 (page).

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `src/lib/gamification/get-final-chart-snapshot.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = { promotion: { findUnique: vi.fn() } };
vi.mock("@/lib/db", () => ({ db: dbMock }));

const { getFinalChartSnapshot } = await import("./get-final-chart-snapshot");

beforeEach(() => {
  dbMock.promotion.findUnique.mockReset();
});

describe("getFinalChartSnapshot", () => {
  it("renvoie null si le champ est absent (promotion pas encore clôturée)", async () => {
    dbMock.promotion.findUnique.mockResolvedValue({ finalChartSnapshot: null });
    const result = await getFinalChartSnapshot("promo-1");
    expect(result).toBeNull();
  });

  it("renvoie null si la promotion n'existe pas", async () => {
    dbMock.promotion.findUnique.mockResolvedValue(null);
    const result = await getFinalChartSnapshot("promo-1");
    expect(result).toBeNull();
  });

  it("parse et renvoie le snapshot quand il est présent", async () => {
    const snapshot = {
      points: [
        {
          date: "2026-08-28",
          label: "28/08/2026",
          values: { Alice: { totalValue: 1_120_000, cumulativeReturnPct: 12, dailyReturnPct: 0 } },
        },
      ],
      participantNames: ["Alice", "Bob"],
      participantAvatars: { Alice: "data:image/jpeg;base64,alice", Bob: null },
    };
    dbMock.promotion.findUnique.mockResolvedValue({ finalChartSnapshot: snapshot });

    const result = await getFinalChartSnapshot("promo-1");

    expect(result).toEqual(snapshot);
    expect(dbMock.promotion.findUnique).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      select: { finalChartSnapshot: true },
    });
  });

  it("lève si le JSON stocké ne correspond pas au schéma attendu", async () => {
    dbMock.promotion.findUnique.mockResolvedValue({ finalChartSnapshot: { points: "not-an-array" } });
    await expect(getFinalChartSnapshot("promo-1")).rejects.toThrow();
  });
});
```

- [ ] **Step 2 : Lancer le test, vérifier qu'il échoue**

Run: `npx vitest run src/lib/gamification/get-final-chart-snapshot.test.ts`
Expected: FAIL — `Cannot find module './get-final-chart-snapshot'`.

- [ ] **Step 3 : Implémenter**

Créer `src/lib/gamification/get-final-chart-snapshot.ts` :

```ts
import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";

const participantSnapshotMetricsSchema = z.object({
  totalValue: z.number(),
  cumulativeReturnPct: z.number(),
  dailyReturnPct: z.number(),
});

const performancePointSchema = z.object({
  date: z.string(),
  label: z.string(),
  values: z.record(z.string(), participantSnapshotMetricsSchema),
});

const finalChartSnapshotSchema = z.object({
  points: z.array(performancePointSchema),
  participantNames: z.array(z.string()),
  participantAvatars: z.record(z.string(), z.string().nullable()),
});

export type FinalChartSnapshot = z.infer<typeof finalChartSnapshotSchema>;

/**
 * Snapshot figé du graphique comparatif d'une promotion clôturée — écrit une seule fois par
 * finalizePromotionClosure (src/lib/promotion-lifecycle.ts). `null` si la promotion n'est pas
 * encore clôturée, ou a été clôturée avant l'introduction de ce champ et jamais rattrapée (voir
 * scripts/backfill-final-chart-snapshot.ts).
 */
export async function getFinalChartSnapshot(promotionId: string): Promise<FinalChartSnapshot | null> {
  const promotion = await db.promotion.findUnique({
    where: { id: promotionId },
    select: { finalChartSnapshot: true },
  });
  if (!promotion?.finalChartSnapshot) return null;
  return finalChartSnapshotSchema.parse(promotion.finalChartSnapshot);
}
```

- [ ] **Step 4 : Lancer le test, vérifier qu'il passe**

Run: `npx vitest run src/lib/gamification/get-final-chart-snapshot.test.ts`
Expected: PASS — les 4 tests.

- [ ] **Step 5 : Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6 : Commit**

```bash
git add src/lib/gamification/get-final-chart-snapshot.ts src/lib/gamification/get-final-chart-snapshot.test.ts
git commit -m "$(cat <<'EOF'
feat: add getFinalChartSnapshot reader

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4 : Page `/hall-of-fame/[promotionId]/graphique`

**Files:**
- Create: `src/app/hall-of-fame/[promotionId]/graphique/page.tsx`

**Interfaces:**
- Consumes : `getFinalChartSnapshot` (Task 3), `PromotionPerformanceChart` (existant, inchangé,
  `src/app/leaderboard/promotion-performance-chart.tsx`), `verifySession` (`@/lib/dal`),
  `formatParisDateTimeLong` (`@/lib/timezone`), `PromotionStatus` (`@/generated/prisma/enums`).
- Produces : la route `/hall-of-fame/[promotionId]/graphique`, consommée par Task 5 (lien depuis
  le Hall of Fame).

Pas de test automatisé — ce projet n'a aucun test de page (`find src/app -name "*.test.tsx"` ne
renvoie rien) ; la vérification se fait manuellement en Task 7 (navigateur).

- [ ] **Step 1 : Créer la page**

Créer `src/app/hall-of-fame/[promotionId]/graphique/page.tsx` :

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { PromotionStatus } from "@/generated/prisma/enums";
import { getFinalChartSnapshot } from "@/lib/gamification/get-final-chart-snapshot";
import { formatParisDateTimeLong } from "@/lib/timezone";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PromotionPerformanceChart } from "@/app/leaderboard/promotion-performance-chart";

export default async function HallOfFameFinalChartPage({
  params,
}: {
  params: Promise<{ promotionId: string }>;
}) {
  const session = await verifySession();
  const { promotionId } = await params;

  const promotion = await db.promotion.findUnique({
    where: { id: promotionId },
    select: { name: true, initialCapital: true, endDate: true, status: true },
  });
  if (!promotion || promotion.status !== PromotionStatus.CLOSED) {
    notFound();
  }

  const snapshot = await getFinalChartSnapshot(promotionId);

  return (
    <>
      <SiteHeader name={session.user.name} role={session.user.role} avatarUrl={session.user.avatarUrl} />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/hall-of-fame" />}>
          ← Retour au Hall of Fame
        </Button>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{promotion.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Clôturé le {formatParisDateTimeLong(promotion.endDate)}. La performance n&apos;évolue plus.
        </p>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Évolution comparée des participants</CardTitle>
          </CardHeader>
          <CardContent>
            {snapshot ? (
              <PromotionPerformanceChart
                points={snapshot.points}
                participantNames={snapshot.participantNames}
                initialCapital={Number(promotion.initialCapital)}
                participantAvatars={snapshot.participantAvatars}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Historique du graphique indisponible pour cette saison — les données n&apos;ont pas
                été conservées au moment de la clôture.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
```

- [ ] **Step 2 : Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3 : Commit**

```bash
git add src/app/hall-of-fame/[promotionId]/graphique/page.tsx
git commit -m "$(cat <<'EOF'
feat: add final chart page for closed promotions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5 : Bouton "Graphique final" dans le Hall of Fame

**Files:**
- Modify: `src/app/hall-of-fame/page.tsx` (imports + `CardHeader` de la section « Podiums par
  saison », ~ligne 60-65)

**Interfaces:**
- Consumes : `season.promotionId` (déjà présent dans `HallOfFameSeason`, aucun changement de
  `getHallOfFame` nécessaire), route créée en Task 4.

- [ ] **Step 1 : Ajouter les imports**

Dans `src/app/hall-of-fame/page.tsx`, ajouter en tête (après les imports existants) :

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
```

- [ ] **Step 2 : Ajouter le bouton dans l'en-tête de chaque carte de saison**

Remplacer :

```tsx
                <Card key={season.promotionId}>
                  <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle>{season.promotionName}</CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">{formatParisDate(season.closedAt)}</p>
                    </div>
                  </CardHeader>
```

par :

```tsx
                <Card key={season.promotionId}>
                  <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle>{season.promotionName}</CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">{formatParisDate(season.closedAt)}</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/hall-of-fame/${season.promotionId}/graphique`} />}
                    >
                      📈 Graphique final
                    </Button>
                  </CardHeader>
```

- [ ] **Step 3 : Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4 : Commit**

```bash
git add src/app/hall-of-fame/page.tsx
git commit -m "$(cat <<'EOF'
feat: link each Hall of Fame season to its final chart

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6 : Rattrapage générique des promotions déjà closes (Août 2026 inclus)

**Files:**
- Create: `scripts/backfill-final-chart-snapshot.ts`

**Interfaces:**
- Consumes : `db.portfolio`, `db.hallOfFameEntry`, `db.promotion` (Prisma direct, même style que
  `scripts/fix-august-contest.ts` — pas d'import de modules `"server-only"`, donc pas besoin du
  stub `--require` documenté par ailleurs).
- Produces : remplit `Promotion.finalChartSnapshot` pour toute promotion `CLOSED` qui ne l'a pas
  encore (générique — pas limité à Août 2026).

Pas de test automatisé — `scripts/` n'a aucun test dans ce projet (même convention que
`fix-august-contest.ts`, `audit-p1-data.ts`). Vérification par dry-run puis lecture directe
(Steps 3 et 5).

- [ ] **Step 1 : Écrire le script**

Créer `scripts/backfill-final-chart-snapshot.ts` :

```ts
/**
 * Rattrapage générique (pas spécifique à une promotion) : pour toute promotion CLOSED sans
 * `finalChartSnapshot`, reconstruit le snapshot du graphique à partir de l'historique déjà
 * stocké (PerformanceSnapshot) et des avatars déjà figés (HallOfFameEntry) — AUCUNE valeur
 * n'est recalculée depuis les prix ou portefeuilles actuels. Dry-run par défaut ; --commit
 * pour écrire. Rejouable : ne touche que les promotions dont le champ est encore null.
 *
 *   npx tsx scripts/backfill-final-chart-snapshot.ts            # aperçu
 *   npx tsx scripts/backfill-final-chart-snapshot.ts --commit   # applique
 */
import "dotenv/config";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const COMMIT = process.argv.includes("--commit");
const EXPECTED_PROD_REF = "omhyxzfygpiyqobtqltq";

interface SnapshotPoint {
  date: string;
  label: string;
  values: Record<string, { totalValue: number; cumulativeReturnPct: number; dailyReturnPct: number }>;
}

async function buildSnapshot(promotionId: string) {
  const portfolios = await db.portfolio.findMany({
    where: { promotionId },
    include: { user: { select: { name: true } }, snapshots: { orderBy: { timestamp: "asc" } } },
  });

  const pointsByDate = new Map<string, SnapshotPoint>();
  for (const portfolio of portfolios) {
    for (const snap of portfolio.snapshots) {
      const dateKey = snap.timestamp.toISOString().slice(0, 10);
      const point = pointsByDate.get(dateKey) ?? {
        date: dateKey,
        label: snap.timestamp.toLocaleDateString("fr-FR"),
        values: {},
      };
      point.values[portfolio.user.name] = {
        totalValue: Number(snap.totalValue),
        cumulativeReturnPct: Number(snap.cumulativeReturnPct),
        dailyReturnPct: Number(snap.dailyReturnPct),
      };
      pointsByDate.set(dateKey, point);
    }
  }
  const points = [...pointsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const participantNames = portfolios.map((p) => p.user.name);

  const hofEntries = await db.hallOfFameEntry.findMany({ where: { promotionId } });
  const avatarByName = new Map(hofEntries.map((e) => [e.userName, e.avatarUrl]));
  const participantAvatars = Object.fromEntries(
    participantNames.map((name) => [name, avatarByName.get(name) ?? null]),
  );

  return { points, participantNames, participantAvatars };
}

async function main() {
  const ref = (process.env.DATABASE_URL ?? "").match(/postgres\.([a-z0-9]+)/)?.[1];
  console.log(`BASE : ${ref}   (${COMMIT ? "COMMIT" : "dry-run"})\n`);
  if (ref !== EXPECTED_PROD_REF) {
    throw new Error(`Base inattendue (${ref}). Ce script vise ${EXPECTED_PROD_REF}. Abandon.`);
  }

  const closed = await db.promotion.findMany({
    where: { status: "CLOSED" },
    select: { id: true, name: true, finalChartSnapshot: true },
  });
  const missing = closed.filter((p) => p.finalChartSnapshot == null);

  console.log(`${missing.length}/${closed.length} promotion(s) CLOSED sans finalChartSnapshot :`);
  for (const promo of missing) console.log(`  - ${promo.name} (${promo.id})`);

  if (!COMMIT) {
    console.log("\n(dry-run — relancer avec --commit pour appliquer)");
    await db.$disconnect();
    return;
  }

  console.log("\n--- Application ---");
  for (const promo of missing) {
    const snapshot = await buildSnapshot(promo.id);
    console.log(
      `  ${promo.name} : ${snapshot.points.length} point(s), ${snapshot.participantNames.length} participant(s)`,
    );
    await db.promotion.updateMany({
      where: { id: promo.id, finalChartSnapshot: null },
      data: { finalChartSnapshot: snapshot },
    });
    console.log(`  ✓ ${promo.name}`);
  }
  console.log("\nTerminé.");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2 : Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3 : Dry-run contre la base de production**

Run: `npx tsx scripts/backfill-final-chart-snapshot.ts`
Expected : `BASE : omhyxzfygpiyqobtqltq   (dry-run)`, puis la liste des promotions `CLOSED` sans
snapshot — à ce stade, « Promotion Août 2026 » doit y apparaître (Task 1-5 n'ont fait qu'ajouter
la colonne, pas encore la remplir). Vérifier dans la sortie qu'aucune autre promotion inattendue
n'apparaît.

- [ ] **Step 4 : Appliquer (action déclarée, volontaire — confirmer avec l'utilisateur avant de lancer)**

Run: `npx tsx scripts/backfill-final-chart-snapshot.ts --commit`
Expected : pour « Promotion Août 2026 », `23 point(s), 3 participant(s)` (cohérent avec le
diagnostic déjà fait pendant le brainstorming : 23 jours distincts, 3 participants), puis `✓`.

- [ ] **Step 5 : Vérifier par relecture (dry-run à nouveau)**

Run: `npx tsx scripts/backfill-final-chart-snapshot.ts`
Expected: `0/N promotion(s) CLOSED sans finalChartSnapshot` — confirme que le champ est bien
rempli et que le script est maintenant un no-op (rejouabilité).

- [ ] **Step 6 : Commit**

```bash
git add scripts/backfill-final-chart-snapshot.ts
git commit -m "$(cat <<'EOF'
chore: add generic backfill script for final chart snapshots

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7 : Vérification manuelle en navigateur

**Files:** aucun — vérification uniquement, pas de code.

- [ ] **Step 1 : Démarrer le serveur de dev**

Run: `npm run dev` (jamais `npm run build` — voir Global Constraints).

- [ ] **Step 2 : Ouvrir le Hall of Fame**

Naviguer vers `/hall-of-fame` (connecté avec un compte ayant accès — admin, Directeur, ou
participant). Vérifier que la carte de saison « Promotion Août 2026 » affiche bien le bouton
« 📈 Graphique final ».

- [ ] **Step 3 : Ouvrir le graphique final d'Août 2026**

Cliquer sur le bouton. Vérifier sur `/hall-of-fame/[id]/graphique` :
- Le titre affiche « Promotion Août 2026 » et la date de clôture (28/08/2026, 13h00 Paris).
- Le graphique affiche bien 3 lignes (Adam Rouas, Thomas Dziri-Senicourt, Léonard Bernet), avec
  leurs avatars dans la légende.
- La courbe se termine bien au 28/08/2026 (dernier point).
- Les onglets de métriques (Rendement, Valeur, Gain, Rendement journalier, Rang) et le zoom
  (Brush) fonctionnent comme sur `/leaderboard`.
- Le lien « ← Retour au Hall of Fame » fonctionne.

- [ ] **Step 4 : Vérifier le cas « pas de snapshot »**

Si une promotion `CLOSED` existe sans snapshot (aucune actuellement après Task 6, mais utile en
prévision), vérifier que sa page graphique affiche bien le message « Historique du graphique
indisponible... » plutôt que de planter.

- [ ] **Step 5 : Lancer la suite complète de tests**

Run: `npm run test`
Expected: tous les tests passent (existants + nouveaux des Tasks 2 et 3).

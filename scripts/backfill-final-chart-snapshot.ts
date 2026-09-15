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
import { PrismaClient, Prisma } from "@/generated/prisma/client";
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
    const built = await buildSnapshot(promo.id);
    console.log(
      `  ${promo.name} : ${built.points.length} point(s), ${built.participantNames.length} participant(s)`,
    );
    // Typé explicitement avant conversion en InputJsonValue — voir promotion-lifecycle.ts
    // (même limitation TS : cast via `unknown` requis, l'assignation ci-dessous type-checke
    // quand même ce qu'on écrit réellement).
    const snapshot: {
      points: SnapshotPoint[];
      participantNames: string[];
      participantAvatars: Record<string, string | null>;
    } = built;
    await db.promotion.updateMany({
      where: { id: promo.id, finalChartSnapshot: { equals: Prisma.DbNull } },
      data: { finalChartSnapshot: snapshot as unknown as Prisma.InputJsonValue },
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

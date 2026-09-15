import "server-only";
import { revalidateTag } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { PromotionStatus, ChangeSessionStatus } from "@/generated/prisma/enums";
import { getLeaderboard } from "@/lib/gamification/get-leaderboard";
import { awardCloseOnlyBadges } from "@/lib/gamification/award-close-only-badges";
import {
  getPromotionPerformanceSeries,
  type PromotionPerformancePoint,
} from "@/lib/gamification/get-promotion-performance-series";

/**
 * Clôt une promotion si sa date+heure de fin est atteinte. Idempotent et
 * sûr en concurrence : la transition ACTIVE → CLOSED est un `updateMany`
 * conditionnel unique — `count` (0 ou 1) indique si CET appel a réalisé la
 * transition. Seul l'appel gagnant lance la finalisation. Un appel
 * ultérieur (ou concurrent perdant) voit `count: 0` et ne touche à rien.
 */
export async function closePromotionIfEnded(
  promotionId: string,
  now: Date = new Date(),
): Promise<{ closed: boolean }> {
  const { count } = await db.promotion.updateMany({
    where: { id: promotionId, status: PromotionStatus.ACTIVE, endDate: { lte: now } },
    data: { status: PromotionStatus.CLOSED },
  });
  if (count === 0) return { closed: false };

  await finalizePromotionClosure(promotionId);
  return { closed: true };
}

/**
 * Écrit le résultat officiel définitif d'une promotion clôturée. Rejouable
 * sans effet : chaque étape est idempotente (updateMany no-op,
 * `createMany({ skipDuplicates: true })`, awardCloseOnlyBadges upsert) et
 * sûre en concurrence — deux finalisations simultanées (clôture paresseuse +
 * self-heal de /resultats) ne se marchent pas dessus. Horodaté à
 * `min(endDate, now)` : pour la clôture automatique `endDate <= now`, donc
 * `asOf === endDate` (déterministe) ; seule une clôture anticipée par l'admin
 * prend `now`, pour ne pas estampiller une date de fin dans le futur.
 */
export async function finalizePromotionClosure(promotionId: string): Promise<void> {
  const promotion = await db.promotion.findUniqueOrThrow({ where: { id: promotionId } });
  const asOf = new Date(Math.min(promotion.endDate.getTime(), Date.now()));
  const initialCapital = Number(promotion.initialCapital);

  // Ferme toute session de changement encore ouverte (auto ou forcée par l'admin).
  await db.changeSession.updateMany({
    where: { promotionId, status: { not: ChangeSessionStatus.CLOSED } },
    data: { status: ChangeSessionStatus.CLOSED },
  });

  // Classement final, calculé une fois, avec la même logique de rang que
  // partout ailleurs (rankEntries via getLeaderboard). `frozen: true` : chaque
  // position est valorisée au dernier cours connu ≤ asOf — aucun prix postérieur
  // à la fin officielle ne peut fausser le résultat, et un rejeu de cette
  // finalisation (self-heal /resultats, balayage `stuck`) recalcule exactement
  // les mêmes chiffres, même des mois plus tard.
  const finalRows = await getLeaderboard(promotionId, asOf, { frozen: true });

  // Badges de fin de concours (superlatifs + conditions "tout le concours").
  await awardCloseOnlyBadges(promotionId, asOf, finalRows);

  // Snapshot des photos de profil telles qu'elles sont à la clôture — figées
  // dans l'entrée pour que l'historique reste cohérent si la personne change
  // sa photo ensuite. getLeaderboard ne renvoie l'avatar que pour le podium ;
  // on charge donc tous les participants ici.
  const avatarRows = await db.user.findMany({
    where: { id: { in: finalRows.map((row) => row.userId) } },
    select: { id: true, avatarUrl: true },
  });
  const avatarByUserId = new Map(avatarRows.map((row) => [row.id, row.avatarUrl]));

  // Historique figé — une entrée par participant, jamais modifiée si elle
  // existe. `createMany({ skipDuplicates: true })` est atomique : un rejeu
  // (ou une finalisation concurrente) est un no-op grâce à la contrainte
  // unique (promotionId, userId).
  await db.hallOfFameEntry.createMany({
    data: finalRows.map((row) => ({
      promotionId,
      userId: row.userId,
      userName: row.name,
      promotionName: promotion.name,
      finalReturnPct: row.cumulativeReturnPct,
      finalPnlEur: row.totalValue - initialCapital,
      finalRank: row.rank,
      avatarUrl: avatarByUserId.get(row.userId) ?? null,
      closedAt: asOf,
    })),
    skipDuplicates: true,
  });

  // Snapshot de performance terminal, horodaté exactement à `asOf` : point final
  // de la courbe du portefeuille et référence figée pour les vues historiques.
  // `PerformanceSnapshot` n'a pas de contrainte unique — on n'écrit que pour les
  // portefeuilles qui n'ont pas déjà une ligne à cet instant précis (rejouable
  // sans effet). Le cron de snapshot ne tourne plus pour ce concours (filtre
  // status ACTIVE, voir snapshot-service.ts).
  const existingFinal = await db.performanceSnapshot.findMany({
    where: { portfolioId: { in: finalRows.map((row) => row.portfolioId) }, timestamp: asOf },
    select: { portfolioId: true },
  });
  const alreadySnapshotted = new Set(existingFinal.map((row) => row.portfolioId));
  const finalSnapshots = finalRows
    .filter((row) => !alreadySnapshotted.has(row.portfolioId))
    .map((row) => ({
      portfolioId: row.portfolioId,
      timestamp: asOf,
      totalValue: row.totalValue,
      dailyReturnPct: 0,
      cumulativeReturnPct: row.cumulativeReturnPct,
      rank: row.rank,
    }));
  if (finalSnapshots.length > 0) {
    await db.performanceSnapshot.createMany({ data: finalSnapshots });
  }

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
  // Typé explicitement avant conversion en InputJsonValue : Prisma exige un cast via
  // `unknown` ici (limitation TS connue — une interface littérale n'est jamais
  // "comparable" à un type avec signature d'index sans le détour), mais l'assignation
  // à `snapshot` ci-dessous type-checke ce qu'on écrit réellement (une faute de frappe
  // sur un nom de champ serait détectée ici).
  const snapshot: {
    points: PromotionPerformancePoint[];
    participantNames: string[];
    participantAvatars: Record<string, string | null>;
  } = {
    points: performanceSeries.points,
    participantNames: performanceSeries.participantNames,
    participantAvatars,
  };
  await db.promotion.updateMany({
    where: { id: promotionId, finalChartSnapshot: { equals: Prisma.DbNull } },
    data: { finalChartSnapshot: snapshot as unknown as Prisma.InputJsonValue },
  });

  // Invalidation best-effort du classement live (le Hall of Fame n'est plus
  // caché — hall-of-fame.ts lit la table à chaque affichage). `revalidateTag`
  // fonctionne depuis une server action et un route handler, mais lève si
  // finalizePromotionClosure tourne pendant le rendu d'une page (clôture
  // paresseuse). L'écriture ci-dessus est déjà committée — une invalidation
  // manquée signifie juste que le classement se rafraîchit à sa fenêtre de
  // revalidation habituelle au lieu d'instantanément.
  try {
    revalidateTag("leaderboard", "max");
    // Le tableau de bord bascule en valorisation figée (prix ≤ endDate, aucun
    // rafraîchissement) dès que la promotion est CLOSED — invalider son cache
    // pour que le participant voie le résultat officiel sans attendre la
    // fenêtre de revalidation.
    revalidateTag("portfolio-view", "max");
  } catch {
    // rendu RSC : ignoré volontairement, voir ci-dessus
  }
}

/**
 * Balaie toutes les promotions dont la fin est atteinte mais qui sont
 * encore ACTIVE — filet de sécurité appelé par le cron nocturne. Renvoie
 * les ids effectivement clôturés.
 */
export async function closeEndedPromotions(now: Date = new Date()): Promise<string[]> {
  const candidates = await db.promotion.findMany({
    where: { status: PromotionStatus.ACTIVE, endDate: { lte: now } },
    select: { id: true },
  });
  const closed: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await closePromotionIfEnded(candidate.id, now);
      if (result.closed) closed.push(candidate.id);
    } catch {
      // La transition ACTIVE → CLOSED est committée avant que la finalisation
      // puisse lever (API de prix indisponible, timeout…) — le balayage
      // `stuck` ci-dessous la rejoue, et on ne casse pas la page appelante
      // (le Hall of Fame est le seul accès de l'admin aux résultats).
    }
  }

  // Filet de sécurité : promotions déjà CLOSED mais dont la finalisation a été
  // interrompue (aucune entrée Hall of Fame). Rejoué sans effet ; ces ids ne
  // sont pas ajoutés au retour — la transition ACTIVE → CLOSED est déjà faite.
  const stuck = await db.promotion.findMany({
    where: {
      status: PromotionStatus.CLOSED,
      endDate: { lte: now },
      hallOfFameEntries: { none: {} },
    },
    select: { id: true },
  });
  for (const promotion of stuck) {
    await finalizePromotionClosure(promotion.id).catch(() => {});
  }

  return closed;
}

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

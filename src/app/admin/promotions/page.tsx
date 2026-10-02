import Link from "next/link";
import { db } from "@/lib/db";
import { PromotionStatus } from "@/generated/prisma/enums";
import { formatParisDateTime } from "@/lib/timezone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PromotionForm } from "./promotion-form";
import { setPromotionStatus } from "./actions";
import { PromotionRowActions } from "./promotion-row-actions";
import { PromotionStatusActions } from "./promotion-status-actions";

const statusLabels: Record<PromotionStatus, string> = {
  DRAFT: "Brouillon",
  ACTIVE: "En cours",
  CLOSED: "Terminée",
};


export default async function PromotionsPage() {
  const promotions = await db.promotion.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { participants: true, portfolios: true } } },
  });

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle>Nouvelle promotion</CardTitle>
        </CardHeader>
        <CardContent>
          <PromotionForm />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {promotions.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucune promotion pour le moment.</p>
        )}
        {promotions.map((promotion) => {
          return (
            <Card key={promotion.id}>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div>
                  <Link href={`/admin/promotions/${promotion.id}`} className="hover:underline">
                    <CardTitle>{promotion.name}</CardTitle>
                  </Link>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatParisDateTime(promotion.startDate)} →{" "}
                    {formatParisDateTime(promotion.endDate)} ·{" "}
                    {promotion._count.participants} participant(s)
                  </p>
                </div>
                <Badge variant={promotion.status === "ACTIVE" ? "default" : "secondary"}>
                  {statusLabels[promotion.status]}
                </Badge>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" nativeButton={false} render={<Link href={`/admin/promotions/${promotion.id}`} />}>
                  Sessions de changement
                </Button>
                {promotion.status === PromotionStatus.DRAFT && (
                  <form action={setPromotionStatus.bind(null, promotion.id, PromotionStatus.ACTIVE)}>
                    <Button type="submit" variant="outline">
                      Ouvrir la promotion
                    </Button>
                  </form>
                )}
                <PromotionStatusActions promotionId={promotion.id} name={promotion.name} status={promotion.status} />
                <PromotionRowActions
                  promotionId={promotion.id}
                  name={promotion.name}
                  participantCount={promotion._count.participants}
                  portfolioCount={promotion._count.portfolios}
                />
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

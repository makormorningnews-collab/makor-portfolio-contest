import Link from "next/link";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/dal";
import { getHallOfFame } from "@/lib/gamification/hall-of-fame";
import { closeEndedPromotions } from "@/lib/promotion-lifecycle";
import { formatParisDate } from "@/lib/timezone";
import { SiteHeader } from "@/components/site-header";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { signedPct } from "@/app/statistiques/format";
import { HallOfShameSection } from "./hall-of-shame-section";

const medals = ["🥇", "🥈", "🥉"];

export default async function HallOfFamePage() {
  const session = await verifySession();
  // Seul chemin de clôture atteignable par l'admin (sa navigation se limite à
  // Hall of Fame + Admin) : sans ça, un concours terminé n'apparaît jamais ici
  // tant qu'un participant n'a pas chargé son dashboard ou le cron nocturne.
  await closeEndedPromotions();
  const { entries, seasons, participations } = await getHallOfFame(session.user.id);
  const record = entries[0] ?? null;
  const worstRecord = entries.length > 0 ? entries[entries.length - 1] : null;
  const worstEntries = [...entries].reverse();

  return (
    <>
      <SiteHeader name={session.user.name} role={session.user.role} avatarUrl={session.user.avatarUrl} />
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Hall of Fame / Shame</h1>

        {record && (
          <Card className="mt-6 border-primary/40 bg-primary/5">
            <CardHeader>
              <CardTitle>Record historique</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
              <UserAvatar name={record.userName} avatarUrl={record.avatarUrl} className="size-10 shrink-0" />
              <p>
                Meilleure performance jamais enregistrée :{" "}
                <span className="font-semibold text-foreground">{record.userName}</span> avec{" "}
                <span className="font-semibold text-gain">{signedPct(record.finalReturnPct)}</span> lors de «&nbsp;
                {record.promotionName}&nbsp;».
              </p>
            </CardContent>
          </Card>
        )}

        {entries.length === 0 && (
          <p className="mt-6 text-sm text-muted-foreground">
            Aucune saison terminée pour le moment — revenez à la fin du concours en cours.
          </p>
        )}

        {seasons.length > 0 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Podiums par saison</h2>
            <div className="mt-4 flex flex-col gap-4">
              {seasons.map((season) => (
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
                  <CardContent className="flex flex-col gap-1.5">
                    {season.podium.map((e) => (
                      <div
                        key={e.finalRank}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="w-5 shrink-0 text-center">{medals[e.finalRank - 1]}</span>
                          <UserAvatar name={e.userName} avatarUrl={e.avatarUrl} size="sm" className="shrink-0" />
                          <span className="min-w-0 truncate font-medium">{e.userName}</span>
                        </span>
                        <span
                          className={
                            e.finalReturnPct >= 0
                              ? "shrink-0 text-gain tabular-nums"
                              : "shrink-0 text-loss tabular-nums"
                          }
                        >
                          {signedPct(e.finalReturnPct)}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        {entries.length > 0 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Meilleures performances de tous les temps</h2>
            <Card className="mt-4">
              <CardContent className="flex flex-col gap-1.5 pt-6">
                {entries.map((e, i) => (
                  <div
                    key={`${e.promotionId}-${e.finalRank}`}
                    className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0"
                  >
                    <span className="w-6 shrink-0 text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                    <UserAvatar name={e.userName} avatarUrl={e.avatarUrl} size="sm" className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{e.userName}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{e.promotionName}</span>
                    </span>
                    <span
                      className={
                        e.finalReturnPct >= 0
                          ? "shrink-0 text-gain tabular-nums"
                          : "shrink-0 text-loss tabular-nums"
                      }
                    >
                      {signedPct(e.finalReturnPct)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        )}

        {participations.length > 0 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Participations</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {participations.map((p) => (
                <Badge key={p.userName} variant="secondary">
                  {p.userName} · {p.count} concours · record {signedPct(p.bestReturnPct)}
                </Badge>
              ))}
            </div>
          </section>
        )}

        <HallOfShameSection worstRecord={worstRecord} worstEntries={worstEntries} />
      </div>
    </>
  );
}

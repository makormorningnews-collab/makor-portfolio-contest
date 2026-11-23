import { UserAvatar } from "@/components/user-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { signedPct } from "@/app/statistiques/format";
import type { HallOfFameEntryView } from "@/lib/gamification/hall-of-fame";

/**
 * Miroir "pire performance" du Hall of Fame — `worstRecord` est le dernier
 * élément de `entries` (même liste triée par getHallOfFame que le record
 * historique), donc jamais de source de vérité divergente entre les deux
 * moitiés de la page. Volontairement limité à la seule pire performance :
 * pas de classement complet de tous les temps.
 */
export function HallOfShameSection({ worstRecord }: { worstRecord: HallOfFameEntryView | null }) {
  if (!worstRecord) return null;

  return (
    <section className="mt-12" aria-labelledby="hall-of-shame-heading">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span
          id="hall-of-shame-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Hall of Shame
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        Parce que ça aussi, ça fait partie de l&rsquo;histoire.
      </p>

      <Card className="mt-6 ring-loss/30 bg-loss/5">
        <CardHeader>
          <CardTitle>Pire performance historique 🍌</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
          <UserAvatar name={worstRecord.userName} avatarUrl={worstRecord.avatarUrl} className="size-10 shrink-0" />
          <p>
            Pire performance jamais enregistrée :{" "}
            <span className="font-semibold text-foreground">{worstRecord.userName}</span> avec{" "}
            <span className="font-semibold text-loss">{signedPct(worstRecord.finalReturnPct)}</span> lors de «&nbsp;
            {worstRecord.promotionName}&nbsp;».
          </p>
        </CardContent>
      </Card>

    </section>
  );
}

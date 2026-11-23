import type { ReactNode } from "react";
import {
  Trophy,
  Wallet,
  ShieldCheck,
  Scale,
  CalendarClock,
  Lock,
  TrendingUp,
  Users,
  AlertTriangle,
  StickyNote,
  Rocket,
  Info,
} from "lucide-react";
import type { ChangeSessionKind } from "@/generated/prisma/enums";
import type { PromotionRules } from "@/lib/promotion-rules";
import type { ChangeSessionEffectiveStatus } from "@/lib/trading/change-session-status";
import { formatParisDate, formatParisDateTime, formatParisDateTimeLong } from "@/lib/timezone";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const currencyFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function formatDurationHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function formatDurationDays(days: number): string {
  if (days % 7 === 0) return `${days} jours (${days / 7} semaine${days / 7 > 1 ? "s" : ""})`;
  return `${days} jours`;
}

const changeSessionStatusLabels: Record<ChangeSessionEffectiveStatus, string> = {
  SCHEDULED: "Programmée",
  OPEN: "Ouverte",
  CLOSED: "Terminée",
};

function SectionCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </span>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

function InfoBox({ variant = "info", children }: { variant?: "info" | "warning"; children: ReactNode }) {
  const isWarning = variant === "warning";
  return (
    <div
      className={
        isWarning
          ? "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-foreground"
          : "flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm text-foreground"
      }
    >
      {isWarning ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
      )}
      <div>{children}</div>
    </div>
  );
}

export interface RulesDocumentPromotion {
  name: string;
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  rules: PromotionRules;
  rulesIntro: string | null;
  rulesCustomNotes: string | null;
}

export interface RulesDocumentChangeSession {
  id: string;
  kind: ChangeSessionKind;
  opensAt: Date;
  closesAt: Date;
  effectiveStatus: ChangeSessionEffectiveStatus;
  maxChangesPerParticipant: number;
}

/**
 * Règlement du concours — entièrement dérivé des paramètres de la promotion à
 * chaque affichage (jamais stocké en texte figé), pour rester automatiquement
 * cohérent avec toute modification ultérieure des règles. Seuls `rulesIntro`
 * et `rulesCustomNotes` sont du contenu libre édité par l'admin.
 */
export function RulesDocument({
  promotion,
  changeSessions,
}: {
  promotion: RulesDocumentPromotion;
  changeSessions: RulesDocumentChangeSession[];
}) {
  const { rules } = promotion;
  const durationDays = Math.round((promotion.endDate.getTime() - promotion.startDate.getTime()) / 86_400_000);
  const initializationSession = changeSessions.find((session) => session.kind === "INITIALIZATION");
  const weeklySessions = changeSessions
    .filter((session) => session.kind === "WEEKLY")
    .sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
  const cryptoAllowed = rules.maxCryptoPositions > 0;

  const defaultIntro = `Ce document constitue le règlement officiel du concours « ${promotion.name} ». Il est généré automatiquement à partir des paramètres définis par l'administrateur et reflète exactement les règles en vigueur pour cette promotion.`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Règlement officiel</p>
        <h1 className="text-2xl font-semibold tracking-tight">{promotion.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">
            {formatParisDateTimeLong(promotion.startDate)} → {formatParisDateTimeLong(promotion.endDate)}
          </Badge>
          <Badge variant="secondary">{formatDurationDays(durationDays)}</Badge>
          <Badge variant="secondary">Capital initial : {currencyFormatter.format(promotion.initialCapital)}</Badge>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-foreground">{promotion.rulesIntro || defaultIntro}</p>

      <SectionCard icon={<CalendarClock className="size-4.5" />} title="Calendrier du concours">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Début du concours</p>
            <p className="text-foreground">{formatParisDateTimeLong(promotion.startDate)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Fin du concours</p>
            <p className="text-foreground">{formatParisDateTimeLong(promotion.endDate)}</p>
          </div>
        </div>
        <p>
          À l&apos;heure exacte de fin, le concours passe automatiquement en statut «&nbsp;terminé&nbsp;» : plus aucune
          transaction n&apos;est possible, le classement final est figé et publié, et les performances rejoignent le
          Hall of Fame. Toutes les heures sont exprimées en heure de Paris.
        </p>
      </SectionCard>

      <SectionCard icon={<Trophy className="size-4.5" />} title="Objectif et conditions de victoire">
        <p>
          Chaque participant démarre avec un portefeuille fictif de{" "}
          <strong className="text-foreground">{currencyFormatter.format(promotion.initialCapital)}</strong>{" "}
          et doit le faire fructifier au mieux jusqu&apos;au {formatParisDate(promotion.endDate)}.
        </p>
        <p>
          Le classement est calculé uniquement à partir de la{" "}
          <strong className="text-foreground">performance en pourcentage</strong>{" "}
          par rapport au capital initial (valeur totale du compte — capital disponible + positions valorisées au
          dernier prix de marché connu — comparée au capital de départ). Le participant en tête du classement à la
          clôture du concours remporte la saison ; les meilleures performances rejoignent le Hall of Fame.
        </p>
      </SectionCard>

      <SectionCard icon={<ShieldCheck className="size-4.5" />} title="Actifs autorisés et interdits">
        <p>
          Seuls les actifs suivants peuvent être négociés, via le sélecteur de recherche de ticker intégré à la
          plateforme :
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Actions cotées</li>
          <li>
            Cryptomonnaies —{" "}
            {cryptoAllowed
              ? `jusqu'à ${rules.maxCryptoPositions} cryptomonnaie${rules.maxCryptoPositions > 1 ? "s" : ""} distincte${rules.maxCryptoPositions > 1 ? "s" : ""} détenue${rules.maxCryptoPositions > 1 ? "s" : ""} simultanément`
              : "non autorisées pour cette promotion"}
          </li>
        </ul>
        <InfoBox variant="warning">
          Sont exclus par construction de la plateforme : produits dérivés (options, futures), vente à découvert,
          effet de levier, et tout instrument autre que ceux listés ci-dessus. Seuls les ordres d&apos;achat, de
          renforcement et de vente (partielle ou totale) sur une position existante sont possibles.
        </InfoBox>
      </SectionCard>

      <SectionCard icon={<Rocket className="size-4.5" />} title="Constitution du portefeuille initial">
        <p>
          Au lancement du concours, une <strong className="text-foreground">fenêtre de constitution</strong>{" "}
          s&apos;ouvre automatiquement pour une durée de{" "}
          <strong className="text-foreground">{formatDurationHours(rules.initializationWindowHours)}</strong>.{" "}
          Elle sert à choisir vos lignes et à investir l&apos;intégralité du capital initial avant sa fermeture.
          Aucun quota de changements ne s&apos;y applique, mais les achats et les ventes n&apos;y sont{" "}
          <strong className="text-foreground">pas illimités</strong> :
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Ventes : interdites.</strong> Le trading intraday n&apos;est pas
            autorisé pendant la constitution — aucune vente, partielle ou totale, n&apos;est possible. Une ligne
            achetée ne peut être ni revendue ni remplacée avant la prochaine session de changement.
          </li>
          <li>
            <strong className="text-foreground">Achats : limités.</strong> Vous pouvez ouvrir au maximum{" "}
            {rules.maxPositions} lignes et renforcer celles déjà achetées, dans la limite de votre capital
            disponible et des tailles de position (entre {currencyFormatter.format(rules.minPositionSize)} et{" "}
            {currencyFormatter.format(rules.maxPositionSize)} par ligne).
          </li>
        </ul>
        <InfoBox variant="warning">
          Une fois vos lignes choisies, vous ne pouvez plus faire marche arrière jusqu&apos;à la prochaine session de
          changement. Choisissez donc chaque ligne avec soin.
        </InfoBox>
        {initializationSession && (
          <InfoBox>
            Fenêtre {initializationSession.effectiveStatus === "OPEN" ? "actuellement ouverte" : "programmée"} du{" "}
            {formatParisDateTime(initializationSession.opensAt)} au {formatParisDateTime(initializationSession.closesAt)}{" "}
            (heure de Paris).
          </InfoBox>
        )}
        <p>
          Les autres règles du concours (taille de position, nombre maximal de positions, plafond crypto — détaillées
          ci-dessous) s&apos;appliquent déjà pendant cette phase. Une fois la fenêtre fermée, le portefeuille est
          verrouillé jusqu&apos;à l&apos;ouverture de la première session de changement hebdomadaire.
        </p>
      </SectionCard>

      <SectionCard icon={<Scale className="size-4.5" />} title="Contraintes sur les positions">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Taille d&apos;une position : entre{" "}
            <strong className="text-foreground">{currencyFormatter.format(rules.minPositionSize)}</strong> et{" "}
            <strong className="text-foreground">{currencyFormatter.format(rules.maxPositionSize)}</strong>
          </li>
          <li>
            Nombre maximal de positions ouvertes simultanément :{" "}
            <strong className="text-foreground">{rules.maxPositions}</strong>
          </li>
          <li>
            Cryptomonnaies distinctes autorisées :{" "}
            <strong className="text-foreground">{cryptoAllowed ? rules.maxCryptoPositions : "aucune"}</strong>
          </li>
        </ul>
        <p>
          Une vente partielle qui laisserait un reliquat inférieur au minimum de position est refusée — dans ce cas,
          seule une vente totale est possible.
        </p>
      </SectionCard>

      <SectionCard icon={<CalendarClock className="size-4.5" />} title="Sessions de changement hebdomadaires">
        <p>
          Une fois la fenêtre de constitution fermée, les participants ne peuvent modifier leur portefeuille que
          pendant des <strong className="text-foreground">sessions de changement</strong>{" "}
          planifiées par l&apos;administrateur : environ{" "}
          <strong className="text-foreground">
            {rules.changeSessionsPerWeek} session{rules.changeSessionsPerWeek > 1 ? "s" : ""} par semaine
          </strong>
          , avec un maximum de{" "}
          <strong className="text-foreground">
            {rules.maxChangesPerSession} changement{rules.maxChangesPerSession > 1 ? "s" : ""} par participant et par
            session
          </strong>
          . En dehors de ces créneaux, le portefeuille est verrouillé.
        </p>
        <InfoBox>
          <p>
            <strong className="text-foreground">Ce qui compte comme 1 changement :</strong>{" "}
            chaque achat, chaque renforcement d&apos;une position existante, chaque vente partielle et chaque vente
            totale que vous validez consomme 1 changement — quel que soit le type d&apos;opération, indépendamment
            de son montant, et sans lien entre deux opérations successives.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Vendre une position puis en acheter une autre dans la même session : 2 changements (1 pour la vente, 1 pour l&apos;achat).</li>
            <li>Vendre une partie d&apos;une position puis la renforcer à nouveau dans la même session : 2 changements également.</li>
          </ul>
          <p className="mt-2">
            Les changements non utilisés à la fermeture d&apos;une session ne sont pas reportés à la suivante.
          </p>
        </InfoBox>
        {weeklySessions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {weeklySessions.map((session) => (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="text-foreground">{formatParisDate(session.opensAt)}</span>
                <span>
                  {formatParisDateTime(session.opensAt)} → {formatParisDateTime(session.closesAt)}
                </span>
                <Badge variant={session.effectiveStatus === "OPEN" ? "default" : "secondary"}>
                  {changeSessionStatusLabels[session.effectiveStatus]}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard icon={<Lock className="size-4.5" />} title="Gel des positions avant la clôture">
        <p>
          Aucun ordre n&apos;est accepté dans les{" "}
          <strong className="text-foreground">{rules.freezeHoursBeforeEnd} heures</strong>{" "}
          précédant la fin du concours, quelle que soit la session de changement en cours. Cette règle évite un pari
          de dernière minute qui fausserait le classement final : les portefeuilles sont figés en amont pour que le
          résultat reflète une vraie gestion sur la durée.
        </p>
      </SectionCard>

      <SectionCard icon={<TrendingUp className="size-4.5" />} title="Calcul des performances">
        <p>
          La valeur du portefeuille est recalculée en continu à partir du dernier prix de marché connu de chaque
          position ouverte, additionné au capital disponible non investi. La performance affichée (classement, page
          « Portefeuille », Hall of Fame) est l&apos;écart en pourcentage entre cette valeur totale et le capital
          initial de {currencyFormatter.format(promotion.initialCapital)}.
        </p>
        <p>
          Chaque position est valorisée au cours de sa place de cotation, dans la devise de cette place —{" "}
          <strong className="text-foreground">aucune conversion de change n&apos;est appliquée</strong>. Le capital
          et les bornes de position sont exprimés en euros ; les variations de taux de change entre devises ne sont
          pas prises en compte dans le classement.
        </p>
      </SectionCard>

      <SectionCard icon={<Users className="size-4.5" />} title="Équité entre participants">
        <p>
          Tous les participants démarrent avec le même capital initial, sont soumis aux mêmes règles et aux mêmes
          fenêtres de trading. Les sessions de changement s&apos;ouvrent et se ferment aux mêmes horaires pour
          l&apos;ensemble de la promotion — aucun participant ne peut trader en dehors de ces créneaux ni bénéficier
          d&apos;un avantage de calendrier.
        </p>
      </SectionCard>

      <SectionCard icon={<AlertTriangle className="size-4.5" />} title="Conformité et anomalies">
        <p>
          Les règles ci-dessus sont appliquées automatiquement par la plateforme : toute tentative d&apos;opération
          non conforme (montant hors bornes, actif non autorisé, quota de changements atteint, session fermée...) est
          refusée avant même d&apos;être exécutée.
        </p>
        <p>
          En cas d&apos;anomalie constatée a posteriori (erreur de saisie, incident technique), l&apos;administrateur
          dispose d&apos;outils dédiés pour corriger une transaction ou recalculer un portefeuille — sans jamais
          nécessiter de relancer le concours depuis le début.
        </p>
      </SectionCard>

      {promotion.rulesCustomNotes && (
        <SectionCard icon={<StickyNote className="size-4.5" />} title="Notes complémentaires">
          <p className="whitespace-pre-wrap text-foreground">{promotion.rulesCustomNotes}</p>
        </SectionCard>
      )}

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Wallet className="mt-0.5 size-3.5 shrink-0" />
        <p>
          Ce règlement est généré automatiquement à partir des paramètres actuels de la promotion «{" "}
          {promotion.name}{" "}
          » et se met à jour en temps réel si l&apos;administrateur modifie ces paramètres.
        </p>
      </div>
    </div>
  );
}

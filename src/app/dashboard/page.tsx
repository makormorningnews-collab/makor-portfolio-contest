import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { closePromotionIfEnded } from "@/lib/promotion-lifecycle";
import { getCachedPortfolioView } from "@/lib/trading/portfolio-view";
import { getPerformanceHistory } from "@/lib/trading/performance-history";
import { getTransactionHistory } from "@/lib/trading/transaction-history";
import { getUnseenBadges } from "@/lib/gamification/get-unseen-badges";
import { recordDailyVisit } from "@/lib/gamification/record-daily-visit";
import { getOpenChangeSession, getNextScheduledChangeSession, getChangesUsedCount } from "@/lib/trading/execute-order";
import { ChangeSessionKind, PromotionStatus } from "@/generated/prisma/enums";
import { roleHomePath } from "@/lib/auth/role-display";
import { SiteHeader } from "@/components/site-header";
import { UnseenBadgeToaster } from "@/components/badges/unseen-badge-toaster";
import { PortfolioSummary } from "./portfolio-summary";
import { InitializationWindowBanner } from "./initialization-window-banner";
import { ChangeSessionStatusBanner } from "./change-session-status-banner";
import { AutoRefresh } from "@/components/auto-refresh";
import { ContestEndedBanner } from "@/components/contest-ended-banner";

export default async function DashboardPage() {
  const session = await verifySession();
  // Seul un participant a un portefeuille personnel — admin et Directeur ont
  // leurs propres espaces.
  if (session.user.role !== "PARTICIPANT") {
    redirect(roleHomePath(session.user.role));
  }

  const dbUser = await db.user.findUnique({
    where: { id: session.user.id },
    select: { promotionId: true },
  });
  if (dbUser?.promotionId) {
    await closePromotionIfEnded(dbUser.promotionId);
  }

  const promotion = dbUser?.promotionId
    ? await db.promotion.findUnique({
        where: { id: dbUser.promotionId },
        select: { id: true, status: true },
      })
    : null;
  const contestClosed = promotion?.status === PromotionStatus.CLOSED;

  if (contestClosed) {
    const seen = (await cookies()).get(`seen_results_${promotion!.id}`);
    if (!seen) {
      redirect("/resultats");
    }
  }

  const [portfolioView] = await Promise.all([
    getCachedPortfolioView(session.user.id),
    recordDailyVisit(session.user.id),
  ]);

  const [performanceHistory, transactionHistory, unseenBadges, openChangeSession] = portfolioView
    ? await Promise.all([
        getPerformanceHistory(portfolioView.portfolioId),
        getTransactionHistory(portfolioView.portfolioId),
        getUnseenBadges(session.user.id, portfolioView.promotionId),
        getOpenChangeSession(portfolioView.promotionId),
      ])
    : [[], [], [], null];

  const isInitializationWindow = openChangeSession?.kind === ChangeSessionKind.INITIALIZATION;
  const weeklySessionOpen = openChangeSession && !isInitializationWindow ? openChangeSession : null;
  const nextChangeSession =
    portfolioView && !openChangeSession ? await getNextScheduledChangeSession(portfolioView.promotionId) : null;
  const changesUsed = weeklySessionOpen
    ? await getChangesUsedCount(weeklySessionOpen.id, session.user.id)
    : undefined;

  return (
    <>
      {!contestClosed && <AutoRefresh />}
      <SiteHeader name={session.user.name} role={session.user.role} avatarUrl={session.user.avatarUrl} />
      <UnseenBadgeToaster badges={unseenBadges} />
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Mon portefeuille</h1>

        {contestClosed && <ContestEndedBanner />}

        {!contestClosed && isInitializationWindow && portfolioView && (
          <InitializationWindowBanner
            closesAt={openChangeSession.closesAt.toISOString()}
            investedAmount={portfolioView.initialCapital - portfolioView.availableCash}
            initialCapital={portfolioView.initialCapital}
          />
        )}

        {!contestClosed && weeklySessionOpen && (
          <ChangeSessionStatusBanner
            status="OPEN"
            opensAt={weeklySessionOpen.opensAt.toISOString()}
            closesAt={weeklySessionOpen.closesAt.toISOString()}
            changesUsed={changesUsed}
            maxChangesPerParticipant={weeklySessionOpen.maxChangesPerParticipant}
          />
        )}

        {!contestClosed && !isInitializationWindow && !weeklySessionOpen && nextChangeSession && (
          <ChangeSessionStatusBanner
            status="UPCOMING"
            opensAt={nextChangeSession.opensAt.toISOString()}
            closesAt={nextChangeSession.closesAt.toISOString()}
          />
        )}

        {!contestClosed &&
          !isInitializationWindow &&
          !weeklySessionOpen &&
          !nextChangeSession &&
          portfolioView && (
            <p className="mt-4 text-sm text-muted-foreground">
              Aucune session de changement n&apos;est prévue pour le moment — votre portefeuille est verrouillé.
            </p>
          )}

        {!portfolioView && (
          <p className="mt-8 text-sm text-muted-foreground">
            Vous n&apos;êtes pas encore assigné à une promotion, ou votre portefeuille n&apos;a pas
            encore été créé par l&apos;administrateur.
          </p>
        )}

        {portfolioView && (
          <div className="mt-6">
            <PortfolioSummary
              portfolioView={portfolioView}
              performanceHistory={performanceHistory}
              transactionHistory={transactionHistory}
              contestClosed={Boolean(contestClosed)}
              sellDisabled={isInitializationWindow}
            />
          </div>
        )}
      </div>
    </>
  );
}

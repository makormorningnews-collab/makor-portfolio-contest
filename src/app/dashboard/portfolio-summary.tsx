import type { PortfolioView } from "@/lib/trading/portfolio-view";
import type { PerformancePoint } from "@/lib/trading/performance-history";
import type { TransactionHistoryItem } from "@/lib/trading/transaction-history";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BuyForm } from "./buy-form";
import { PositionCard } from "./position-card";
import { PerformanceChart } from "./performance-chart";
import { TransactionHistoryTable } from "./transaction-history-table";

const currencyFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

/**
 * Bloc "portefeuille" complet (indicateurs, graphique, achat, positions,
 * historique) — utilisé par `/dashboard` (le participant lui-même,
 * `readOnly` absent) et par l'espace Directeur (`readOnly` vrai : aucun
 * formulaire d'achat, boutons de vente masqués sur chaque position, exactement
 * comme pour un concours clôturé).
 */
export function PortfolioSummary({
  portfolioView,
  performanceHistory,
  transactionHistory,
  contestClosed,
  readOnly = false,
  sellDisabled = false,
}: {
  portfolioView: PortfolioView;
  performanceHistory: PerformancePoint[];
  transactionHistory: TransactionHistoryItem[];
  contestClosed: boolean;
  readOnly?: boolean;
  /** Vrai pendant la fenêtre de constitution : boutons de vente masqués (ventes interdites, voir rules-engine.ts). */
  sellDisabled?: boolean;
}) {
  const isReadOnly = contestClosed || readOnly;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Capital initial</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {currencyFormatter.format(portfolioView.initialCapital)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Capital disponible</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {currencyFormatter.format(portfolioView.availableCash)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Valeur investie</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {currencyFormatter.format(portfolioView.totalMarketValue)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Valeur du portefeuille</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {currencyFormatter.format(portfolioView.totalValue)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Performance totale</CardTitle>
          </CardHeader>
          <CardContent
            className={`text-2xl font-semibold tabular-nums ${portfolioView.totalGainPct >= 0 ? "text-gain" : "text-loss"}`}
          >
            {portfolioView.totalGainPct >= 0 ? "+" : ""}
            {portfolioView.totalGainPct.toFixed(1)}%
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              ({portfolioView.totalGainEur >= 0 ? "+" : ""}
              {currencyFormatter.format(portfolioView.totalGainEur)})
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Positions</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {portfolioView.positions.length}
            <span className="ml-1 text-base font-normal text-muted-foreground">/ {portfolioView.maxPositions}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Évolution du portefeuille</CardTitle>
        </CardHeader>
        <CardContent>
          <PerformanceChart data={performanceHistory} />
        </CardContent>
      </Card>

      {!isReadOnly && (
        <Card>
          <CardHeader>
            <CardTitle>Nouvel achat</CardTitle>
          </CardHeader>
          <CardContent>
            <BuyForm contestClosed={contestClosed} />
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-4">
        {portfolioView.positions.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucune position ouverte pour le moment.</p>
        )}
        {portfolioView.positions.map((position) => (
          <PositionCard
            key={position.assetId}
            position={position}
            contestClosed={isReadOnly}
            sellDisabled={sellDisabled}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Historique des transactions</CardTitle>
        </CardHeader>
        <CardContent>
          <TransactionHistoryTable transactions={transactionHistory} />
        </CardContent>
      </Card>
    </div>
  );
}

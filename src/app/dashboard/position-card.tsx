"use client";

import { useActionState, useState } from "react";
import { LineChart } from "lucide-react";
import { increasePosition, sellPartial, sellFull, type TradeFormState } from "./actions";
import { useBadgeToast } from "./use-badge-toast";
import type { PositionView } from "@/lib/trading/portfolio-view";
import { formatUnitPrice } from "@/lib/format-price";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { AssetLogo } from "./asset-logo";
import { PositionPriceChart } from "./position-price-chart";

const initialState: TradeFormState = {};
const currencyFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function PerformanceBadge({ pct }: { pct: number }) {
  return (
    <Badge
      variant="outline"
      className={pct >= 0 ? "border-gain/30 bg-gain/10 text-gain" : "border-loss/30 bg-loss/10 text-loss"}
    >
      {signed(pct)}
    </Badge>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${className ?? ""}`}>{value}</span>
    </div>
  );
}

export function PositionCard({
  position,
  contestClosed = false,
  sellDisabled = false,
}: {
  position: PositionView;
  contestClosed?: boolean;
  /** Fenêtre de constitution : seuls achats et renforcements sont permis (voir rules-engine.ts). */
  sellDisabled?: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "increase" | "sell">("idle");
  const [isChartOpen, setIsChartOpen] = useState(false);

  const [increaseState, increaseFormAction, increasePending] = useActionState(increasePosition, initialState);
  const [sellState, sellFormAction, sellPending] = useActionState(sellPartial, initialState);
  const sellFullAction = sellFull.bind(null, position.assetId);
  const [sellFullState, sellFullFormAction, sellFullPending] = useActionState(sellFullAction, initialState);
  useBadgeToast(increaseState);
  useBadgeToast(sellState);
  useBadgeToast(sellFullState);

  const isPositive = position.pnl >= 0;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AssetLogo symbol={position.symbol} logoUrl={position.logoUrl} className="size-9" />
          <div>
            <CardTitle>
              {position.symbol} <span className="text-sm font-normal text-muted-foreground">{position.name}</span>
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {position.quantity.toFixed(4)} unités · {position.allocationPct.toFixed(1)}% du portefeuille
            </p>
          </div>
        </div>
        <div className="flex items-start gap-1">
          <div className="text-right">
            <p className={`text-lg font-semibold tabular-nums ${isPositive ? "text-gain" : "text-loss"}`}>
              {currencyFormatter.format(position.actualValue)}
            </p>
            <div className="mt-1 flex items-center justify-end gap-2">
              {position.dailyChangePct !== null && (
                <span className={`text-xs tabular-nums ${position.dailyChangePct >= 0 ? "text-gain" : "text-loss"}`}>
                  {signed(position.dailyChangePct)} 24h
                </span>
              )}
              <PerformanceBadge pct={position.pnlPct} />
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Voir le graphique de cours de ${position.symbol}`}
            onClick={() => setIsChartOpen(true)}
          >
            <LineChart />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-4">
          <Stat label="Prix moyen" value={formatUnitPrice(position.avgEntryPrice)} />
          <Stat label="Prix actuel" value={formatUnitPrice(position.currentPrice)} />
          <Stat label="Valeur d'entrée" value={currencyFormatter.format(position.entryValue)} />
          <Stat
            label="Plus/moins-value"
            value={`${isPositive ? "+" : ""}${currencyFormatter.format(position.pnl)}`}
            className={isPositive ? "text-gain" : "text-loss"}
          />
        </div>

        {!contestClosed && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setMode(mode === "increase" ? "idle" : "increase")}>
              Renforcer
            </Button>
            {!sellDisabled && (
              <>
                <Button variant="outline" size="sm" onClick={() => setMode(mode === "sell" ? "idle" : "sell")}>
                  Vendre une partie
                </Button>
                <form action={sellFullFormAction}>
                  <Button type="submit" variant="destructive" size="sm" disabled={sellFullPending}>
                    Vendre tout
                  </Button>
                </form>
              </>
            )}
          </div>
        )}

        {!contestClosed && mode === "increase" && (
          <form action={increaseFormAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="assetId" value={position.assetId} />
            <Input name="amount" type="number" placeholder="Montant (€)" required className="w-full sm:w-40" />
            <Button type="submit" size="sm" disabled={increasePending}>
              Confirmer
            </Button>
          </form>
        )}
        {!contestClosed && !sellDisabled && mode === "sell" && (
          <form action={sellFormAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="assetId" value={position.assetId} />
            <Input name="quantity" type="number" step="any" placeholder="Quantité" required className="w-full sm:w-40" />
            <Button type="submit" size="sm" disabled={sellPending}>
              Confirmer
            </Button>
          </form>
        )}

        {!contestClosed && (increaseState.error || sellState.error || sellFullState.error) && (
          <p className="text-sm text-destructive">
            {increaseState.error ?? sellState.error ?? sellFullState.error}
          </p>
        )}
      </CardContent>

      <Sheet open={isChartOpen} onOpenChange={setIsChartOpen}>
        <SheetContent>
          <SheetHeader>
            <div className="flex items-center gap-2">
              <AssetLogo symbol={position.symbol} logoUrl={position.logoUrl} className="size-8" />
              <div>
                <SheetTitle>
                  {position.symbol} <span className="font-normal text-muted-foreground">{position.name}</span>
                </SheetTitle>
                <SheetDescription>Évolution du cours et performance depuis l&apos;achat</SheetDescription>
              </div>
            </div>
          </SheetHeader>
          <PositionPriceChart
            assetId={position.assetId}
            symbol={position.symbol}
            avgEntryPrice={position.avgEntryPrice}
            currentPrice={position.currentPrice}
            openedAt={position.openedAt}
            isOpen={isChartOpen}
          />
        </SheetContent>
      </Sheet>
    </Card>
  );
}

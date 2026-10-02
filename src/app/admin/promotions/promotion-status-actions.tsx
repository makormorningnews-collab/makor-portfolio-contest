"use client";

import { useState } from "react";
import { PromotionStatus } from "@/generated/prisma/enums";
import { setPromotionStatus, reopenPromotion } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PromotionStatusActionsProps {
  promotionId: string;
  name: string;
  status: PromotionStatus;
}

/**
 * Clôture et réouverture d'une promotion, chacune derrière une confirmation :
 * la clôture se déclenchait auparavant en un seul clic, sans retour possible.
 */
export function PromotionStatusActions({ promotionId, name, status }: PromotionStatusActionsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === PromotionStatus.DRAFT) return null;
  const closing = status === PromotionStatus.ACTIVE;

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      if (closing) {
        await setPromotionStatus(promotionId, PromotionStatus.CLOSED);
        setOpen(false);
      } else {
        const result = await reopenPromotion(promotionId);
        if (result.error) setError(result.error);
        else setOpen(false);
      }
    } catch {
      setError(closing ? "La clôture a échoué. Réessayez." : "La réouverture a échoué. Réessayez.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        {closing ? "Clôturer la promotion" : "Rouvrir la promotion"}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{closing ? `Clôturer ${name} ?` : `Rouvrir ${name} ?`}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {closing ? (
            <>
              <p className="text-sm text-muted-foreground">
                Le concours s&apos;arrête <strong>immédiatement</strong>, avant sa date de fin :
              </p>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                <li>plus aucun participant ne peut modifier son portefeuille ;</li>
                <li>toutes les sessions de changement sont fermées, y compris celles à venir ;</li>
                <li>le classement final, le Hall of Fame et les badges de fin de concours sont figés.</li>
              </ul>
              <p className="text-sm text-muted-foreground">
                En cas d&apos;erreur, le bouton « Rouvrir la promotion » permet d&apos;annuler la clôture.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">La clôture est annulée et le concours reprend :</p>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                <li>les participants retrouvent l&apos;accès à leur portefeuille ;</li>
                <li>les sessions de changement reprennent leur calendrier normal ;</li>
                <li>
                  le classement final, les entrées Hall of Fame et les badges de fin de concours écrits à la clôture
                  sont retirés : ils seront recalculés à la vraie fin du concours.
                </li>
              </ul>
              <p className="text-sm text-muted-foreground">
                Les portefeuilles, positions et transactions n&apos;ont jamais été modifiés par la clôture.
              </p>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              variant={closing ? "destructive" : "default"}
              size="sm"
              disabled={pending}
              onClick={handleConfirm}
            >
              {pending
                ? closing
                  ? "Clôture..."
                  : "Réouverture..."
                : closing
                  ? "Clôturer définitivement"
                  : "Rouvrir la promotion"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

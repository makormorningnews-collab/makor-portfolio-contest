-- AlterTable
-- Additive, non destructive : snapshot figé (JSON) du graphique comparatif à la clôture
-- d'une promotion. Nul pour toute promotion pas encore clôturée ou clôturée avant ce champ.
ALTER TABLE "Promotion" ADD COLUMN "finalChartSnapshot" JSONB;

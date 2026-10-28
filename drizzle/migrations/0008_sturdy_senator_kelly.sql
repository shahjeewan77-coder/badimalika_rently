ALTER TABLE "stock_movements" ADD COLUMN "reversal_of_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "note" text;--> statement-breakpoint
CREATE UNIQUE INDEX "movements_reversal_uq" ON "stock_movements" USING btree ("reversal_of_id");
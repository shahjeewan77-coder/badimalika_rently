ALTER TABLE "vehicles" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "vehicles_owner_active_idx" ON "vehicles" USING btree ("owner_id","is_active");
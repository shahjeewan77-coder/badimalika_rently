ALTER TABLE "stock_movements" ADD COLUMN "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "actor_name" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;
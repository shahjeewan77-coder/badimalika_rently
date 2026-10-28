ALTER TABLE "drivers" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "transit_vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_transit_vehicle_id_vehicles_id_fk" FOREIGN KEY ("transit_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;
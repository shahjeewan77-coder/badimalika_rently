CREATE TABLE "trip_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"order_id" uuid,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy" double precision,
	"speed" double precision,
	"heading" double precision,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "trip_locations" ADD CONSTRAINT "trip_locations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_locations" ADD CONSTRAINT "trip_locations_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_locations" ADD CONSTRAINT "trip_locations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_locations_owner_idx" ON "trip_locations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "trip_locations_driver_idx" ON "trip_locations" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "trip_locations_order_idx" ON "trip_locations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "trip_locations_recorded_idx" ON "trip_locations" USING btree ("recorded_at");
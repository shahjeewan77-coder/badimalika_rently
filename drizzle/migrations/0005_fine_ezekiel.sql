CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_name" text,
	"actor_role" text DEFAULT 'owner' NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"target_id" text,
	"target_label" text,
	"summary" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "created_by_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "transited_by_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dispatched_by_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_owner_idx" ON "audit_log" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_driver_id_drivers_id_fk" FOREIGN KEY ("created_by_driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_transited_by_driver_id_drivers_id_fk" FOREIGN KEY ("transited_by_driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_dispatched_by_driver_id_drivers_id_fk" FOREIGN KEY ("dispatched_by_driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;
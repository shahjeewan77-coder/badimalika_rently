ALTER TABLE "profiles" ADD COLUMN "username" text;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_username_uq" ON "profiles" USING btree ("username");
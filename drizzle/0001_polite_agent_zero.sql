CREATE TABLE "transfer_queue_meta_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'configuration' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone
);

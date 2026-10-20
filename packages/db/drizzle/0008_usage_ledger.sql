CREATE TABLE "usage_events" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "usage_events_counts_ck" CHECK ("usage_events"."input_tokens" >= 0 and "usage_events"."output_tokens" >= 0 and "usage_events"."cache_read_input_tokens" >= 0 and "usage_events"."cache_write_input_tokens" >= 0 and "usage_events"."cost_usd" >= 0),
	CONSTRAINT "usage_events_purpose_ck" CHECK ("usage_events"."purpose" in ('triage', 'reply', 'extract', 'summarise', 'judge', 'embed'))
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "route_complexity_threshold" real DEFAULT 0.6 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "route_min_confidence" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cost_governor_step" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cost_governor_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_tenant_created_idx" ON "usage_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_route_complexity_threshold_ck" CHECK ("tenants"."route_complexity_threshold" between 0 and 1);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_route_min_confidence_ck" CHECK ("tenants"."route_min_confidence" between 0 and 1);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_cost_governor_step_ck" CHECK ("tenants"."cost_governor_step" between 0 and 3);
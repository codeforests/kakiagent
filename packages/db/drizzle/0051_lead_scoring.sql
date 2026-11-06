ALTER TABLE "lead_settings" ADD COLUMN "qualification" jsonb DEFAULT '{"keywords":[],"minBudget":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "score" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "score_points" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "score_reasons" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "hot_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leads_tenant_status_updated_idx" ON "leads" USING btree ("tenant_id","status","updated_at" DESC NULLS LAST,"id");--> statement-breakpoint
ALTER TABLE "lead_settings" ADD CONSTRAINT "lead_settings_qualification_ck" CHECK (jsonb_typeof("lead_settings"."qualification") = 'object');--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_score_ck" CHECK ("leads"."score" is null or "leads"."score" in ('hot', 'warm', 'cold'));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_score_reasons_ck" CHECK ("leads"."score_reasons" is null or jsonb_typeof("leads"."score_reasons") = 'array');--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_scored_ck" CHECK (("leads"."score" is null and "leads"."score_points" is null and "leads"."score_reasons" is null and "leads"."scored_at" is null) or ("leads"."score" is not null and "leads"."score_points" is not null and "leads"."score_reasons" is not null and "leads"."scored_at" is not null));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_version_ck" CHECK ("leads"."version" >= 1);--> statement-breakpoint
-- FEAT-050 §4, hand-written: column grants per zone. The visitor zone scores on capture (and
-- already reads the contact's conversations and messages under tenant isolation, so no
-- lead_intents() is needed); the dashboard zone moves status and rescores on a criteria save.
-- Nobody gains delete, and neither zone gains the other's columns.
GRANT UPDATE (score, score_points, score_reasons, scored_at, hot_alerted_at) ON leads TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (status, version, status_changed_at, updated_at, score, score_points, score_reasons, scored_at) ON leads TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (qualification) ON lead_settings TO app_dashboard;

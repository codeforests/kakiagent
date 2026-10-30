CREATE TABLE "boundary_rules" (
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"allowed_topics" text[] DEFAULT '{}' NOT NULL,
	"blocked_topics" text[] DEFAULT '{}' NOT NULL,
	"max_discount_pct" smallint DEFAULT 0 NOT NULL,
	"quotes_need_approval" boolean DEFAULT true NOT NULL,
	"forbidden_commitments" text[] DEFAULT '{delivery_guarantee,refund,legal_advice,medical_advice}' NOT NULL,
	"custom_commitments" text[] DEFAULT '{}' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boundary_rules_tenant_id_version_pk" PRIMARY KEY("tenant_id","version"),
	CONSTRAINT "boundary_rules_version_ck" CHECK ("boundary_rules"."version" > 0),
	CONSTRAINT "boundary_rules_discount_ck" CHECK ("boundary_rules"."max_discount_pct" between 0 and 100),
	CONSTRAINT "boundary_rules_commitments_ck" CHECK ("boundary_rules"."forbidden_commitments" <@ array['delivery_guarantee','refund','legal_advice','medical_advice']::text[] and "boundary_rules"."forbidden_commitments" @> array['legal_advice','medical_advice']::text[]),
	CONSTRAINT "boundary_rules_sizes_ck" CHECK (cardinality("boundary_rules"."allowed_topics") <= 25 and cardinality("boundary_rules"."blocked_topics") <= 25 and cardinality("boundary_rules"."custom_commitments") <= 10)
);
--> statement-breakpoint
ALTER TABLE "boundary_rules" ADD CONSTRAINT "boundary_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- FEAT-054 §4: hand-written RLS and grants. Versions are immutable (D1): the dashboard may
-- insert but never update or delete them; the visitor role reads the version in force.
ALTER TABLE boundary_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE boundary_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON boundary_rules USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT ON boundary_rules TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON boundary_rules TO app_agent_visitor;

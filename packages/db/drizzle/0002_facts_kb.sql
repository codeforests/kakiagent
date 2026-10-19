CREATE TABLE "business_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"gst_registered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_versions" (
	"tenant_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"value" jsonb NOT NULL,
	"gst_treatment" text,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_versions_tenant_id_fact_id_version_pk" PRIMARY KEY("tenant_id","fact_id","version")
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"value" jsonb NOT NULL,
	"gst_treatment" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"valid_until" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "facts_type_ck" CHECK ("facts"."type" in ('product', 'faq')),
	CONSTRAINT "facts_status_ck" CHECK ("facts"."status" in ('needs_review', 'approved', 'rejected', 'conflicted', 'disabled')),
	CONSTRAINT "facts_gst_ck" CHECK (("facts"."type" = 'product') = ("facts"."gst_treatment" is not null) and ("facts"."gst_treatment" is null or "facts"."gst_treatment" in ('inclusive', 'exclusive', 'unknown')))
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"fact_id" uuid NOT NULL,
	"fact_version" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_chunks_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "fact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "disclosure" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ai_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_versions" ADD CONSTRAINT "fact_versions_tenant_id_fact_id_facts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","fact_id") REFERENCES "public"."facts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_tenant_id_fact_id_facts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","fact_id") REFERENCES "public"."facts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facts_tenant_status_updated_idx" ON "facts" USING btree ("tenant_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "kb_chunks_fact_uq" ON "kb_chunks" USING btree ("tenant_id","fact_id");
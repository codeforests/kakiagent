CREATE TABLE "kb_source_pages" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"status" text NOT NULL,
	"reason" text,
	"http_status" smallint,
	"content" text,
	"content_hash" text,
	"extracted_at" timestamp with time zone,
	"facts_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_source_pages_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "kb_source_pages_status_ck" CHECK ("kb_source_pages"."status" in ('included', 'excluded', 'failed', 'skipped')),
	CONSTRAINT "kb_source_pages_reason_ck" CHECK (("kb_source_pages"."status" = 'included') = ("kb_source_pages"."reason" is null) and ("kb_source_pages"."reason" is null or "kb_source_pages"."reason" in ('robots', 'off_domain_redirect', 'not_html', 'duplicate', 'timeout', 'http_error', 'blocked_address', 'load_error', 'plan_limit')))
);
--> statement-breakpoint
CREATE TABLE "kb_sources" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"subdomains" text[] DEFAULT '{}'::text[] NOT NULL,
	"page_limit" integer NOT NULL,
	"failure" text,
	"pages_found" integer DEFAULT 0 NOT NULL,
	"pages_included" integer DEFAULT 0 NOT NULL,
	"pages_excluded" integer DEFAULT 0 NOT NULL,
	"pages_failed" integer DEFAULT 0 NOT NULL,
	"pages_skipped" integer DEFAULT 0 NOT NULL,
	"pages_extracted" integer DEFAULT 0 NOT NULL,
	"facts_count" integer DEFAULT 0 NOT NULL,
	"attested_by" text NOT NULL,
	"attested_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "kb_sources_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "kb_sources_kind_ck" CHECK ("kb_sources"."kind" in ('website')),
	CONSTRAINT "kb_sources_status_ck" CHECK ("kb_sources"."status" in ('queued', 'processing', 'ready', 'failed')),
	CONSTRAINT "kb_sources_stage_ck" CHECK ("kb_sources"."stage" is null or "kb_sources"."stage" in ('crawl', 'extract', 'promote')),
	CONSTRAINT "kb_sources_failure_ck" CHECK (("kb_sources"."status" = 'failed') = ("kb_sources"."failure" is not null) and ("kb_sources"."failure" is null or "kb_sources"."failure" in ('no_pages', 'site_unreachable', 'extraction_unavailable', 'internal'))),
	CONSTRAINT "kb_sources_counts_ck" CHECK ("kb_sources"."page_limit" > 0 and "kb_sources"."attempt" >= 1 and least("kb_sources"."pages_found", "kb_sources"."pages_included", "kb_sources"."pages_excluded", "kb_sources"."pages_failed", "kb_sources"."pages_skipped", "kb_sources"."pages_extracted", "kb_sources"."facts_count") >= 0)
);
--> statement-breakpoint
CREATE TABLE "kb_staged_facts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"page_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" jsonb NOT NULL,
	"gst_treatment" text,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"confidence" real NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_staged_facts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "kb_staged_facts_type_ck" CHECK ("kb_staged_facts"."type" in ('product', 'faq', 'policy', 'promotion')),
	CONSTRAINT "kb_staged_facts_quote_ck" CHECK ("kb_staged_facts"."confidence" between 0 and 1 and "kb_staged_facts"."quote_start" >= 0 and "kb_staged_facts"."quote_end" > "kb_staged_facts"."quote_start")
);
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "kb_source_pages" ADD CONSTRAINT "kb_source_pages_tenant_id_source_id_kb_sources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."kb_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_staged_facts" ADD CONSTRAINT "kb_staged_facts_tenant_id_page_id_kb_source_pages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","page_id") REFERENCES "public"."kb_source_pages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_source_pages_url_uq" ON "kb_source_pages" USING btree ("tenant_id","source_id","attempt","url");--> statement-breakpoint
CREATE INDEX "kb_source_pages_seq_idx" ON "kb_source_pages" USING btree ("tenant_id","source_id","attempt","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_sources_domain_uq" ON "kb_sources" USING btree ("tenant_id","kind","domain");--> statement-breakpoint
CREATE INDEX "kb_staged_facts_source_idx" ON "kb_staged_facts" USING btree ("tenant_id","source_id","attempt");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_tenant_id_source_id_kb_sources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."kb_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facts_tenant_source_idx" ON "facts" USING btree ("tenant_id","source_id");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_provenance_ck" CHECK ("facts"."source_id" is null or ("facts"."provenance" is not null and "facts"."confidence" between 0 and 1));
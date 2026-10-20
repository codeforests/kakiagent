ALTER TABLE "facts" DROP CONSTRAINT "facts_type_ck";--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_gst_ck";--> statement-breakpoint
ALTER TABLE "fact_versions" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fact_versions" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "facts_tenant_updated_idx" ON "facts" USING btree ("tenant_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_validity_ck" CHECK (("facts"."type" <> 'promotion' or "facts"."valid_until" is not null) and ("facts"."valid_from" is null or "facts"."valid_until" is null or "facts"."valid_from" < "facts"."valid_until"));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_type_ck" CHECK ("facts"."type" in ('product', 'faq', 'policy', 'promotion'));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_gst_ck" CHECK (("facts"."gst_treatment" is null or "facts"."gst_treatment" in ('inclusive', 'exclusive', 'unknown')) and (("facts"."type" = 'product' and "facts"."gst_treatment" is not null) or ("facts"."type" in ('faq', 'policy') and "facts"."gst_treatment" is null) or ("facts"."type" = 'promotion' and ("facts"."value" ? 'priceCents') = ("facts"."gst_treatment" is not null))));
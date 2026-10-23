ALTER TABLE "kb_source_pages" DROP CONSTRAINT "kb_source_pages_reason_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_file_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_file_type_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_kind_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_stage_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_failure_ck";--> statement-breakpoint
ALTER TABLE "kb_source_pages" ADD COLUMN "cells" text[];--> statement-breakpoint
ALTER TABLE "kb_sources" ADD COLUMN "sheet" jsonb;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD COLUMN "mapping" jsonb;--> statement-breakpoint
ALTER TABLE "kb_source_pages" ADD CONSTRAINT "kb_source_pages_cells_ck" CHECK ("kb_source_pages"."cells" is null or cardinality("kb_source_pages"."cells") <= 50);--> statement-breakpoint
ALTER TABLE "kb_source_pages" ADD CONSTRAINT "kb_source_pages_reason_ck" CHECK (("kb_source_pages"."status" = 'included') = ("kb_source_pages"."reason" is null) and ("kb_source_pages"."reason" is null or "kb_source_pages"."reason" in ('robots', 'off_domain_redirect', 'not_html', 'duplicate', 'timeout', 'http_error', 'blocked_address', 'load_error', 'plan_limit', 'no_text', 'page_limit', 'ocr_limit', 'empty_row', 'no_name', 'no_price', 'bad_price', 'not_sgd', 'bad_stock', 'too_long')));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_sheet_type_ck" CHECK ("kb_sources"."file_type" is null or ("kb_sources"."kind" = 'spreadsheet') = ("kb_sources"."file_type" in ('xlsx', 'csv')));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_mapping_ck" CHECK ("kb_sources"."mapping" is null or "kb_sources"."kind" = 'spreadsheet');--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_file_ck" CHECK ("kb_sources"."kind" not in ('file', 'spreadsheet') or ("kb_sources"."upload_key" is not null and "kb_sources"."file_size" > 0));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_file_type_ck" CHECK ("kb_sources"."file_type" is null or "kb_sources"."file_type" in ('pdf', 'docx', 'pptx', 'txt', 'jpeg', 'png', 'xlsx', 'csv'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_kind_ck" CHECK ("kb_sources"."kind" in ('website', 'file', 'spreadsheet'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_stage_ck" CHECK ("kb_sources"."stage" is null or "kb_sources"."stage" in ('scan', 'parse', 'map', 'import', 'crawl', 'extract', 'promote'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_failure_ck" CHECK (("kb_sources"."status" = 'failed') = ("kb_sources"."failure" is not null) and ("kb_sources"."failure" is null or "kb_sources"."failure" in ('no_pages', 'site_unreachable', 'extraction_unavailable', 'internal', 'upload_missing', 'too_large', 'unsupported_type', 'encrypted', 'malware', 'scan_unavailable', 'unreadable', 'no_text', 'no_rows', 'no_valid_rows')));
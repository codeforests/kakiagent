ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_file_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_file_type_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_kind_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" DROP CONSTRAINT "kb_sources_failure_ck";--> statement-breakpoint
ALTER TABLE "kb_sources" ADD COLUMN "chat" jsonb;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_chat_type_ck" CHECK ("kb_sources"."kind" <> 'chat' or "kb_sources"."file_type" is null or "kb_sources"."file_type" in ('txt', 'json', 'zip'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_chat_ck" CHECK ("kb_sources"."chat" is null or "kb_sources"."kind" = 'chat');--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_file_ck" CHECK ("kb_sources"."kind" not in ('file', 'spreadsheet', 'chat') or ("kb_sources"."upload_key" is not null and "kb_sources"."file_size" > 0));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_file_type_ck" CHECK ("kb_sources"."file_type" is null or "kb_sources"."file_type" in ('pdf', 'docx', 'pptx', 'txt', 'jpeg', 'png', 'xlsx', 'csv', 'json', 'zip'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_kind_ck" CHECK ("kb_sources"."kind" in ('website', 'file', 'spreadsheet', 'chat'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_failure_ck" CHECK (("kb_sources"."status" = 'failed') = ("kb_sources"."failure" is not null) and ("kb_sources"."failure" is null or "kb_sources"."failure" in ('no_pages', 'site_unreachable', 'extraction_unavailable', 'internal', 'upload_missing', 'too_large', 'unsupported_type', 'encrypted', 'malware', 'scan_unavailable', 'unreadable', 'no_text', 'no_rows', 'no_valid_rows', 'chat_format', 'business_not_found')));
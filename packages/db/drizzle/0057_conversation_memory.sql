CREATE TABLE "conversation_summaries" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"upto_seq" bigint NOT NULL,
	"memory" jsonb NOT NULL,
	"messages_folded" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_summaries_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "conversation_summaries_memory_ck" CHECK (jsonb_typeof("conversation_summaries"."memory") = 'object' and octet_length("conversation_summaries"."memory"::text) <= 4000),
	CONSTRAINT "conversation_summaries_folded_ck" CHECK ("conversation_summaries"."messages_folded" > 0 and "conversation_summaries"."upto_seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_summaries_upto_uq" ON "conversation_summaries" USING btree ("tenant_id","conversation_id","upto_seq");--> statement-breakpoint

-- FEAT-026 §4, hand-written: RLS and grants. Append-only (D3): no UPDATE or DELETE grant;
-- rows go only by cascade with their conversation.
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversation_summaries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_summaries USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The agent-worker folds (insert) and visitor turns read; suggested replies and replay read.
GRANT SELECT, INSERT ON conversation_summaries TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON conversation_summaries TO app_dashboard;

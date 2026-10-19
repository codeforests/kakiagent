CREATE TABLE "audit_events" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"visitor_id" uuid NOT NULL,
	"status" text DEFAULT 'ai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"author" text NOT NULL,
	"body" text NOT NULL,
	"client_message_id" text,
	"in_reply_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"group_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"widget_key" text NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_widget_key_unique" UNIQUE("widget_key")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_conversation_id_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_seq_idx" ON "audit_events" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "conversations_tenant_last_message_idx" ON "conversations" USING btree ("tenant_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_tenant_conversation_seq_idx" ON "messages" USING btree ("tenant_id","conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_message_id_uq" ON "messages" USING btree ("tenant_id","conversation_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_in_reply_to_uq" ON "messages" USING btree ("tenant_id","in_reply_to");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."dispatched_at" is null;
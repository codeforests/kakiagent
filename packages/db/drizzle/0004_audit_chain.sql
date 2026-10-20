CREATE TABLE "audit_entries" (
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"ts" timestamp (3) with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_ref" text,
	"event_type" text NOT NULL,
	"subject_refs" text[] NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pii_ref" uuid,
	"pii_commitment" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_entries_tenant_id_seq_pk" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "audit_entries_actor_type_check" CHECK ("audit_entries"."actor_type" in ('agent', 'user', 'operator', 'system', 'visitor')),
	CONSTRAINT "audit_entries_pii_pair" CHECK (("audit_entries"."pii_ref" is null) = ("audit_entries"."pii_commitment" is null)),
	CONSTRAINT "audit_entries_hash_format" CHECK ("audit_entries"."hash" ~ '^[0-9a-f]{64}$' and "audit_entries"."prev_hash" ~ '^[0-9a-f]{64}$' and ("audit_entries"."pii_commitment" is null or "audit_entries"."pii_commitment" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "audit_entries_seq_positive" CHECK ("audit_entries"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_heads" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"anchored_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_pii" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"salt" "bytea" NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_pii_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
DROP TABLE "audit_events" CASCADE;--> statement-breakpoint
CREATE INDEX "audit_entries_tenant_ts_idx" ON "audit_entries" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "audit_entries_subject_refs_idx" ON "audit_entries" USING gin ("subject_refs");--> statement-breakpoint
CREATE INDEX "audit_pii_contact_idx" ON "audit_pii" USING btree ("tenant_id","contact_id");
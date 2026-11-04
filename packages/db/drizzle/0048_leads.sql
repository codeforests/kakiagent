CREATE TABLE "consents" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"purpose" text NOT NULL,
	"decision" text NOT NULL,
	"wording_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "consents_purpose_ck" CHECK ("consents"."purpose" in ('enquiry', 'marketing')),
	CONSTRAINT "consents_decision_ck" CHECK ("consents"."decision" in ('agreed', 'declined')),
	CONSTRAINT "consents_channel_ck" CHECK ("consents"."channel" in ('widget')),
	CONSTRAINT "consents_declined_ck" CHECK ("consents"."decision" = 'agreed' or "consents"."contact_id" is null or "consents"."purpose" = 'marketing')
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contacts_name_ck" CHECK ("contacts"."name" is null or char_length("contacts"."name") between 1 and 120),
	CONSTRAINT "contacts_phone_ck" CHECK ("contacts"."phone" is null or "contacts"."phone" ~ '^[+]65[3689][0-9]{7}$'),
	CONSTRAINT "contacts_email_ck" CHECK ("contacts"."email" is null or (char_length("contacts"."email") <= 254 and "contacts"."email" = lower("contacts"."email") and "contacts"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'))
);
--> statement-breakpoint
CREATE TABLE "lead_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"fields" jsonb NOT NULL,
	"marketing_enabled" boolean DEFAULT false NOT NULL,
	"marketing_wording_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_settings_fields_ck" CHECK (jsonb_typeof("lead_settings"."fields") = 'array'),
	CONSTRAINT "lead_settings_marketing_ck" CHECK (not "lead_settings"."marketing_enabled" or "lead_settings"."marketing_wording_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"need" text,
	"budget" text,
	"preferred_time" text,
	"captures" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "leads_status_ck" CHECK ("leads"."status" in ('new', 'contacted', 'won', 'lost')),
	CONSTRAINT "leads_captures_ck" CHECK ("leads"."captures" >= 1),
	CONSTRAINT "leads_text_ck" CHECK (("leads"."need" is null or char_length("leads"."need") <= 1000) and ("leads"."budget" is null or char_length("leads"."budget") <= 120) and ("leads"."preferred_time" is null or char_length("leads"."preferred_time") <= 120))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "wording_versions" DROP CONSTRAINT "wording_versions_kind_ck";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_wording_fk" FOREIGN KEY ("tenant_id","wording_id") REFERENCES "public"."wording_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_settings" ADD CONSTRAINT "lead_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_settings" ADD CONSTRAINT "lead_settings_marketing_fk" FOREIGN KEY ("tenant_id","marketing_wording_id") REFERENCES "public"."wording_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_consent_fk" FOREIGN KEY ("tenant_id","consent_id") REFERENCES "public"."consents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_conversation_idx" ON "consents" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "consents_contact_idx" ON "consents" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_uq" ON "contacts" USING btree ("tenant_id","email") WHERE "contacts"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_uq" ON "contacts" USING btree ("tenant_id","phone") WHERE "contacts"."phone" is not null;--> statement-breakpoint
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING gin ("tenant_id","name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_email_trgm_idx" ON "contacts" USING gin ("tenant_id","email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_phone_trgm_idx" ON "contacts" USING gin ("tenant_id","phone" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "leads_one_open_uq" ON "leads" USING btree ("tenant_id","contact_id") WHERE "leads"."status" in ('new', 'contacted');--> statement-breakpoint
CREATE INDEX "leads_conversation_idx" ON "leads" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "leads_tenant_updated_idx" ON "leads" USING btree ("tenant_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "audit_pii" ADD CONSTRAINT "audit_pii_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("tenant_id","contact_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_ck" CHECK ("messages"."card" is null or ("messages"."author" = 'agent' and "messages"."card"->>'kind' in ('consent', 'lead_form')));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left', 'escalated', 'lead_captured')));--> statement-breakpoint
ALTER TABLE "wording_versions" ADD CONSTRAINT "wording_versions_kind_ck" CHECK ("wording_versions"."kind" in ('privacy_notice', 'purpose_statement', 'marketing_consent'));--> statement-breakpoint

-- FEAT-049 §4, hand-written: RLS, grants, the visitor read and contact search.
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON contacts USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE consents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON consents USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE leads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON leads USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE lead_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE lead_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON lead_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The visitor zone captures (§5.1): consents are append-only (D5), contact_id set once at submit.
GRANT SELECT, INSERT ON contacts, consents, leads TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (name, email, phone, updated_at) ON contacts TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (contact_id) ON consents TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (need, budget, preferred_time, conversation_id, consent_id, captures, updated_at) ON leads TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON lead_settings TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (contact_id) ON conversations TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON contacts, consents, leads TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT ON lead_settings TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (version, fields, marketing_enabled, marketing_wording_id, updated_at) ON lead_settings TO app_dashboard;--> statement-breakpoint
-- The visitor zone reads wordings only through visitor_privacy() (FEAT-058): it now also returns
-- the current marketing wording (only while the opt-in is on, D3) and the lead fields.
GRANT SELECT ON lead_settings TO kaki_tenant_state;--> statement-breakpoint
DROP FUNCTION visitor_privacy();--> statement-breakpoint
CREATE FUNCTION visitor_privacy()
  RETURNS TABLE (
    notice jsonb, notice_wording_id uuid, notice_saved_at timestamptz,
    purpose jsonb, purpose_wording_id uuid, business_name text, uen text,
    marketing jsonb, marketing_wording_id uuid, lead_fields jsonb, industry text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT n.content, n.id, n.created_at, p.content, p.id, t.name, bp.uen,
      m.content, m.id, ls.fields, bp.industry
    FROM tenants t
      LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
      LEFT JOIN privacy_settings ps ON ps.tenant_id = t.id
      LEFT JOIN wording_versions n ON n.tenant_id = t.id AND n.id = ps.notice_wording_id
      LEFT JOIN wording_versions p ON p.tenant_id = t.id AND p.id = ps.purpose_wording_id
      LEFT JOIN lead_settings ls ON ls.tenant_id = t.id
      LEFT JOIN wording_versions m ON m.tenant_id = t.id AND m.id = ls.marketing_wording_id AND ls.marketing_enabled
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_privacy() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_privacy() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_privacy() TO app_agent_visitor;--> statement-breakpoint
-- Contact search (§5.5, the 0047 pattern): conversations whose contact's name, email or phone
-- matches, for the current tenant only, with the first field that matched.
GRANT SELECT (tenant_id, id, name, email, phone) ON contacts TO kaki_inbox_search;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id) ON conversations TO kaki_inbox_search;--> statement-breakpoint
CREATE POLICY inbox_search_read ON contacts FOR SELECT TO kaki_inbox_search USING (true);--> statement-breakpoint
CREATE POLICY inbox_search_read ON conversations FOR SELECT TO kaki_inbox_search USING (true);--> statement-breakpoint
CREATE FUNCTION inbox_contact_hits(patterns text[])
  RETURNS TABLE (tenant_id uuid, conversation_id uuid, field text, value text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  ROWS 100
  AS $$
    SELECT c.tenant_id, c.id,
      CASE WHEN k.name ILIKE ANY (patterns) THEN 'name'
           WHEN k.email ILIKE ANY (patterns) THEN 'email'
           ELSE 'phone' END,
      CASE WHEN k.name ILIKE ANY (patterns) THEN k.name
           WHEN k.email ILIKE ANY (patterns) THEN k.email
           ELSE k.phone END
    FROM contacts k
      JOIN conversations c ON c.tenant_id = k.tenant_id AND c.contact_id = k.id
    WHERE k.tenant_id = app_current_tenant()
      AND (k.name ILIKE ANY (patterns) OR k.email ILIKE ANY (patterns) OR k.phone ILIKE ANY (patterns))
  $$;--> statement-breakpoint
ALTER FUNCTION inbox_contact_hits(text[]) OWNER TO kaki_inbox_search;--> statement-breakpoint
REVOKE ALL ON FUNCTION inbox_contact_hits(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION inbox_contact_hits(text[]) TO app_dashboard;

CREATE TABLE "contact_identities" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identities_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contact_identities_kind_ck" CHECK ("contact_identities"."kind" in ('email', 'phone', 'telegram')),
	CONSTRAINT "contact_identities_source_ck" CHECK ("contact_identities"."source" in ('email', 'telegram', 'lead_form')),
	CONSTRAINT "contact_identities_telegram_ck" CHECK ("contact_identities"."kind" <> 'telegram' or ("contact_identities"."source" = 'telegram' and "contact_identities"."verified_at" is not null and "contact_identities"."value" ~ '^[0-9]{1,20}$')),
	CONSTRAINT "contact_identities_lead_form_ck" CHECK ("contact_identities"."source" <> 'lead_form' or "contact_identities"."verified_at" is null),
	CONSTRAINT "contact_identities_phone_ck" CHECK ("contact_identities"."kind" <> 'phone' or "contact_identities"."value" ~ '^[+]65[3689][0-9]{7}$'),
	CONSTRAINT "contact_identities_email_ck" CHECK ("contact_identities"."kind" <> 'email' or (char_length("contact_identities"."value") <= 254 and "contact_identities"."value" = lower("contact_identities"."value") and "contact_identities"."value" ~ '^[^@[:space:]]+@[^@[:space:]]+$'))
);
--> statement-breakpoint
CREATE TABLE "contact_merges" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"automatic" boolean NOT NULL,
	"by_user_id" uuid,
	"moved" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	CONSTRAINT "contact_merges_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contact_merges_distinct_ck" CHECK ("contact_merges"."survivor_id" <> "contact_merges"."merged_id"),
	CONSTRAINT "contact_merges_moved_ck" CHECK (jsonb_typeof("contact_merges"."moved") = 'object')
);
--> statement-breakpoint
DROP INDEX "contacts_telegram_uq";--> statement-breakpoint
DROP INDEX "contacts_email_uq";--> statement-breakpoint
DROP INDEX "contacts_phone_uq";--> statement-breakpoint
DROP INDEX "leads_one_open_uq";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_survivor_fk" FOREIGN KEY ("tenant_id","survivor_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_merged_fk" FOREIGN KEY ("tenant_id","merged_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identities_verified_uq" ON "contact_identities" USING btree ("tenant_id","kind","value") WHERE "contact_identities"."verified_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identities_email_uq" ON "contact_identities" USING btree ("tenant_id","value") WHERE "contact_identities"."kind" = 'email' and "contact_identities"."source" = 'email' and "contact_identities"."verified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identities_row_uq" ON "contact_identities" USING btree ("tenant_id","contact_id","kind","value","source");--> statement-breakpoint
CREATE INDEX "contact_identities_lookup_idx" ON "contact_identities" USING btree ("tenant_id","kind","value");--> statement-breakpoint
CREATE INDEX "contact_merges_survivor_idx" ON "contact_merges" USING btree ("tenant_id","survivor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_merges_merged_idx" ON "contact_merges" USING btree ("tenant_id","merged_id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_fk" FOREIGN KEY ("tenant_id","merged_into") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_superseded_by_fk" FOREIGN KEY ("tenant_id","superseded_by") REFERENCES "public"."leads"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_one_open_uq" ON "leads" USING btree ("tenant_id","contact_id") WHERE "leads"."status" in ('new', 'contacted') and "leads"."superseded_by" is null;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_ck" CHECK (("contacts"."merged_into" is null) = ("contacts"."merged_at" is null));--> statement-breakpoint

-- FEAT-039 §4, hand-written: RLS, grants, the merge functions and the backfill.
ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_identities USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE contact_merges ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_merges FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_merges USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The channel writers add identities; the dashboard reads them and the merge history.
GRANT SELECT, INSERT ON contact_identities TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON contact_identities TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON contact_merges TO app_agent_visitor, app_dashboard;--> statement-breakpoint
-- Consents stay append-only for the app roles: the visitor zone may link a consent to its contact
-- once (lead capture), never re-key a linked one. Merges re-key them only through contact_merge().
CREATE POLICY consents_link_once ON consents AS RESTRICTIVE FOR UPDATE TO app_agent_visitor USING (contact_id IS NULL) WITH CHECK (true);--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_contact_merge') THEN
    CREATE ROLE kaki_contact_merge NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, name, email, phone, telegram_id, telegram_username, merged_into, merged_at, created_at),
  UPDATE (name, email, phone, telegram_id, telegram_username, merged_into, merged_at, updated_at) ON contacts TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id), UPDATE (contact_id) ON conversations TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id), UPDATE (contact_id) ON consents TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, status, superseded_by), UPDATE (contact_id, superseded_by) ON leads TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, chat_id, contact_id), UPDATE (contact_id) ON telegram_chats TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id), UPDATE (contact_id) ON audit_pii TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, kind, value, source), UPDATE (contact_id) ON contact_identities TO kaki_contact_merge;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (undone_at, undone_by) ON contact_merges TO kaki_contact_merge;--> statement-breakpoint

-- contact_merge (§5.3): merges `merged` into `survivor` for the current tenant and returns the
-- merge ID. Every moved row ID and filled display column goes into `moved`, so undo is exact.
-- SQLSTATE KC000 not found (or another tenant's), KC001 same contact, KC002 already merged away.
CREATE FUNCTION contact_merge(survivor uuid, merged uuid, automatic boolean, actor uuid)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    t uuid := app_current_tenant();
    n integer;
    s_merged uuid; m_merged uuid;
    s_open uuid; m_open uuid;
    filled text[] := '{}';
    col text;
    s_val text; m_val text;
    moved jsonb;
    merge_id uuid;
  BEGIN
    IF survivor = merged THEN
      RAISE EXCEPTION 'contact_merge: same contact' USING ERRCODE = 'KC001';
    END IF;
    PERFORM 1 FROM contacts WHERE tenant_id = t AND id IN (survivor, merged) ORDER BY id FOR UPDATE;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF t IS NULL OR n <> 2 THEN
      RAISE EXCEPTION 'contact_merge: contact not found' USING ERRCODE = 'KC000';
    END IF;
    SELECT merged_into INTO s_merged FROM contacts WHERE tenant_id = t AND id = survivor;
    SELECT merged_into INTO m_merged FROM contacts WHERE tenant_id = t AND id = merged;
    IF s_merged IS NOT NULL OR m_merged IS NOT NULL THEN
      RAISE EXCEPTION 'contact_merge: contact merged away' USING ERRCODE = 'KC002';
    END IF;

    -- Two open leads: the merged contact's is superseded by the survivor's (D6).
    SELECT id INTO s_open FROM leads WHERE tenant_id = t AND contact_id = survivor
      AND status IN ('new', 'contacted') AND superseded_by IS NULL;
    SELECT id INTO m_open FROM leads WHERE tenant_id = t AND contact_id = merged
      AND status IN ('new', 'contacted') AND superseded_by IS NULL;
    IF s_open IS NOT NULL AND m_open IS NOT NULL THEN
      UPDATE leads SET superseded_by = s_open WHERE tenant_id = t AND id = m_open;
    ELSE
      m_open := NULL;
    END IF;

    -- Fill each empty survivor display value from the merged contact.
    FOREACH col IN ARRAY ARRAY['name', 'email', 'phone', 'telegram_id', 'telegram_username'] LOOP
      EXECUTE format('SELECT %1$I::text FROM contacts WHERE tenant_id = $1 AND id = $2', col)
        INTO s_val USING t, survivor;
      EXECUTE format('SELECT %1$I::text FROM contacts WHERE tenant_id = $1 AND id = $2', col)
        INTO m_val USING t, merged;
      IF s_val IS NULL AND m_val IS NOT NULL THEN
        EXECUTE format('UPDATE contacts SET %1$I = (SELECT %1$I FROM contacts WHERE tenant_id = $1 AND id = $3) WHERE tenant_id = $1 AND id = $2', col)
          USING t, survivor, merged;
        filled := filled || col;
      END IF;
    END LOOP;

    WITH c AS (UPDATE conversations SET contact_id = survivor WHERE tenant_id = t AND contact_id = merged RETURNING id),
      k AS (UPDATE consents SET contact_id = survivor WHERE tenant_id = t AND contact_id = merged RETURNING id),
      l AS (UPDATE leads SET contact_id = survivor WHERE tenant_id = t AND contact_id = merged RETURNING id),
      g AS (UPDATE telegram_chats SET contact_id = survivor WHERE tenant_id = t AND contact_id = merged RETURNING chat_id),
      p AS (UPDATE audit_pii SET contact_id = survivor WHERE tenant_id = t AND contact_id = merged RETURNING id),
      i AS (UPDATE contact_identities x SET contact_id = survivor
              WHERE x.tenant_id = t AND x.contact_id = merged
                AND NOT EXISTS (SELECT 1 FROM contact_identities y
                  WHERE y.tenant_id = t AND y.contact_id = survivor
                    AND y.kind = x.kind AND y.value = x.value AND y.source = x.source)
              RETURNING x.id)
    SELECT jsonb_build_object(
        'conversations', (SELECT coalesce(jsonb_agg(id), '[]') FROM c),
        'consents', (SELECT coalesce(jsonb_agg(id), '[]') FROM k),
        'leads', (SELECT coalesce(jsonb_agg(id), '[]') FROM l),
        'telegram_chats', (SELECT coalesce(jsonb_agg(chat_id), '[]') FROM g),
        'audit_pii', (SELECT coalesce(jsonb_agg(id), '[]') FROM p),
        'identities', (SELECT coalesce(jsonb_agg(id), '[]') FROM i),
        'superseded', m_open,
        'filled', to_jsonb(filled))
      INTO moved;

    UPDATE contacts SET merged_into = survivor, merged_at = now() WHERE tenant_id = t AND id = merged;
    UPDATE contacts SET updated_at = now() WHERE tenant_id = t AND id = survivor;
    INSERT INTO contact_merges (tenant_id, survivor_id, merged_id, automatic, by_user_id, moved)
      VALUES (t, survivor, merged, automatic, actor, moved)
      RETURNING id INTO merge_id;
    RETURN merge_id;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION contact_merge(uuid, uuid, boolean, uuid) OWNER TO kaki_contact_merge;--> statement-breakpoint
REVOKE ALL ON FUNCTION contact_merge(uuid, uuid, boolean, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION contact_merge(uuid, uuid, boolean, uuid) TO app_dashboard, app_agent_visitor;--> statement-breakpoint

-- contact_unmerge (§5.3, D7): moves back exactly the rows the merge moved; rows created since
-- stay with the survivor. Returns the restored contact's ID.
-- SQLSTATE KC000 not found, KC003 already undone, KC004 the survivor was merged away since.
CREATE FUNCTION contact_unmerge(merge uuid, actor uuid)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    t uuid := app_current_tenant();
    r record;
    s_merged uuid;
    col text;
  BEGIN
    SELECT id, survivor_id, merged_id, moved, undone_at INTO r FROM contact_merges
      WHERE tenant_id = t AND id = merge FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'contact_unmerge: merge not found' USING ERRCODE = 'KC000';
    END IF;
    IF r.undone_at IS NOT NULL THEN
      RAISE EXCEPTION 'contact_unmerge: already undone' USING ERRCODE = 'KC003';
    END IF;
    PERFORM 1 FROM contacts WHERE tenant_id = t AND id IN (r.survivor_id, r.merged_id) ORDER BY id FOR UPDATE;
    SELECT merged_into INTO s_merged FROM contacts WHERE tenant_id = t AND id = r.survivor_id;
    IF s_merged IS NOT NULL THEN
      RAISE EXCEPTION 'contact_unmerge: survivor merged away' USING ERRCODE = 'KC004';
    END IF;

    UPDATE conversations SET contact_id = r.merged_id WHERE tenant_id = t AND contact_id = r.survivor_id
      AND id IN (SELECT jsonb_array_elements_text(r.moved -> 'conversations')::uuid);
    UPDATE consents SET contact_id = r.merged_id WHERE tenant_id = t AND contact_id = r.survivor_id
      AND id IN (SELECT jsonb_array_elements_text(r.moved -> 'consents')::uuid);
    UPDATE leads SET contact_id = r.merged_id WHERE tenant_id = t AND contact_id = r.survivor_id
      AND id IN (SELECT jsonb_array_elements_text(r.moved -> 'leads')::uuid);
    UPDATE leads SET superseded_by = NULL WHERE tenant_id = t
      AND id = (r.moved ->> 'superseded')::uuid AND superseded_by IS NOT NULL;
    UPDATE telegram_chats SET contact_id = r.merged_id WHERE tenant_id = t AND contact_id = r.survivor_id
      AND chat_id IN (SELECT jsonb_array_elements_text(r.moved -> 'telegram_chats')::bigint);
    UPDATE audit_pii SET contact_id = r.merged_id WHERE tenant_id = t AND contact_id = r.survivor_id
      AND id IN (SELECT jsonb_array_elements_text(r.moved -> 'audit_pii')::uuid);
    UPDATE contact_identities SET contact_id = r.merged_id WHERE tenant_id = t AND contact_id = r.survivor_id
      AND id IN (SELECT jsonb_array_elements_text(r.moved -> 'identities')::uuid);
    -- A filled display value is cleared only while it still holds what the merge copied.
    FOR col IN SELECT jsonb_array_elements_text(r.moved -> 'filled') LOOP
      EXECUTE format('UPDATE contacts s SET %1$I = NULL FROM contacts m
          WHERE s.tenant_id = $1 AND s.id = $2 AND m.tenant_id = $1 AND m.id = $3
            AND s.%1$I IS NOT DISTINCT FROM m.%1$I', col)
        USING t, r.survivor_id, r.merged_id;
    END LOOP;

    UPDATE contacts SET merged_into = NULL, merged_at = NULL WHERE tenant_id = t AND id = r.merged_id;
    UPDATE contacts SET updated_at = now() WHERE tenant_id = t AND id = r.survivor_id;
    UPDATE contact_merges SET undone_at = now(), undone_by = actor WHERE tenant_id = t AND id = merge;
    RETURN r.merged_id;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION contact_unmerge(uuid, uuid) OWNER TO kaki_contact_merge;--> statement-breakpoint
REVOKE ALL ON FUNCTION contact_unmerge(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION contact_unmerge(uuid, uuid) TO app_dashboard, app_agent_visitor;--> statement-breakpoint

-- Backfill (§4): existing identifiers become identities. Forced RLS would hide every row from the
-- migration owner, so it is lifted for these three tables inside this transaction only.
ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversations NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_identities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO contact_identities (tenant_id, contact_id, kind, value, source, verified_at, created_at)
  SELECT tenant_id, id, 'telegram', telegram_id::text, 'telegram', created_at, created_at
  FROM contacts WHERE telegram_id IS NOT NULL;--> statement-breakpoint
INSERT INTO contact_identities (tenant_id, contact_id, kind, value, source, created_at)
  SELECT k.tenant_id, k.id, 'email', k.email,
    CASE WHEN EXISTS (SELECT 1 FROM conversations c
      WHERE c.tenant_id = k.tenant_id AND c.contact_id = k.id AND c.channel = 'email')
      THEN 'email' ELSE 'lead_form' END,
    k.created_at
  FROM contacts k WHERE k.email IS NOT NULL;--> statement-breakpoint
INSERT INTO contact_identities (tenant_id, contact_id, kind, value, source, created_at)
  SELECT tenant_id, id, 'phone', phone, 'lead_form', created_at
  FROM contacts WHERE phone IS NOT NULL;--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;

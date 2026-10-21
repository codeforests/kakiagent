CREATE TABLE "assistant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"bot_name" text,
	"tone" text DEFAULT 'friendly' NOT NULL,
	"emoji" boolean DEFAULT false NOT NULL,
	"greeting_en" text,
	"greeting_zh" text,
	"disclosure_note_en" text,
	"disclosure_note_zh" text,
	"after_hours_en" text,
	"after_hours_zh" text,
	"fallback_en" text,
	"fallback_zh" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_settings_tone_ck" CHECK ("assistant_settings"."tone" in ('friendly', 'professional')),
	CONSTRAINT "assistant_settings_bot_name_ck" CHECK ("assistant_settings"."bot_name" is null or (char_length("assistant_settings"."bot_name") between 1 and 30 and "assistant_settings"."bot_name" !~ '[0-9]' and btrim("assistant_settings"."bot_name") = "assistant_settings"."bot_name")),
	CONSTRAINT "assistant_settings_texts_ck" CHECK (("assistant_settings"."greeting_en" is null or (btrim("assistant_settings"."greeting_en") <> '' and char_length("assistant_settings"."greeting_en") <= 200)) and ("assistant_settings"."greeting_zh" is null or (btrim("assistant_settings"."greeting_zh") <> '' and char_length("assistant_settings"."greeting_zh") <= 200)) and ("assistant_settings"."disclosure_note_en" is null or (btrim("assistant_settings"."disclosure_note_en") <> '' and char_length("assistant_settings"."disclosure_note_en") <= 200)) and ("assistant_settings"."disclosure_note_zh" is null or (btrim("assistant_settings"."disclosure_note_zh") <> '' and char_length("assistant_settings"."disclosure_note_zh") <= 200)) and ("assistant_settings"."after_hours_en" is null or (btrim("assistant_settings"."after_hours_en") <> '' and char_length("assistant_settings"."after_hours_en") <= 300)) and ("assistant_settings"."after_hours_zh" is null or (btrim("assistant_settings"."after_hours_zh") <> '' and char_length("assistant_settings"."after_hours_zh") <= 300)) and ("assistant_settings"."fallback_en" is null or (btrim("assistant_settings"."fallback_en") <> '' and char_length("assistant_settings"."fallback_en") <= 300)) and ("assistant_settings"."fallback_zh" is null or (btrim("assistant_settings"."fallback_zh") <> '' and char_length("assistant_settings"."fallback_zh") <= 300)))
);
--> statement-breakpoint
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
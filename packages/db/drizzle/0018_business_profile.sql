CREATE TABLE "holidays" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_tenant_id_day_pk" PRIMARY KEY("tenant_id","day"),
	CONSTRAINT "holidays_kind_ck" CHECK ("holidays"."kind" in ('open', 'closed')),
	CONSTRAINT "holidays_label_ck" CHECK ("holidays"."label" is null or (btrim("holidays"."label") <> '' and char_length("holidays"."label") <= 60))
);
--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "uen" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "languages" text[] DEFAULT '{en}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_uen_ck" CHECK ("business_profiles"."uen" is null or "business_profiles"."uen" ~ '^([0-9]{8}[A-Z]|(18|19|20)[0-9]{7}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$');--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_industry_ck" CHECK ("business_profiles"."industry" is null or "business_profiles"."industry" in ('fnb', 'retail', 'beauty_wellness', 'education', 'professional_services', 'home_services', 'other'));--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_phone_ck" CHECK ("business_profiles"."contact_phone" is null or "business_profiles"."contact_phone" ~ '^[+]65[3689][0-9]{7}$');--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_email_ck" CHECK ("business_profiles"."contact_email" is null or (char_length("business_profiles"."contact_email") <= 254 and "business_profiles"."contact_email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'));--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_languages_ck" CHECK (cardinality("business_profiles"."languages") between 1 and 4 and "business_profiles"."languages" <@ '{en,zh,ms,ta}'::text[]);
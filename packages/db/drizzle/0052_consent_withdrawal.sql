ALTER TABLE "consents" DROP CONSTRAINT "consents_decision_ck";--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_channel_ck";--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_declined_ck";--> statement-breakpoint
ALTER TABLE "escalations" DROP CONSTRAINT "escalations_source_ck";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_ck";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "notification_prefs" DROP CONSTRAINT "notification_prefs_muted_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_ck";--> statement-breakpoint
ALTER TABLE "consents" ALTER COLUMN "wording_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
CREATE INDEX "consents_contact_latest_idx" ON "consents" USING btree ("tenant_id","contact_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_wording_ck" CHECK (("consents"."decision" = 'withdrawn') = ("consents"."wording_id" is null));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_recorded_by_ck" CHECK (("consents"."channel" = 'dashboard') = ("consents"."recorded_by" is not null));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_withdrawn_ck" CHECK ("consents"."decision" <> 'withdrawn' or "consents"."contact_id" is not null);--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_decision_ck" CHECK ("consents"."decision" in ('agreed', 'declined', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_channel_ck" CHECK ("consents"."channel" in ('widget', 'dashboard'));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_declined_ck" CHECK ("consents"."decision" in ('agreed', 'withdrawn') or "consents"."contact_id" is null or "consents"."purpose" = 'marketing');--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_source_ck" CHECK ("escalations"."source" in ('visitor_button', 'visitor_asked', 'unverified', 'approval_sla', 'data_request'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_ck" CHECK ("messages"."card" is null or ("messages"."author" in ('agent', 'system') and "messages"."card"->>'kind' in ('consent', 'lead_form', 'quote', 'withdraw')));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left', 'escalated', 'lead_captured', 'approval_waiting', 'approval_rejected', 'approval_expired', 'consent_withdrawn')));--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_muted_ck" CHECK ("notification_prefs"."email_muted" <@ array['escalation','approval_pending','hot_lead','consent_withdrawn']::text[]);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" in ('escalation', 'approval_pending', 'hot_lead', 'consent_withdrawn', 'escalation_reminder', 'approval_undeliverable', 'test'));--> statement-breakpoint
-- FEAT-051 §4, hand-written: the dashboard records withdrawals (UC-28 1a) and nothing else.
-- tenant_isolation on consents (0048) is FOR ALL; these restrictive policies narrow inserts per zone
-- (the 0043 messages pattern), so the dashboard can never write an agreement and the visitor zone
-- can never pose as staff.
GRANT INSERT ON consents TO app_dashboard;--> statement-breakpoint
CREATE POLICY consents_dashboard_withdrawals ON consents AS RESTRICTIVE FOR INSERT TO app_dashboard WITH CHECK (decision = 'withdrawn' and channel = 'dashboard');--> statement-breakpoint
CREATE POLICY consents_visitor_channel ON consents AS RESTRICTIVE FOR INSERT TO app_agent_visitor WITH CHECK (channel <> 'dashboard');

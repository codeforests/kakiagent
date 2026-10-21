-- FEAT-025: the visitor turn flags its own conversation and counts abuse turns (AGT-13;
-- FEAT-025 §4). Hand-written; drizzle-kit owns the DDL in 0016. RLS on conversations is
-- unchanged (0001), so the visitor role reaches only its tenant's rows; it still cannot
-- change visitor_id or channel.
GRANT UPDATE (flagged_at, flag_reasons, abuse_turns) ON conversations TO app_agent_visitor;

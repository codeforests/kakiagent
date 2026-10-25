import { sql } from '@kaki/db';
import { vectorLiteral } from './chunk.js';
import type { DashboardKbContext } from './context.js';
import { factLabel } from './corrections.js';
import type { FactInput } from './facts.js';

/**
 * The coverage report (KB-09; FEAT-019 §5.3): which template topics the approved KB
 * answers, and the top groups of questions visitors asked that it couldn't. Gaps are
 * `coverage_gap` corrections (D1); their questions live on the messages, which the
 * caller reads through inbox (`gapStats`), so kb never reads conversations.
 */

/** A topic is covered by a visible fact within this cosine distance (D5, starting value). */
export const TOPIC_COVER_DISTANCE = 0.35;
/** `kb_gap_cluster()` joins a gap to an item within this distance (D5; kept in the SQL too). */
export const GAP_JOIN_DISTANCE = 0.25;
/** Top gaps on the report (D6). */
export const COVERAGE_GAP_LIMIT = 20;
const RECENT_DAYS = 30;

export interface CoverageTopicInput {
  id: string;
  question: string;
  hint: string;
}

export interface CoverageTopicRecord extends CoverageTopicInput {
  state: 'covered' | 'missing' | 'skipped';
  coveredBy: { factId: string; type: FactInput['type']; label: string } | null;
}

export interface GapStat {
  asksSince: number;
  asksTotal: number;
  firstAskedAt: Date;
  lastAskedAt: Date;
  reasons: ('unavailable' | 'unsure' | 'escalated')[];
  /** The newest ask, masked; null when none is left. */
  newest: string | null;
}

export interface CoverageGapRecord {
  correctionId: string;
  question: string;
  asks30d: number;
  asksTotal: number;
  firstAskedAt: Date;
  lastAskedAt: Date;
  reasons: GapStat['reasons'];
}

export interface CoverageReportRecord {
  stage: 'pre_live' | 'live';
  template: {
    industry: string;
    topics: CoverageTopicRecord[];
    checked: 'meaning' | 'question_only';
  } | null;
  gaps: CoverageGapRecord[];
  summary: { topicsTotal: number; topicsMissing: number; openGaps: number };
}

export interface CoverageInput {
  template: { industry: string; topics: readonly CoverageTopicInput[] } | null;
  skipped: readonly string[];
  /** How a question compares to an FAQ's (tenancy's `questionKey`). */
  keyOf: (question: string) => string;
  /** The topic questions' vectors, in order; a throw degrades to key matching (D7). */
  embedTopics: (questions: string[]) => Promise<number[][]>;
  /** The tenant has had a conversation (D4, until FEAT-034). */
  live: boolean;
  /** Counts and newest ask per open gap item (inbox's `gapCounts` and `gapQuestions`). */
  gapStats: (correctionIds: string[], since: Date) => Promise<Map<string, GapStat>>;
  now: Date;
}

/** `visitor_facts`' conditions: what visitors can be told (ADR-010). */
const visibleSql = sql`f.status = 'approved'
  and (f.valid_from is null or f.valid_from <= now())
  and (f.valid_until is null or f.valid_until > now())
  and not (
    f.gst_treatment is not null and f.gst_treatment = 'unknown'
    and coalesce((select bp.gst_registered from business_profiles bp
                  where bp.tenant_id = f.tenant_id), true)
  )`;

async function topicsOf(
  ctx: DashboardKbContext,
  input: CoverageInput,
): Promise<NonNullable<CoverageReportRecord['template']>> {
  const topics = input.template!.topics;
  const faqs = await ctx.tx.execute<{ id: string; question: string }>(sql`
    select f.id, f.value ->> 'question' as question from facts f
    where f.tenant_id = ${ctx.tenantId} and f.type = 'faq' and ${visibleSql}
    order by f.created_at`);
  const byKey = new Map<string, { id: string; question: string }>();
  for (const f of faqs.rows)
    if (!byKey.has(input.keyOf(f.question))) byKey.set(input.keyOf(f.question), f);

  const open = topics.filter((t) => !input.skipped.includes(t.id));
  let vectors: number[][] | null = null;
  const unmatched = open.filter((t) => !byKey.has(input.keyOf(t.question)));
  if (unmatched.length) {
    try {
      vectors = await input.embedTopics(unmatched.map((t) => t.question));
    } catch {
      vectors = null;
    }
  }
  const byMeaning = new Map<string, CoverageTopicRecord['coveredBy']>();
  if (vectors)
    for (const [i, t] of unmatched.entries()) {
      const res = await ctx.tx.execute<{
        id: string;
        type: FactInput['type'];
        value: FactInput['value'];
        distance: number;
      }>(sql`
        select f.id, f.type, f.value, (c.embedding <=> ${vectorLiteral(vectors[i]!)}::vector) as distance
        from kb_chunks c
        join facts f on f.tenant_id = c.tenant_id and f.id = c.fact_id and f.version = c.fact_version
        where c.tenant_id = ${ctx.tenantId} and f.tenant_id = ${ctx.tenantId} and ${visibleSql}
        order by distance
        limit 1`);
      const hit = res.rows[0];
      if (hit && Number(hit.distance) <= TOPIC_COVER_DISTANCE)
        byMeaning.set(t.id, {
          factId: hit.id,
          type: hit.type,
          label: factLabel({ type: hit.type, value: hit.value } as FactInput),
        });
    }

  return {
    industry: input.template!.industry,
    checked: vectors || unmatched.length === 0 ? 'meaning' : 'question_only',
    topics: topics.map((t) => {
      if (input.skipped.includes(t.id)) return { ...t, state: 'skipped', coveredBy: null };
      const faq = byKey.get(input.keyOf(t.question));
      const coveredBy = faq
        ? { factId: faq.id, type: 'faq' as const, label: faq.question }
        : (byMeaning.get(t.id) ?? null);
      return { ...t, state: coveredBy ? 'covered' : 'missing', coveredBy };
    }),
  };
}

/**
 * The report (KB-09; AC-2, AC-3, AC-6, AC-9). Topics: skipped, else covered by an approved
 * FAQ with the same question key, else by the nearest visible fact within
 * `TOPIC_COVER_DISTANCE`, else missing. Gaps: open `coverage_gap` items with at least one
 * question left, by asks in the last 30 days, then the latest ask, top 20.
 */
export async function coverageReport(
  ctx: DashboardKbContext,
  input: CoverageInput,
): Promise<CoverageReportRecord> {
  const template = input.template ? await topicsOf(ctx, input) : null;
  const items = await ctx.tx.execute<{ id: string }>(sql`
    select id from corrections
    where tenant_id = ${ctx.tenantId} and source_type = 'coverage_gap' and status = 'open'`);
  const since = new Date(input.now.getTime() - RECENT_DAYS * 86_400_000);
  const stats = await input.gapStats(
    items.rows.map((r) => r.id),
    since,
  );
  const all: CoverageGapRecord[] = [];
  for (const [correctionId, s] of stats)
    if (s.asksTotal > 0 && s.newest !== null)
      all.push({
        correctionId,
        question: s.newest,
        asks30d: s.asksSince,
        asksTotal: s.asksTotal,
        firstAskedAt: s.firstAskedAt,
        lastAskedAt: s.lastAskedAt,
        reasons: s.reasons,
      });
  all.sort(
    (a, b) =>
      b.asks30d - a.asks30d ||
      b.lastAskedAt.getTime() - a.lastAskedAt.getTime() ||
      a.correctionId.localeCompare(b.correctionId),
  );
  const topics = template?.topics ?? [];
  return {
    stage: input.live ? 'live' : 'pre_live',
    template,
    gaps: all.slice(0, COVERAGE_GAP_LIMIT),
    summary: {
      topicsTotal: topics.length,
      topicsMissing: topics.filter((t) => t.state === 'missing').length,
      openGaps: all.length,
    },
  };
}

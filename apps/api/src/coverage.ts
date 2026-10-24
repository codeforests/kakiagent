import { CoverageReport, CoverageTopicBody, CoverageTopicResponse } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { hasConversation } from '@kaki/inbox';
import {
  coverageReport,
  dashboardKb,
  type CoverageReportRecord,
  type CoverageTopicInput,
} from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import {
  coverageSkippedTopics,
  coverageTemplate,
  questionKey,
  setTopicSkipped,
} from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { bodyOf } from './corrections.js';
import { ForbiddenError } from './facts.js';
import { gapStatsIn } from './gaps.js';
import type { App, Deps } from './server.js';

/**
 * Template topic vectors, embedded once per API process (per gateway) per question (D7).
 * The questions are fixed template text, never tenant data, so one vector serves every
 * tenant.
 */
const topicVectors = new WeakMap<LlmGateway, Map<string, number[]>>();
async function embedTopics(llm: LlmGateway, tenantId: string, questions: string[]) {
  const known = topicVectors.get(llm) ?? new Map<string, number[]>();
  topicVectors.set(llm, known);
  const missing = [...new Set(questions.filter((q) => !known.has(q)))];
  if (missing.length) {
    const { vectors } = await llm.embed({ texts: missing, purpose: 'query', meta: { tenantId } });
    missing.forEach((q, i) => known.set(q, vectors[i]!));
  }
  return questions.map((q) => known.get(q)!);
}

function toReport(r: CoverageReportRecord): CoverageReport {
  return CoverageReport.parse({
    ...r,
    gaps: r.gaps.map((g) => ({
      ...g,
      firstAskedAt: g.firstAskedAt.toISOString(),
      lastAskedAt: g.lastAskedAt.toISOString(),
    })),
  });
}

/**
 * The coverage report (KB-09, UC-16 3b; FEAT-019 §3, §5.5), dashboard trust zone,
 * `kb.manage`. Topic vectors are embedded outside the transaction (FEAT-022 D4); a
 * failing embedder gives `checked: 'question_only'`, never an error (D7).
 */
export function registerCoverageRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, llm } = deps;

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'kb.manage')) throw new ForbiddenError('kb.manage');
    return s;
  }
  const templateOf = async (tx: Tx, tenantId: string) => {
    const found = await coverageTemplate(tx, tenantId);
    return found
      ? {
          industry: found.industry,
          topics: found.template.suggestedFaqs as readonly CoverageTopicInput[],
        }
      : null;
  };

  async function report(s: TenantSession, req: FastifyRequest) {
    const template = await withTenant(dashboardDb, s.tenantId, (tx) => templateOf(tx, s.tenantId));
    let vectors: number[][] | null = null;
    if (template)
      try {
        vectors = await embedTopics(
          llm,
          s.tenantId,
          template.topics.map((t) => t.question),
        );
      } catch (err) {
        req.log.warn({ err }, 'coverage topics not embedded; matching by question only');
      }
    const byQuestion = new Map(template?.topics.map((t, i) => [t.question, vectors?.[i]]));
    return withTenant(dashboardDb, s.tenantId, async (tx) =>
      coverageReport(dashboardKb(tx, s.tenantId, s.userId), {
        template,
        skipped: await coverageSkippedTopics(tx, s.tenantId),
        keyOf: questionKey,
        embedTopics: async (questions) => {
          if (!vectors) throw new Error('topic vectors unavailable');
          return questions.map((q) => byQuestion.get(q)!);
        },
        live: await hasConversation(tx, s.tenantId),
        gapStats: gapStatsIn(tx, s.tenantId),
        now: new Date(),
      }),
    );
  }

  app.get('/api/v1/kb/coverage', async (req) => {
    const s = await manager(req);
    return toReport(await report(s, req));
  });

  app.put<{ Params: { topicId: string } }>('/api/v1/kb/coverage/topics/:topicId', async (req) => {
    const s = await manager(req);
    const { skipped } = bodyOf(CoverageTopicBody, req.body);
    await withTenant(dashboardDb, s.tenantId, (tx) =>
      setTopicSkipped(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        topicId: req.params.topicId,
        skipped,
      }),
    );
    const r = toReport(await report(s, req));
    const topic = r.template?.topics.find((t) => t.id === req.params.topicId);
    return CoverageTopicResponse.parse({ topic });
  });
}

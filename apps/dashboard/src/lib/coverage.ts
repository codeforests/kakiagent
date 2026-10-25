import type {
  CoverageGap,
  CoverageReport,
  CoverageTopic,
  CoverageTopicState,
  GapReason,
} from '@kaki/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { relativeTime } from './coach.ts';

/** Coverage display rules for SCR-APP-029 and the setup summary (FEAT-019 ui-design). */

export type CoverageSection = 'topics' | 'gaps';

/** Pre-live leads with the template topics, live with customers' questions (D4). */
export const sectionOrder = (r: CoverageReport): CoverageSection[] =>
  r.stage === 'live' ? ['gaps', 'topics'] : ['topics', 'gaps'];

/** The topic state chip: text and tone, never colour alone. */
export const TOPIC_STATE: Record<
  CoverageTopicState,
  { label: string; tone: 'warning' | 'success' | 'neutral' }
> = {
  missing: { label: 'Not answered yet', tone: 'warning' },
  covered: { label: 'Answered', tone: 'success' },
  skipped: { label: "Doesn't apply", tone: 'neutral' },
};

export const GAP_REASON: Record<GapReason, string> = {
  unavailable: "Couldn't answer",
  unsure: "Wasn't sure",
  escalated: 'Handed to staff',
};

/** "once", "3 times". */
export const timesLabel = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** Topics that apply (skipped ones don't count) and how many of them are answered. */
export function topicCounts(topics: CoverageTopic[]): { covered: number; total: number } {
  const applying = topics.filter((t) => t.state !== 'skipped');
  return { covered: applying.filter((t) => t.state === 'covered').length, total: applying.length };
}

/** "9 of 12 common questions answered". */
export function topicsLine(topics: CoverageTopic[]): string {
  const { covered, total } = topicCounts(topics);
  return `${covered} of ${total} common ${total === 1 ? 'question' : 'questions'} answered`;
}

/** "3 questions customers asked that your assistant couldn't answer". */
export const gapsLine = (n: number) =>
  `${n} ${n === 1 ? 'question' : 'questions'} customers asked that your assistant couldn't answer`;

/** The summary lines: pre-live the topics; live the gaps, then the topics while any is missing. */
export function summaryLines(r: CoverageReport): string[] {
  const topics = r.template ? topicsLine(r.template.topics) : null;
  if (r.stage === 'pre_live') return topics ? [topics] : [];
  return [gapsLine(r.summary.openGaps), ...(topics && r.summary.topicsMissing > 0 ? [topics] : [])];
}

/** Every topic covered or skipped: the section collapses to one line. */
export const topicsDone = (r: CoverageReport) => !!r.template && r.summary.topicsMissing === 0;

/** "All 12 common questions are answered." */
export function allTopicsLine(topics: CoverageTopic[]): string {
  const { total } = topicCounts(topics);
  if (total === 0) return 'None of the common questions apply to your business.';
  return total === 1
    ? 'The common question is answered.'
    : `All ${total} common questions are answered.`;
}

/** Live with no gaps and nothing missing. */
export const allClear = (r: CoverageReport) =>
  r.stage === 'live' && r.gaps.length === 0 && r.summary.topicsMissing === 0;

/** The Knowledge tab's count pill: missing topics plus open gaps. */
export const tabCount = (r: CoverageReport | undefined) =>
  r ? r.summary.topicsMissing + r.summary.openGaps : 0;

/** "Asked 3 times in the last 30 days · last 2 hours ago". */
export function askedLine(g: CoverageGap, now = new Date()): string {
  const last = `last ${relativeTime(g.lastAskedAt, now)}`;
  return g.asks30d > 0
    ? `Asked ${timesLabel(g.asks30d)} in the last 30 days · ${last}`
    : `Asked ${timesLabel(g.asksTotal)} · ${last}`;
}

/** The FAQ dialog's caption for a gap. */
export const gapCaption = (n: number) =>
  `Customers asked this ${timesLabel(n)}. Write the question the way you'd like it to read.`;

/** "Asked 3 times in the last 30 days, 5 in all." on the correction detail. */
export const gapCountsLine = (asks30d: number, asksTotal: number) =>
  `Asked ${timesLabel(asks30d)} in the last 30 days, ${asksTotal} in all.`;

/** The report; 4xx (403 for agents) isn't retried. */
export function useCoverage(enabled = true) {
  return useQuery({
    queryKey: ['coverage'],
    queryFn: api.coverage,
    enabled,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
  });
}

export function useCoverageChanged() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['coverage'] });
}

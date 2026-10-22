import type { Source, SourceFailure, SourcePage } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.ts';

/** Source display rules shared by SCR-APP-023, SCR-APP-024 and the shell (FEAT-012 ui-design). */

export const SOURCE_STATE: Record<
  Source['status'],
  { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const STAGE_LABEL: Record<NonNullable<Source['stage']>, string> = {
  crawl: 'Reading pages',
  extract: 'Finding facts',
  promote: 'Saving facts',
};

export const FAILURE_TEXT: Record<SourceFailure, string> = {
  no_pages: 'No page could be read. robots.txt or the domain limits excluded every page.',
  site_unreachable: "We couldn't reach the site. Check the address and that the site is online.",
  extraction_unavailable:
    'Finding facts failed after several tries. Your pages are saved; try again in a few minutes.',
  internal: 'Something went wrong on our side. Try again; if it fails again, contact support.',
};

export const PAGE_STATE: Record<
  SourcePage['status'],
  { label: string; tone: 'success' | 'neutral' | 'danger' | 'warning' }
> = {
  included: { label: 'Read', tone: 'success' },
  excluded: { label: 'Excluded', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'warning' },
};

/** The page's result in words (ui-design cross-screen "Page reasons"). */
export function pageResult(p: SourcePage): string {
  switch (p.reason) {
    case null:
      return 'Read';
    case 'robots':
      return 'Excluded: blocked by robots.txt';
    case 'off_domain_redirect':
      return 'Excluded: redirects to another site';
    case 'not_html':
      return 'Excluded: not a web page';
    case 'duplicate':
      return 'Excluded: same content as another page';
    case 'timeout':
      return 'Failed: took too long to load';
    case 'http_error':
      return `Failed: the site returned ${p.httpStatus ?? 'an error'}`;
    case 'blocked_address':
      return 'Failed: address not allowed';
    case 'load_error':
      return "Failed: couldn't load";
    case 'plan_limit':
      return 'Skipped: plan limit';
  }
}

export const busy = (s: Source) => s.status === 'queued' || s.status === 'processing';

/**
 * How far the current stage is, 0–100, or null when it can't be told (promote, or a crawl
 * that hasn't found its first page yet).
 */
export function stageProgress(s: Source): { done: number; of: number; percent: number } | null {
  const c = s.counts;
  if (s.stage === 'crawl') {
    const done = c.pagesIncluded + c.pagesExcluded + c.pagesFailed;
    const of = Math.max(c.pagesFound, done, 1);
    return c.pagesFound ? { done, of, percent: Math.round((done / of) * 100) } : null;
  }
  if (s.stage === 'extract' && c.pagesIncluded > 0) {
    const percent = Math.round((c.pagesExtracted / c.pagesIncluded) * 100);
    return { done: c.pagesExtracted, of: c.pagesIncluded, percent };
  }
  return null;
}

/** "38 facts · 38 need review · 31 pages read" (ready), or the busy stage text. */
export function sourceSummary(s: Source): string {
  const c = s.counts;
  const pages = `${c.pagesIncluded} ${c.pagesIncluded === 1 ? 'page' : 'pages'} read`;
  if (s.status === 'ready')
    return c.facts === 0
      ? `No facts found · ${pages}`
      : `${c.facts} ${c.facts === 1 ? 'fact' : 'facts'} · ${c.factsNeedingReview} need review · ${pages}`;
  if (s.status === 'failed') return FAILURE_TEXT[s.failure ?? 'internal'];
  const stage = s.stage ? STAGE_LABEL[s.stage] : 'Waiting';
  // A queued source that started a stage is waiting for a retry (UC-03 5c).
  if (s.status === 'queued' && s.stage && s.stage !== 'crawl') return `${stage} · waiting to retry`;
  const p = stageProgress(s);
  return p ? `${stage} · ${p.done} of ${p.of}` : stage;
}

/** True while the page is visible (polling stops when the tab is hidden, D6). */
function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export const POLL_MS = 2000;

/**
 * The tenant's sources, refetched every 2 s while one is queued or processing and the tab
 * is visible (technical design D6). `enabled` is false for roles without `kb.manage`.
 */
export function useSources(enabled = true) {
  const visible = useVisible();
  return useQuery({
    queryKey: ['sources'],
    queryFn: api.sources,
    enabled,
    refetchInterval: (q) => (visible && q.state.data?.sources.some(busy) ? POLL_MS : false),
  });
}

/** A source with its pages, polled like the list while it is busy. */
export function useSource(id: string) {
  const visible = useVisible();
  return useQuery({
    queryKey: ['source', id],
    queryFn: () => api.source(id),
    refetchInterval: (q) =>
      visible && q.state.data && busy(q.state.data.source) ? POLL_MS : false,
  });
}

/**
 * The polite announcement of a source's status change (ui-design: "kakibakery.sg is
 * ready. 38 facts need review."), never every count change.
 */
export function useStatusAnnouncements(sources: Source[] | undefined) {
  const [message, setMessage] = useState('');
  const [seen, setSeen] = useState<ReadonlyMap<string, Source['status']>>(new Map());
  const key = sources?.map((s) => `${s.id}:${s.status}`).join() ?? '';
  const [seenKey, setSeenKey] = useState(key);
  // Adjusted while rendering (React's pattern for state derived from a changed prop).
  if (sources && key !== seenKey) {
    const said: string[] = [];
    for (const s of sources) {
      const before = seen.get(s.id);
      if (!before || before === s.status) continue;
      if (s.status === 'ready')
        said.push(
          `${s.name} is ready. ${s.counts.factsNeedingReview} ${s.counts.factsNeedingReview === 1 ? 'fact needs' : 'facts need'} review.`,
        );
      else if (s.status === 'failed') said.push(`${s.name} failed. ${sourceSummary(s)}`);
      else if (s.status === 'processing') said.push(`Reading ${s.name}.`);
    }
    setSeenKey(key);
    setSeen(new Map(sources.map((s) => [s.id, s.status])));
    if (said.length) setMessage(said.join(' '));
  }
  return [message, setMessage] as const;
}

/** Retry on a failed source (KB-12), refreshing what shows it. */
export function useRetry(onRetried: (s: Source) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (s: Source) => api.retrySource(s.id, s.version),
    onSuccess: async ({ source }) => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      await queryClient.invalidateQueries({ queryKey: ['source', source.id] });
      onRetried(source);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

/**
 * The failed-sources count on the Knowledge nav entry (KB-12 in-app alert; FEAT-012
 * ui-design), for roles that manage knowledge.
 */
export function useNavCounts(): Partial<Record<string, number>> {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const manages = me.data?.role === 'owner' || me.data?.role === 'admin';
  const sources = useSources(manages);
  return { '/knowledge': failedCount(sources.data?.sources) };
}

export const failedCount = (sources: Source[] | undefined) =>
  sources?.filter((s) => s.status === 'failed').length ?? 0;

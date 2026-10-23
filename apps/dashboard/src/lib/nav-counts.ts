import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { useReviewSummary } from './review.ts';
import { failedCount, useSources } from './sources.ts';

export interface NavCountValue {
  count: number;
  /** Read after the number by screen readers: "3 failed", "12 facts to review". */
  label: string;
  tone: 'danger' | 'warning';
}

/**
 * The count pills on nav entries, for roles that manage knowledge: failed sources on
 * Knowledge (KB-12 in-app alert; FEAT-012 ui-design) and facts waiting on Review,
 * conflicted ones included (FEAT-013, FEAT-014 ui-design).
 */
export function useNavCounts(): Partial<Record<string, NavCountValue>> {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const manages = me.data?.role === 'owner' || me.data?.role === 'admin';
  const sources = useSources(manages);
  const review = useReviewSummary(manages);
  return {
    '/knowledge': { count: failedCount(sources.data?.sources), label: 'failed', tone: 'danger' },
    '/review': {
      count: (review.data?.needsReview ?? 0) + (review.data?.conflicted ?? 0),
      label: 'facts to review',
      tone: 'warning',
    },
  };
}

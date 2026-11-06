import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { usePendingApprovals } from './approvals.ts';
import { useReviewSummary } from './review.ts';
import { failedCount, useSources } from './sources.ts';

export interface NavCountValue {
  count: number;
  /** Read after the number by screen readers: "3 failed", "12 facts to review". */
  label: string;
  tone: 'danger' | 'warning' | 'pending';
}

/**
 * The count pills on nav entries, for roles that manage knowledge: failed sources on
 * Knowledge (KB-12 in-app alert; FEAT-012 ui-design) and items waiting on Review:
 * facts, conflicted ones included, and open corrections (FEAT-013, 014, 018 ui-design);
 * for every member, approvals waiting on Approvals (FEAT-055 ui-design SCR-APP-017).
 */
export function useNavCounts(): Partial<Record<string, NavCountValue>> {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const manages = me.data?.role === 'owner' || me.data?.role === 'admin';
  const sources = useSources(manages);
  const review = useReviewSummary(manages);
  // Every member sees Approvals (D8): the pending count on its nav item (FEAT-055).
  const approvals = usePendingApprovals(Boolean(me.data?.role));
  return {
    '/approvals': { count: approvals.data ?? 0, label: 'waiting for approval', tone: 'pending' },
    '/knowledge': { count: failedCount(sources.data?.sources), label: 'failed', tone: 'danger' },
    '/review': {
      count:
        (review.data?.needsReview ?? 0) +
        (review.data?.conflicted ?? 0) +
        (review.data?.openCorrections ?? 0),
      label: 'items to review',
      tone: 'warning',
    },
  };
}

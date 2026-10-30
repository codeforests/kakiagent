import {
  BOUNDARY_LIMITS,
  type BoundaryRules,
  type BoundaryRulesResponse,
  type CommitmentKey,
} from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { useReauthGuard } from './reauth.ts';

/** Helpers for SCR-APP-042 and the setup step's rules block (FEAT-054 technical-design §5.5). */

export const RULES_KEY = ['rules'];

export function useRules() {
  return useQuery({
    queryKey: RULES_KEY,
    queryFn: () => api.getRules(),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** A save behind re-auth (AUTH-03): never optimistic, the response becomes the new base. */
export function useSaveRules() {
  const queryClient = useQueryClient();
  const { guard } = useReauthGuard();
  return useMutation({
    mutationFn: (body: { version: number | null; rules: BoundaryRules }) =>
      guard(() => api.saveRules(body)),
    onSuccess: (res) => queryClient.setQueryData(RULES_KEY, res),
  });
}

export const COMMITMENT_LABELS: Record<CommitmentKey, string> = {
  delivery_guarantee: 'Delivery guarantees or exact arrival times',
  refund: 'Refunds or money back',
  legal_advice: 'Legal advice',
  medical_advice: 'Medical advice',
};

/** The short names the confirm dialog's change lines use. */
const COMMITMENT_SHORT: Record<CommitmentKey, string> = {
  delivery_guarantee: 'Delivery guarantees',
  refund: 'Refunds',
  legal_advice: 'Legal advice',
  medical_advice: 'Medical advice',
};

const LIST_LABELS = {
  allowedTopics: 'Helps with',
  blockedTopics: "Won't discuss",
  customCommitments: 'Never promise',
} as const;

type ListField = keyof typeof LIST_LABELS;

/** Trimmed, spaces collapsed, lower case: the server's dedupe key. */
export const topicKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The confirm dialog's change lines, e.g. "Maximum discount: 0% → 10%"; empty when equal. */
export function diffRules(before: BoundaryRules, after: BoundaryRules): string[] {
  const lines: string[] = [];
  for (const field of Object.keys(LIST_LABELS) as ListField[]) {
    const was = new Set(before[field].map(topicKey));
    const now = new Set(after[field].map(topicKey));
    for (const t of after[field])
      if (!was.has(topicKey(t))) lines.push(`${LIST_LABELS[field]}: added ${t.trim()}`);
    for (const t of before[field])
      if (!now.has(topicKey(t))) lines.push(`${LIST_LABELS[field]}: removed ${t.trim()}`);
  }
  if (before.maxDiscountPct !== after.maxDiscountPct)
    lines.push(`Maximum discount: ${before.maxDiscountPct}% → ${after.maxDiscountPct}%`);
  if (before.quotesNeedApproval !== after.quotesNeedApproval)
    lines.push(
      after.quotesNeedApproval ? 'Quotes: now need approval' : 'Quotes: no longer need approval',
    );
  for (const key of Object.keys(COMMITMENT_SHORT) as CommitmentKey[]) {
    const was = before.forbiddenCommitments.includes(key);
    const now = after.forbiddenCommitments.includes(key);
    if (was !== now)
      lines.push(`${COMMITMENT_SHORT[key]}: ${now ? 'now forbidden' : 'no longer forbidden'}`);
  }
  return lines;
}

/** A topic's client-side error (mirrors the contract), or undefined when it can be added. */
export function topicError(
  list: string[],
  value: string,
  opts: { max: number; other?: { items: string[]; message: string } },
): string | undefined {
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v) return 'Type something to add.';
  if (v.length < BOUNDARY_LIMITS.topicMin || v.length > BOUNDARY_LIMITS.topicMax)
    return `Use ${BOUNDARY_LIMITS.topicMin} to ${BOUNDARY_LIMITS.topicMax} characters`;
  const key = topicKey(v);
  if (list.some((t) => topicKey(t) === key)) return 'Already in the list';
  if (opts.other?.items.some((t) => topicKey(t) === key)) return opts.other.message;
  if (list.length >= opts.max) return `You can add up to ${opts.max}`;
  return undefined;
}

/** "Enter a whole number from 0 to 100", or undefined for a valid maximum discount. */
export function discountError(value: string): string | undefined {
  const v = value.trim();
  if (!/^\d{1,3}$/.test(v) || Number(v) > 100) return 'Enter a whole number from 0 to 100';
  return undefined;
}

export type RulesErrorField = ListField | 'maxDiscountPct' | 'forbiddenCommitments';

const MESSAGES: Record<RulesErrorField, (code: string) => string> = {
  allowedTopics: (c) => listMessage(c, BOUNDARY_LIMITS.topics),
  blockedTopics: (c) =>
    c === 'also_allowed'
      ? "A topic can't be both helped with and not discussed"
      : listMessage(c, BOUNDARY_LIMITS.topics),
  customCommitments: (c) => listMessage(c, BOUNDARY_LIMITS.customCommitments),
  maxDiscountPct: () => 'Enter a whole number from 0 to 100',
  forbiddenCommitments: () => 'Legal and medical advice are always on',
};

function listMessage(code: string, max: number) {
  if (code === 'duplicate') return 'A topic is in the list twice';
  if (code === 'too_big' || code === 'too_small')
    return `Use ${BOUNDARY_LIMITS.topicMin} to ${BOUNDARY_LIMITS.topicMax} characters, up to ${max} items`;
  return 'Check this list';
}

/** The 400 `invalid_rules` field codes as one message per form field (first one wins). */
export function rulesFieldErrors(
  fields: Record<string, unknown>,
): Partial<Record<RulesErrorField, string>> {
  const out: Partial<Record<RulesErrorField, string>> = {};
  for (const [path, code] of Object.entries(fields)) {
    const field = path.split('.')[1] as RulesErrorField | undefined;
    if (!field || !(field in MESSAGES) || out[field]) continue;
    out[field] = MESSAGES[field](String(code));
  }
  return out;
}

const SAVED = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

/** The footer's meta caption: "Saved 30 Oct 2026, 2:05 pm" (SGT) or "Not saved yet". */
export const savedCaption = (res: Pick<BoundaryRulesResponse, 'savedAt'>) =>
  res.savedAt ? `Saved ${SAVED.format(new Date(res.savedAt))}` : 'Not saved yet';

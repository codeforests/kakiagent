import type { Fact, FactStatus, FactType, PolicyKind } from '@kaki/contracts';

/** Fact display rules shared by SCR-APP-027 and SCR-APP-028 (FEAT-022, FEAT-011 ui-design). */

export const STATUS_LABEL: Record<FactStatus, string> = {
  approved: 'Approved',
  needs_review: 'Needs review',
  disabled: 'Disabled',
  rejected: 'Rejected',
  conflicted: 'Conflicted',
};

/** Disabled reuses the rejected colours: both mean "not used in answers" (ui-design decision). */
export const STATUS_TONE: Record<FactStatus, 'approved' | 'review' | 'rejected' | 'conflict'> = {
  approved: 'approved',
  needs_review: 'review',
  disabled: 'rejected',
  rejected: 'rejected',
  conflicted: 'conflict',
};

export const TYPE_LABEL: Record<FactType, string> = {
  product: 'Product',
  faq: 'FAQ',
  policy: 'Policy',
  promotion: 'Promotion',
};

export const POLICY_KIND_LABEL: Record<PolicyKind, string> = {
  refund: 'Refunds',
  delivery: 'Delivery',
  booking: 'Booking',
  payment: 'Payment',
  other: 'Other',
};

export const GST_LABEL = {
  inclusive: 'GST incl.',
  exclusive: 'GST excl.',
  unknown: 'GST to check',
};

/** `S$55.00`, as typed and stored (design.md §6, NFR-10). */
export const sgd = (price: string) => `S$${price}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "31 Oct 2026" for a `YYYY-MM-DD` Singapore day (design.md §6). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Today in Singapore, `YYYY-MM-DD`. */
export const sgToday = (now = new Date()) =>
  new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

export function factTitle(f: Fact): string {
  switch (f.type) {
    case 'faq':
      return f.value.question;
    case 'product':
      return f.value.unit ? `${f.value.name}, ${f.value.unit}` : f.value.name;
    case 'policy':
    case 'promotion':
      return f.value.title;
  }
}

/** Where a promotion stands today: running until its end, not started, or ended. */
export function promotionWindow(
  f: Extract<Fact, { type: 'promotion' }>,
  today = sgToday(),
): { state: 'ended' | 'upcoming' | 'running'; label: string } {
  if (f.validUntil && f.validUntil < today)
    return { state: 'ended', label: `Ended ${dayLabel(f.validUntil)}` };
  if (f.validFrom && f.validFrom > today)
    return { state: 'upcoming', label: `Starts ${dayLabel(f.validFrom)}` };
  return { state: 'running', label: f.validUntil ? `Until ${dayLabel(f.validUntil)}` : '' };
}

/** The Value column (SCR-APP-027): the GST chip is shown separately for `unknown`. */
export function factValue(f: Fact): string {
  switch (f.type) {
    case 'product':
      return f.gstTreatment === 'unknown'
        ? sgd(f.value.price)
        : `${sgd(f.value.price)} · ${GST_LABEL[f.gstTreatment]}`;
    case 'faq':
      return f.value.answer.split('\n')[0]!;
    case 'policy':
      return `${POLICY_KIND_LABEL[f.value.kind]} · ${f.value.details.split('\n')[0]!}`;
    case 'promotion': {
      const price =
        f.value.price === undefined
          ? []
          : [
              f.gstTreatment && f.gstTreatment !== 'unknown'
                ? `${sgd(f.value.price)} · ${GST_LABEL[f.gstTreatment]}`
                : sgd(f.value.price),
            ];
      const window = promotionWindow(f);
      return [...price, window.state === 'running' ? window.label : ''].filter(Boolean).join(' · ');
    }
  }
}

/** A price waiting for its GST treatment (KB-15). */
export const needsGst = (f: Fact) => f.gstTreatment === 'unknown';

const UPDATED = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

/** "19 Oct 2026, 2:30 pm". */
export const updatedLabel = (iso: string) => UPDATED.format(new Date(iso));

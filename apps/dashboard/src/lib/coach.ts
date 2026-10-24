import {
  WEEKDAY_NAMES,
  WEEKDAYS,
  type Explainer,
  type Fact,
  type FactValueView,
  type ProposedChange,
  type ReasonCode,
  type Weekday,
} from '@kaki/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { dayLabel, GST_LABEL, sgd, TYPE_LABEL } from './facts.ts';

/** Coaching display rules shared by SCR-APP-030, SCR-APP-010 and the quick panel (FEAT-027 ui-design). */

/** One sentence per reason code; `{labels}` is the used facts' labels. */
const REASON_TEXT: Record<ReasonCode, string> = {
  matched_facts: 'It matched {labels}.',
  no_matching_fact: 'Nothing in your facts matched, so it said it would check with your team.',
  low_confidence: "It wasn't sure what was asked.",
  out_of_scope: "This isn't about your business, so it gave the standard reply.",
  advice: "It doesn't give that kind of advice.",
  illegal: "It doesn't give that kind of advice.",
  injection:
    'The message tried to change its instructions or asked for internal data, so it refused.',
  impersonation:
    'The message tried to change its instructions or asked for internal data, so it refused.',
  regenerated: 'Its first draft quoted something not in your facts, so it rewrote it.',
  segment_blocked: "Part of its draft didn't match your facts and was left out.",
  escalated: 'It offered to pass this to your team.',
  hours_slot: 'Opening hours come from your business profile.',
  unreviewed_used: "It used a fact you haven't reviewed.",
  crisis: 'It would share crisis contacts and flag the chat for your team.',
  abuse_warning: 'It would warn the customer about their language.',
  abuse_ended: 'It would end its part in the chat and flag it for your team.',
};

const UNAVAILABLE_TEXT =
  "Your assistant couldn't reach its AI service, so customers would get your fallback message.";

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The "Why" sentences, without repeats (advice/illegal and injection/impersonation share one). */
export function reasonSentences(e: Explainer): string[] {
  const labels = list(e.facts.filter((f) => f.used).map((f) => f.label));
  const out = e.reasons.map((r) => REASON_TEXT[r].replace('{labels}', labels || 'your facts'));
  if (e.outcome === 'unavailable') out.push(UNAVAILABLE_TEXT);
  return [...new Set(out)];
}

/** The explainer's collapsed line: "Used 2 facts · Why?". */
export function explainerSummary(e: Explainer): string {
  const n = e.facts.filter((f) => f.used).length;
  return n === 0 ? 'No facts used' : `Used ${n} fact${n === 1 ? '' : 's'}`;
}

/** What customers get instead, from `visitorsWouldGet`; null when it's the same. */
export function visitorsLine(
  e: Explainer,
): { tone: 'warning' | 'info' | 'caption'; text: string } | null {
  switch (e.visitorsWouldGet) {
    case 'same':
      return null;
    case 'without_unreviewed':
      return {
        tone: 'warning',
        text: "Customers wouldn't get this answer: it uses facts you haven't approved.",
      };
    case 'fallback_paused':
      return {
        tone: 'info',
        text: 'Your assistant is paused, so customers get your fallback message.',
      };
    case 'not_live':
      return {
        tone: 'caption',
        text: "Your assistant isn't live yet. This is what customers will get.",
      };
  }
}

/** "9:00 am" for `09:00`; `24:00` is midnight. */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const hour = h % 24;
  const ap = hour < 12 ? 'am' : 'pm';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(m).padStart(2, '0')} ${ap}`;
}

/** "Sat 9:00 am – 5:00 pm", or "Sun closed". */
export function hoursLabel(day: Weekday, intervals: { open: string; close: string }[]): string {
  const name = WEEKDAY_NAMES[day].slice(0, 3);
  if (!intervals.length) return `${name} closed`;
  return `${name} ${intervals.map((i) => `${clockLabel(i.open)} – ${clockLabel(i.close)}`).join(', ')}`;
}

export interface DiffRow {
  label: string;
  was: string | null;
  now: string;
}

const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  price: 'Price',
  unit: 'Unit',
  question: 'Question',
  answer: 'Answer',
  title: 'Title',
  details: 'Details',
};

function fieldText(key: string, v: FactValueView): string {
  const raw = v.value[key];
  if (raw === undefined || raw === null) return '';
  if (key === 'price') {
    const gst =
      v.gstTreatment && v.gstTreatment !== 'unknown' ? ` · ${GST_LABEL[v.gstTreatment]}` : '';
    return `${sgd(String(raw))}${gst}`;
  }
  return String(raw);
}

/** The proposal's diff, a row per changed field or day ("Was" struck through, "Now"). */
export function diffRows(change: ProposedChange): DiffRow[] {
  switch (change.kind) {
    case 'edit_fact': {
      const keys = [
        ...new Set([...Object.keys(change.before.value), ...Object.keys(change.after.value)]),
      ];
      const rows: DiffRow[] = keys
        .filter((k) => k in FIELD_LABEL)
        .map((k) => ({
          label: FIELD_LABEL[k]!,
          was: fieldText(k, change.before) || null,
          now: fieldText(k, change.after),
        }))
        .filter((r) => r.was !== r.now);
      const until = (v: FactValueView) => (v.validUntil ? dayLabel(v.validUntil) : '');
      if (until(change.before) !== until(change.after))
        rows.push({ label: 'Ends', was: until(change.before) || null, now: until(change.after) });
      if (
        change.before.gstTreatment !== change.after.gstTreatment &&
        !rows.some((r) => r.label === 'Price')
      )
        rows.push({
          label: 'GST',
          was: change.before.gstTreatment ? GST_LABEL[change.before.gstTreatment] : null,
          now: change.after.gstTreatment ? GST_LABEL[change.after.gstTreatment] : '',
        });
      return rows;
    }
    case 'add_faq':
      return [
        { label: 'Question', was: null, now: change.question },
        { label: 'Answer', was: null, now: change.answer },
      ];
    case 'edit_hours':
      return WEEKDAYS.filter((d) => change.after[d] !== undefined).map((d) => ({
        label: WEEKDAY_NAMES[d],
        was: change.before[d] ? hoursLabel(d, change.before[d]!) : null,
        now: hoursLabel(d, change.after[d]!),
      }));
    case 'reconfirm':
    case 'answer_gap':
      return [];
  }
}

/** The proposal card's subject: "Product · Chocolate fudge cake", "New FAQ", "Opening hours". */
export function changeSubject(change: ProposedChange): string {
  switch (change.kind) {
    case 'edit_fact':
    case 'reconfirm':
      return `${TYPE_LABEL[change.factType]} · ${change.label}`;
    case 'add_faq':
    case 'answer_gap':
      return 'New FAQ';
    case 'edit_hours':
      return 'Opening hours';
  }
}

/** "Changed. Customers get the new price now." */
export function confirmedLine(change: ProposedChange): string {
  if (change.kind === 'reconfirm') return 'Confirmed. Customers keep getting this answer.';
  const what =
    change.kind === 'edit_hours'
      ? 'hours'
      : change.kind === 'add_faq' || change.kind === 'answer_gap'
        ? 'answer'
        : 'price' in change.after.value && change.after.value.price !== change.before.value.price
          ? 'price'
          : change.factType === 'faq'
            ? 'answer'
            : 'details';
  return `Changed. Customers get the new ${what} now.`;
}

/** The quick panel's prefill for a fact (ui-design, quick coach panel). */
export function prefillFor(f: Pick<Fact, 'type' | 'value'>): string {
  switch (f.type) {
    case 'product':
      return `How much is ${(f.value as { name: string }).name}?`;
    case 'faq':
      return (f.value as { question: string }).question;
    case 'policy':
      return `What's your ${(f.value as { title: string }).title}?`;
    case 'promotion':
      return `Is the ${(f.value as { title: string }).title} still on?`;
  }
}

/** Below 768 px the panel opens the full Coach page instead (UX-Q3). */
export const PANEL_MIN_WIDTH = 768;

/** Where "Ask Coach" goes on a narrow screen: `/coach?ask=…` (and `&unreviewed=1`). */
export function coachAskHref(f: Pick<Fact, 'type' | 'value' | 'status'>): string {
  return askHref(prefillFor(f), f.status === 'needs_review');
}

/** `/coach?ask=…` for any question (Replay's "Teach a fix", FEAT-028). */
export function askHref(question: string, unreviewed: boolean): string {
  const q = new URLSearchParams({ ask: question });
  if (unreviewed) q.set('unreviewed', '1');
  return `/coach?${q.toString()}`;
}

const RELATIVE = new Intl.RelativeTimeFormat('en-SG', { numeric: 'auto' });
const DAY_FMT = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Singapore',
});

/** "5 minutes ago", "yesterday", then "21 Oct". */
export function relativeTime(iso: string, now = new Date()): string {
  const s = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  if (s > -60) return 'just now';
  if (s > -3600) return RELATIVE.format(Math.round(s / 60), 'minute');
  if (s > -86_400) return RELATIVE.format(Math.round(s / 3600), 'hour');
  if (s > -2 * 86_400) return RELATIVE.format(-1, 'day');
  return DAY_FMT.format(new Date(iso));
}

/** The assistant's name for the chat's labels; the settings default when unset. */
export function useBotName(): string {
  const settings = useQuery({ queryKey: ['assistant-settings'], queryFn: api.assistantSettings });
  return settings.data?.settings.botName || settings.data?.defaults.botName || 'Your assistant';
}

/** "Ask Coach" opens the slide-over at 768 px and wider, else the Coach page (UX-Q3). */
export const opensPanel = (viewportWidth: number) => viewportWidth >= PANEL_MIN_WIDTH;

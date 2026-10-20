import { sgDayLabel, sgLastDayOf, type GstTreatment, type VisitorFact } from '@kaki/kb';
import { SLOT_FIELDS, SLOT_RE, type TurnFacts } from './slots.js';
import type { Violation } from './verify.js';

/** Singapore GST rate since 1 Jan 2024. KB-15 quotes GST-inclusive prices. */
export const SG_GST_PERCENT = 9;

/** `S$1,234.50` (NFR-10, design.md §6). */
export function formatSgd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `S$${String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${rest}`;
}

/** Adds GST to an exclusive amount, rounding half up to the cent. */
export function withGst(cents: number): number {
  return Math.floor((cents * (100 + SG_GST_PERCENT) + 50) / 100);
}

/**
 * The visitor-facing price (KB-15) of a product or a priced promotion: a GST-registered
 * tenant always quotes the GST-inclusive amount; an unregistered tenant quotes the
 * price as stored.
 */
export function renderPrice(
  fact: { value: { priceCents: number }; gstTreatment: GstTreatment | null },
  gstRegistered: boolean,
): string {
  const cents = fact.value.priceCents;
  if (gstRegistered && fact.gstTreatment === 'exclusive')
    return `${formatSgd(withGst(cents))} incl. GST`;
  return formatSgd(cents);
}

/** The last day a promotion runs, "31 Oct 2026" (NFR-10), or null when open-ended. */
export function renderValidUntil(fact: Extract<VisitorFact, { type: 'promotion' }>): string | null {
  return fact.validUntil ? sgDayLabel(sgLastDayOf(fact.validUntil)) : null;
}

export type RenderResult =
  | { ok: true; text: string; spans: [number, number][]; factIds: string[] }
  | { ok: false; violations: Violation[] };

function fieldValue(fact: VisitorFact, field: string, gstRegistered: boolean): string | null {
  switch (fact.type) {
    case 'product':
      if (field === 'price') return renderPrice(fact, gstRegistered);
      if (field === 'name') return fact.value.name;
      if (field === 'unit') return fact.value.unit ?? null;
      return null;
    case 'faq':
      if (field === 'question') return fact.value.question;
      if (field === 'answer') return fact.value.answer;
      return null;
    case 'policy':
      if (field === 'title') return fact.value.title;
      if (field === 'details') return fact.value.details;
      return null;
    case 'promotion': {
      const { priceCents } = fact.value;
      if (field === 'title') return fact.value.title;
      if (field === 'details') return fact.value.details;
      if (field === 'price')
        return priceCents === undefined
          ? null
          : renderPrice({ value: { priceCents }, gstTreatment: fact.gstTreatment }, gstRegistered);
      if (field === 'valid_until') return renderValidUntil(fact);
      return null;
    }
  }
}

/**
 * Replaces every slot with its KB value (ADR-008 decision 1). Returns the rendered
 * text, the character ranges that came from slots (the verifier's protected spans) and
 * the facts used. A slot naming a fact or field outside this turn's set fails.
 */
export function renderSegment(raw: string, facts: TurnFacts, gstRegistered: boolean): RenderResult {
  let text = '';
  const spans: [number, number][] = [];
  const used = new Set<string>();
  const violations: Violation[] = [];
  let last = 0;
  for (const m of raw.matchAll(SLOT_RE)) {
    const [token, ref, field] = m as unknown as [string, string, string];
    const fact = facts.byRef.get(ref);
    const allowed = fact ? (SLOT_FIELDS[fact.type] as readonly string[]).includes(field) : false;
    const value = fact && allowed ? fieldValue(fact, field, gstRegistered) : null;
    if (!fact || value === null) {
      violations.push({ kind: fact ? 'unknown_field' : 'unknown_fact', text: token });
      continue;
    }
    let before = raw.slice(last, m.index);
    // The model sometimes types a currency sign before a price slot; the slot has one.
    if (field === 'price') before = before.replace(/(?:S\$|SGD|\$)\s?$/i, '');
    text += before;
    spans.push([text.length, text.length + value.length]);
    text += value;
    used.add(fact.id);
    last = m.index + token.length;
  }
  if (violations.length) return { ok: false, violations };
  text += raw.slice(last);
  return { ok: true, text, spans, factIds: [...used] };
}

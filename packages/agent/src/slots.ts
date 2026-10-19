import type { VisitorFact } from '@kaki/kb';

/**
 * Fact slots (ADR-008 decision 1): the model writes `[[f:<ref>.<field>]]` and the
 * renderer fills in the value. `<ref>` is the fact ID's first 8 hex characters,
 * lengthened when two facts in the same turn share a prefix.
 */
export const SLOT_RE = /\[\[f:([0-9a-f-]{4,36})\.([a-z_]+)\]\]/g;

export const SLOT_FIELDS = {
  product: ['name', 'price', 'unit'],
  faq: ['question', 'answer'],
} as const;

/** Fields whose value is protected: it may reach a visitor only through its slot. */
export const PROTECTED_FIELDS = {
  product: ['price'],
  faq: ['answer'],
} as const;

export interface TurnFacts {
  /** ref → fact, for this turn's retrieved facts only. */
  byRef: Map<string, VisitorFact>;
  refOf: Map<string, string>;
}

export function assignRefs(facts: VisitorFact[]): TurnFacts {
  const byRef = new Map<string, VisitorFact>();
  const refOf = new Map<string, string>();
  const hex = (id: string) => id.replaceAll('-', '').toLowerCase();
  for (const f of facts) {
    let len = 8;
    while (facts.some((o) => o.id !== f.id && hex(o.id).startsWith(hex(f.id).slice(0, len))))
      len += 4;
    const ref = hex(f.id).slice(0, Math.min(len, 32));
    byRef.set(ref, f);
    refOf.set(f.id, ref);
  }
  return { byRef, refOf };
}

/** Index of an unclosed `[[` at the end of `text`, or -1. A partial slot holds the buffer. */
export function openSlotAt(text: string): number {
  const open = text.lastIndexOf('[[');
  if (open === -1) return text.endsWith('[') ? text.length - 1 : -1;
  return text.indexOf(']]', open) === -1 ? open : text.endsWith('[') ? text.length - 1 : -1;
}

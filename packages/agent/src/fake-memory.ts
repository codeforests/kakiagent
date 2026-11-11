import type { GenerateRequest } from '@kaki/llm-gateway';
import { EMPTY_MEMORY, parseMemory, type ConversationMemory } from './memory.js';

/**
 * The fake provider's summariser (FEAT-026 §5.5): deterministic keyword rules over the
 * visitor lines of `<messages>`, on top of `<previous>`. For local development, tests and
 * the eval runner; the real model is measured on the eval set.
 */

const UNITS = 'pcs|pieces|boxes|box|cakes|cake|people|pax|trays|tray|dozen';
const ITEM = new RegExp(
  `(\\d+)\\s*(${UNITS})(?:\\s+(?:of\\s+)?((?:[a-z][a-z-]*)(?:\\s+(?!for\\b|on\\b|by\\b|at\\b|please\\b)[a-z][a-z-]*){0,3}))?`,
  'gi',
);
const ITEM_ZH = /(\d+)\s*(个|盒|份|位)(\p{Script=Han}{1,6})?/gu;
const CHANGE = /\b(?:make it|change (?:it )?to|actually)\s+(\d+)\b|改成\s*(\d+)/i;
const NAME =
  /\b(?:[Mm]y name is|I am|I'm|[Tt]his is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)|我叫\s*(\p{Script=Han}{1,4})/u;
const DATES = [
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/gi,
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi,
  /\btomorrow\b/gi,
  /\d{1,2}月\d{1,2}[日号]/g,
];

function previousOf(content: string): ConversationMemory {
  const raw = /<previous>\n([\s\S]*?)\n<\/previous>/.exec(content)?.[1] ?? 'none';
  if (raw === 'none') return structuredClone(EMPTY_MEMORY);
  try {
    return (
      parseMemory(JSON.parse(raw.replaceAll('‹', '<').replaceAll('›', '>'))) ??
      structuredClone(EMPTY_MEMORY)
    );
  } catch {
    return structuredClone(EMPTY_MEMORY);
  }
}

function visitorLines(content: string): string[] {
  const block = /<messages>\n([\s\S]*?)\n?<\/messages>/.exec(content)?.[1] ?? '';
  return block
    .split('\n')
    .filter((l) => l.startsWith('visitor: '))
    .map((l) => l.slice('visitor: '.length));
}

function setItem(m: ConversationMemory, what: string, quantity: string) {
  const at = m.items.findIndex((i) => i.what.toLowerCase() === what.toLowerCase());
  if (at >= 0) m.items[at] = { what: m.items[at]!.what, quantity };
  else m.items.push({ what, quantity });
}

export function fakeSummary(req: GenerateRequest): string {
  const content = req.messages.at(-1)?.content ?? '';
  const m = previousOf(content);
  for (const line of visitorLines(content)) {
    const name = NAME.exec(line);
    if (name) m.visitorName = (name[1] ?? name[2] ?? '').trim() || m.visitorName;
    let found = false;
    for (const [, n, unit, rest] of line.matchAll(ITEM)) {
      setItem(m, rest ? `${unit} of ${rest}`.toLowerCase() : unit!.toLowerCase(), n!);
      found = true;
    }
    for (const [, n, unit, rest] of line.matchAll(ITEM_ZH)) {
      setItem(m, `${unit}${rest ?? ''}`, n!);
      found = true;
    }
    const change = CHANGE.exec(line);
    if (!found && change && m.items.length > 0) {
      const last = m.items[m.items.length - 1]!;
      last.quantity = change[1] ?? change[2] ?? last.quantity;
    }
    for (const re of DATES)
      for (const [d] of line.matchAll(re)) if (!m.dates.includes(d)) m.dates.push(d);
  }
  return JSON.stringify({
    ...m,
    items: m.items.slice(-8),
    dates: m.dates.slice(-4),
  });
}

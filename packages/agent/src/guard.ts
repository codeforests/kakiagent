import type { GenerateRequest } from '@kaki/llm-gateway';
import type { Violation } from './verify.js';

/**
 * The leak guard (AGT-07, AGT-16; FEAT-025 §5.3, D5): a reply segment must not repeat
 * the platform's instructions. Deterministic, so the fake provider can prove it (plan
 * P10): the prompt's structural markers anywhere in the model-typed text, or any run of
 * `WINDOW` words from the rule text. Slot renderings are the tenant's public values and
 * are not scanned.
 */

/** Words in a run that counts as a leak; shorter runs match the platform's own phrases. */
export const WINDOW = 10;

/** The prompt's own vocabulary: no visitor-facing reply ever needs it. */
export const LEAK_MARKERS: RegExp[] = [
  /[<‹]\s*\/?\s*(?:business|facts|assistant)\s*[>›]/iu,
  /\[f:[0-9a-f]{4,36}\]/iu,
  /\bslot\s+rule\b/iu,
  /\bslot\s+tokens?\b/iu,
  /\bprotected\s+fields?\b/iu,
  /\bfact\s+checker\b/iu,
  /\breply\s+language\s*:/iu,
  /\bvisitor\s+register\s*:/iu,
  /\bcurrent\s+time\s+in\s+singapore\s*:/iu,
  /\byou\s+classify\s+the\s+latest\s+visitor\s+message\b/iu,
  /\bcustomer\s+assistant\s+on\s+the\s+website\s+of\s+a\s+business\b/iu,
];

const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Every `WINDOW`-word run of `text`, joined by single spaces. */
export function windows(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + WINDOW <= w.length; i++) out.add(w.slice(i, i + WINDOW).join(' '));
  return out;
}

/**
 * The rule text of a reply request: `system` up to the tenant block, and the tail
 * without its facts block. Fact and profile values are the tenant's data, never rules.
 */
export function ruleText(req: Pick<GenerateRequest, 'system' | 'tail'>): string {
  const system = req.system ?? '';
  const cut = system.indexOf('<business>');
  const tail = (req.tail ?? '').replace(/<facts>[\s\S]*?<\/facts>/u, ' ');
  return `${cut === -1 ? system : system.slice(0, cut)}\n${tail}`;
}

export interface LeakGuard {
  check(text: string, spans: [number, number][]): Violation[];
}

/** Built once per reply request; `check` takes a rendered segment and its slot spans. */
export function leakGuard(req: Pick<GenerateRequest, 'system' | 'tail'>): LeakGuard {
  const rules = windows(ruleText(req));
  return {
    check(text, spans) {
      const typed = modelTyped(text, spans);
      const found: Violation[] = [];
      for (const re of LEAK_MARKERS) {
        const m = re.exec(typed);
        if (m) found.push({ kind: 'prompt_leak', text: m[0] });
      }
      for (const w of windows(typed))
        if (rules.has(w)) {
          found.push({ kind: 'prompt_leak', text: w });
          break;
        }
      return found;
    },
  };
}

/** The segment without its slot renderings: only what the model typed (as in `verifySegment`). */
function modelTyped(text: string, spans: [number, number][]): string {
  let out = '';
  let pos = 0;
  for (const ch of text) {
    out += spans.some(([s, e]) => pos >= s && pos < e) ? ' ' : ch;
    pos += ch.length;
  }
  return out;
}

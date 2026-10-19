import { openSlotAt } from './slots.js';

/** Release at the last word boundary once a segment reaches this length (ADR-008 decision 4). */
export const MAX_SEGMENT_CHARS = 160;

const SENTENCE_END = /[.!?。！？]/;
const CJK_END = /[。！？]/;
const HOLD_LINE = /(?:\$|[€£¥:：]|\b(?:sgd|usd|rm))\s*$/i;

/**
 * Incremental segmenter over raw model text (slots still unrendered). A segment ends
 * at a sentence end followed by whitespace (or a CJK full stop), at a line break, or at
 * the last word boundary before 160 characters. It never ends inside an open `[[` slot,
 * so a partial slot always holds the buffer.
 */
export class Segmenter {
  private buf = '';

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut === -1) break;
      const seg = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut).replace(/^\s+/, '');
      if (seg) out.push(seg);
    }
    return out;
  }

  /** The rest of the buffer at stream end. */
  flush(): string | null {
    const seg = this.buf.trim();
    this.buf = '';
    return seg || null;
  }

  private findCut(): number {
    const b = this.buf;
    const open = openSlotAt(b);
    const limit = open === -1 ? b.length : open;
    for (let i = 0; i < limit; i++) {
      const c = b[i]!;
      // A line ending in a currency sign or a colon belongs with the next line, so a
      // price is never verified in two halves (acceptance DD2).
      if (c === '\n') {
        if (HOLD_LINE.test(b.slice(0, i))) continue;
        return i + 1;
      }
      if (inSlot(b, i)) continue;
      if (CJK_END.test(c)) return i + 1;
      if (SENTENCE_END.test(c)) {
        const next = b[i + 1];
        if (next === undefined) return -1; // wait: the next character decides
        if (/\s/.test(next)) return i + 1;
      }
    }
    if (b.length >= MAX_SEGMENT_CHARS) {
      const window = b.slice(0, Math.min(MAX_SEGMENT_CHARS, limit));
      for (let i = window.length - 1; i > 0; i--) {
        if (/\s/.test(window[i]!) && !inSlot(b, i)) return i;
      }
    }
    return -1;
  }
}

/** True when position `i` is inside a complete `[[…]]` slot. */
function inSlot(text: string, i: number): boolean {
  const open = text.lastIndexOf('[[', i);
  if (open === -1) return false;
  const close = text.indexOf(']]', open);
  return close === -1 || i < close + 2;
}

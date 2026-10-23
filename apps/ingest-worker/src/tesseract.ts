import { OcrUnavailableError, type OcrEngine } from '@kaki/kb';
import { run } from './exec.js';

const LANGS = ['eng', 'chi_sim'];
const CJK = '\\p{Script=Han}\\u3000-\\u303f\\uff00-\\uffef';
/** Tesseract spaces out every CJK character; Chinese has no spaces between words. */
const CJK_GAP = new RegExp(`(?<=[${CJK}]) +(?=[${CJK}])`, 'gu');

/**
 * Tesseract's TSV as text and a confidence (FEAT-015 §5.4): words regrouped into lines
 * by block, paragraph and line; the confidence is the mean of word confidences weighted
 * by word length, 0..1 (words below 0 aren't words).
 */
export function readTsv(tsv: string): { text: string; confidence: number } {
  const lines = new Map<string, string[]>();
  let weighted = 0;
  let chars = 0;
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const word = c.slice(11).join('\t').trim();
    const conf = Number(c[10]);
    if (!word || !(conf >= 0)) continue;
    const key = `${c[1]}/${c[2]}/${c[3]}/${c[4]}`;
    const line = lines.get(key);
    if (line) line.push(word);
    else lines.set(key, [word]);
    weighted += conf * word.length;
    chars += word.length;
  }
  const text = [...lines.values()].map((ws) => ws.join(' ').replace(CJK_GAP, '')).join('\n');
  return { text, confidence: chars ? Math.round(weighted / chars) / 100 : 0 };
}

/** The `tesseract` CLI with `eng+chi_sim` (ADR-019), 60 s per page. */
export function tesseractOcr(cfg: { path: string; timeoutMs?: number }): OcrEngine & {
  /** True when the binary runs and has both languages (`/readyz`). */
  healthy(): Promise<boolean>;
} {
  return {
    async recognize(png) {
      let out: Buffer;
      try {
        out = await run(cfg.path, ['stdin', 'stdout', '-l', LANGS.join('+'), '--psm', '3', 'tsv'], {
          input: png,
          timeoutMs: cfg.timeoutMs ?? 60_000,
        });
      } catch (err) {
        throw new OcrUnavailableError('tesseract failed', { cause: err });
      }
      return readTsv(out.toString('utf8'));
    },
    async healthy() {
      try {
        const out = (await run(cfg.path, ['--list-langs'], { timeoutMs: 10_000 })).toString();
        const have = new Set(out.split('\n').map((l) => l.trim()));
        return LANGS.every((l) => have.has(l));
      } catch {
        return false;
      }
    },
  };
}

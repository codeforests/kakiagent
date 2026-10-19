import { EMBEDDING_DIMENSIONS } from '../types.js';

/**
 * Deterministic local embedder (D5 in FEAT-022's design): hashed words and character
 * trigrams, signed and L2-normalised. Texts that share words or word stems land close
 * together, which is enough for tests and local demos. It is not a semantic model;
 * retrieval quality is judged with Cohere on Bedrock at MD.
 */
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);
  for (const w of words) {
    add(v, `w:${w}`, 1);
    // CJK has no spaces: characters and pairs act as words.
    const chars = [...w];
    if (/\p{Script=Han}/u.test(w)) {
      for (let i = 0; i < chars.length; i++) {
        add(v, `c:${chars[i]}`, 0.5);
        if (i + 1 < chars.length) add(v, `c:${chars[i]}${chars[i + 1]}`, 0.8);
      }
      continue;
    }
    const padded = `^${w}$`;
    for (let i = 0; i + 3 <= padded.length; i++) add(v, `t:${padded.slice(i, i + 3)}`, 0.3);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

/** Crude English plural stemming, so "cakes" matches "cake". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function add(v: number[], feature: string, weight: number) {
  const h = fnv1a(feature);
  const sign = h & 1 ? 1 : -1;
  v[(h >>> 1) % v.length]! += sign * weight;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

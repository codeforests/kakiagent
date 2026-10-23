import { decodeXml, unzipSome } from '../files/parse.js';
import type { SheetRow } from './table.js';

export type XlsxOutcome =
  { ok: true; name: string; rows: SheetRow[] } | { ok: false; failure: 'unreadable' | 'no_rows' };

const attrs = (s: string) =>
  Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!, decodeXml(m[2]!)]));

/** OOXML's `_xHHHH_` escapes (a line break in a cell is often `_x000D_`). */
const unescapeOoxml = (s: string) =>
  s.replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** The text of a string item: its `t` runs joined, phonetic hints (`rPh`) left out. */
function itemText(xml: string): string {
  const runs = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g);
  return unescapeOoxml(decodeXml([...runs].map((m) => m[1]!).join('')));
}

/** "B" → 1, "AA" → 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A stored number without float noise: 0.30000000000000004 → "0.3". */
export function numberText(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
}

/**
 * Reads the first sheet of an XLSX workbook that isn't hidden and has a cell (FEAT-016
 * §5.3 step 3; D2, D9): shared and inline strings, cached formula values, booleans and
 * numbers; errors are empty. Formulas are never evaluated. Each row keeps its row number.
 */
export function readXlsx(bytes: Uint8Array): XlsxOutcome {
  const parts = unzipSome(
    bytes,
    (n) => (n.startsWith('xl/') && n.endsWith('.xml')) || n.endsWith('.rels'),
  );
  if (!parts) return { ok: false, failure: 'unreadable' };
  const workbook = parts.get('xl/workbook.xml');
  const rels = parts.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return { ok: false, failure: 'unreadable' };
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((m) => {
      const a = attrs(m[1]!);
      const t = a.Target ?? '';
      return [a.Id, t.startsWith('/') ? t.slice(1) : `xl/${t}`];
    }),
  );
  const shared = [
    ...(parts.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g),
  ].map((m) => (m[1] === undefined ? '' : itemText(m[1])));
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]!));
  if (!sheets.length) return { ok: false, failure: 'unreadable' };
  for (const sheet of sheets) {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') continue;
    const xml = parts.get(targets.get(sheet['r:id']) ?? '');
    if (xml === undefined) return { ok: false, failure: 'unreadable' };
    const rows = sheetRows(xml, shared);
    if (rows === null) return { ok: false, failure: 'unreadable' };
    if (rows.some((r) => r.cells.some((c) => c !== '')))
      return { ok: true, name: sheet.name ?? '', rows };
  }
  return { ok: false, failure: 'no_rows' };
}

function sheetRows(xml: string, shared: string[]): SheetRow[] | null {
  const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!data) return null;
  const rows: SheetRow[] = [];
  let lastRow = 0;
  for (const m of (data[1] ?? '').matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = Number(attrs(m[1]!).r ?? lastRow + 1);
    if (!Number.isInteger(row) || row <= lastRow) return null;
    lastRow = row;
    const cells: string[] = [];
    let col = -1;
    for (const c of (m[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]!);
      const ref = a.r ? /^([A-Z]{1,3})\d+$/i.exec(a.r) : null;
      if (a.r && !ref) return null;
      col = ref ? columnIndex(ref[1]!) : col + 1;
      if (col < 0 || col >= 16384) return null;
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text: string;
      switch (a.t) {
        case 's':
          text = shared[Number(v)] ?? '';
          break;
        case 'inlineStr':
          text = itemText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
          break;
        case 'str':
          text = v === undefined ? '' : unescapeOoxml(decodeXml(v));
          break;
        case 'b':
          text = v === undefined ? '' : v === '1' ? 'TRUE' : 'FALSE';
          break;
        case 'e':
          text = '';
          break;
        default:
          text = v === undefined ? '' : numberText(v);
      }
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    rows.push({ row, cells });
  }
  return rows;
}

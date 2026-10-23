import type { SheetRow } from './table.js';

const DELIMITERS = [',', ';', '\t'] as const;

/** The delimiter used most in the first record, outside quotes; a comma on a tie. */
export function delimiterOf(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: string = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Reads CSV text (RFC 4180; FEAT-016 §5.3 step 2): quoted fields with `""` escapes and
 * line breaks inside quotes, CRLF or LF, and the delimiter of `delimiterOf`. Each record
 * keeps its 1-based position as its row number. A BOM must already be gone (TextDecoder
 * drops it).
 */
export function readCsv(text: string): SheetRow[] {
  const delimiter = delimiterOf(text);
  const rows: SheetRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let row = 1;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push({ row, cells });
    cells = [];
    row += 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') endRow();
    else cell += ch;
  }
  if (cell !== '' || cells.length) endRow();
  return rows;
}

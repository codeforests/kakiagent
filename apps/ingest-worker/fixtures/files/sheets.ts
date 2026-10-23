import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import {
  PRICE_LIST_500,
  PRICE_LIST_HEADER,
  PRICE_LIST_ROWS,
  PRICE_LIST_TITLE,
  SERVICES_CSV,
} from './content.js';

/**
 * The spreadsheet fixtures (FEAT-016 §5.10), written with fflate from XML strings so no
 * spreadsheet library is needed. `generate.ts` runs this too; on its own:
 * `pnpm --filter @kaki/ingest-worker fixtures:sheets`.
 */
const DIR = fileURLToPath(new URL('.', import.meta.url));
const out = (name: string, bytes: Uint8Array | string) => {
  writeFileSync(join(DIR, name), bytes);
  console.warn(`wrote ${name}`);
};

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const col = (i: number) => String.fromCharCode(65 + i);

type Cell = string | { formula: string; value: string };

/** A workbook whose text cells are shared strings and number cells numbers, as Excel saves. */
function workbook(sheets: { name: string; rows: Cell[][]; hidden?: boolean }[]): Uint8Array {
  const shared: string[] = [];
  const sst = (t: string) => {
    const i = shared.indexOf(t);
    return i >= 0 ? i : shared.push(t) - 1;
  };
  const sheetXml = (rows: Cell[][]) =>
    xml(
      `<worksheet ${NS}><sheetData>${rows
        .map((cells, r) => {
          const n = r + 1;
          const cs = cells
            .map((c, i) => {
              const ref = `${col(i)}${n}`;
              if (typeof c !== 'string')
                return `<c r="${ref}"><f>${esc(c.formula)}</f><v>${c.value}</v></c>`;
              if (c === '') return '';
              if (/^-?\d+(\.\d+)?$/.test(c)) return `<c r="${ref}"><v>${c}</v></c>`;
              return `<c r="${ref}" t="s"><v>${sst(c)}</v></c>`;
            })
            .join('');
          return cs ? `<row r="${n}">${cs}</row>` : '';
        })
        .join('')}</sheetData></worksheet>`,
    );
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows))));
  files['[Content_Types].xml'] = strToU8(
    xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ),
  );
  files['_rels/.rels'] = strToU8(
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
  );
  files['xl/workbook.xml'] = strToU8(
    xml(
      `<workbook ${NS} xmlns:r="${R}"><sheets>${sheets
        .map(
          (s, i) =>
            `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`,
        )
        .join('')}</sheets></workbook>`,
    ),
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId${sheets.length + 1}" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
  );
  files['xl/sharedStrings.xml'] = strToU8(
    xml(
      `<sst ${NS} count="${shared.length}" uniqueCount="${shared.length}">${shared.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`,
    ),
  );
  // A fixed time, so regenerating gives the same bytes.
  return zipSync(files, { mtime: new Date('2026-01-01T00:00:00') });
}

export function writeSheetFixtures() {
  out(
    'price-list.xlsx',
    workbook([
      { name: 'Prices', rows: [[PRICE_LIST_TITLE], [], PRICE_LIST_HEADER, ...PRICE_LIST_ROWS] },
    ]),
  );
  out(
    'hidden-first.xlsx',
    workbook([
      {
        name: 'Cost prices',
        hidden: true,
        rows: [
          ['Product', 'Cost'],
          ['Secret cake', '9'],
        ],
      },
      {
        name: 'Menu',
        rows: [
          ['Product', 'Price'],
          ['Kopi', '1.80'],
          ['Teh', '1.60'],
        ],
      },
    ]),
  );
  out('services.csv', SERVICES_CSV);
  out('price-list-500.csv', PRICE_LIST_500);
  // Windows-1252, as Excel's plain "CSV" saves "Café latte" on Windows.
  out(
    'latin1.csv',
    new Uint8Array([...strToU8('Product,Price\r\nCaf'), 0xe9, ...strToU8(' latte,4.50\r\n')]),
  );
  // A password-protected workbook is the same OLE container as a protected .docx
  // (MS-OFFCRYPTO); a legacy .xls is an OLE file too. Both from generate.ts's container.
  const ole = readFileSync(join(DIR, 'protected.docx'));
  out('protected.xlsx', ole);
  out('legacy.xls', ole);
}

if (import.meta.url === `file://${process.argv[1]}`) writeSheetFixtures();

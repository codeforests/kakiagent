import { strToU8, zipSync } from 'fflate';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * A one-sheet XLSX with every cell an inline string, or a number when it is one (FEAT-016
 * tests). Rows are numbered from 1; `null` rows are left out (a gap in the sheet).
 */
export function makeXlsx(rows: (string[] | null)[], sheetName = 'Prices'): Uint8Array {
  const body = rows
    .map((cells, r) =>
      cells
        ? `<row r="${r + 1}">${cells
            .map((c, i) => {
              const ref = `${letter(i)}${r + 1}`;
              if (c === '') return '';
              return /^-?\d+(\.\d+)?$/.test(c)
                ? `<c r="${ref}"><v>${c}</v></c>`
                : `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
            })
            .join('')}</row>`
        : '',
    )
    .join('');
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      `<workbook xmlns:r="${rel}"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${body}</sheetData></worksheet>`),
  });
}

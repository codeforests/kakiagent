import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { columnIndex, numberText, readXlsx } from './xlsx.js';

const WB_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A minimal workbook: sheets as `[name, sheetXml, state?]`, plus shared strings. */
function workbook(sheets: [string, string, string?][], shared: string[] = []): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      `<workbook xmlns:r="${WB_REL}"><sheets>${sheets
        .map(
          ([n, , st], i) =>
            `<sheet name="${n}" sheetId="${i + 1}"${st ? ` state="${st}"` : ''} r:id="rId${i + 1}"/>`,
        )
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships>${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${WB_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('')}</Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.join('')}</sst>`),
  };
  sheets.forEach(([, xml], i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml)));
  return zipSync(files);
}
const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

describe('readXlsx (FEAT-016 §5.3 step 3)', () => {
  it('reads shared, rich, inline and formula strings, numbers, booleans and errors', () => {
    const bytes = workbook(
      [
        [
          'Prices',
          sheet(
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
              '<row r="2"><c r="A2" t="inlineStr"><is><t>Kaya &amp; toast</t></is></c><c r="B2"><v>5.5</v></c><c r="C2" t="b"><v>1</v></c></row>' +
              '<row r="4"><c r="A4" t="str"><f>A2</f><v>Line_x000D_two</v></c><c r="B4"><f>B2*2</f><v>0.30000000000000004</v></c><c r="D4" t="e"><v>#DIV/0!</v></c></row>',
          ),
        ],
      ],
      [
        '<si><t>Product</t></si>',
        '<si><r><t>Pri</t></r><r><t xml:space="preserve">ce</t></r><rPh><t>ignored</t></rPh></si>',
      ],
    );
    expect(readXlsx(bytes)).toEqual({
      ok: true,
      name: 'Prices',
      rows: [
        { row: 1, cells: ['Product', 'Price'] },
        { row: 2, cells: ['Kaya & toast', '5.5', 'TRUE'] },
        { row: 4, cells: ['Line\rtwo', '0.3', '', ''] },
      ],
    });
  });

  it('places cells by reference, and cells without one after the previous', () => {
    const r = readXlsx(
      workbook([['S', sheet('<row r="3"><c r="C3"><v>1</v></c><c><v>2</v></c><c r="F3"/></row>')]]),
    );
    expect(r).toEqual({
      ok: true,
      name: 'S',
      rows: [{ row: 3, cells: ['', '', '1', '2', '', ''] }],
    });
  });

  it('passes over hidden and empty sheets to the first visible one with a cell', () => {
    const r = readXlsx(
      workbook([
        ['Secret', sheet('<row r="1"><c r="A1"><v>9</v></c></row>'), 'hidden'],
        ['Empty', sheet('')],
        ['Menu', sheet('<row r="1"><c r="A1"><v>1</v></c></row>')],
      ]),
    );
    expect(r.ok && r.name).toBe('Menu');
  });

  it('is no_rows when no visible sheet has a cell, unreadable when broken', () => {
    expect(readXlsx(workbook([['A', sheet('<row r="1"/>')]]))).toEqual({
      ok: false,
      failure: 'no_rows',
    });
    expect(readXlsx(strToU8('not a zip'))).toEqual({ ok: false, failure: 'unreadable' });
    expect(readXlsx(zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }))).toEqual({
      ok: false,
      failure: 'unreadable',
    });
    expect(readXlsx(workbook([['A', '<worksheet></worksheet>']]))).toEqual({
      ok: false,
      failure: 'unreadable',
    });
    expect(readXlsx(workbook([['A', sheet('<row r="2"/><row r="1"/>')]]))).toEqual({
      ok: false,
      failure: 'unreadable',
    });
    expect(readXlsx(workbook([['A', sheet('<row r="1"><c r="1A"><v>1</v></c></row>')]]))).toEqual({
      ok: false,
      failure: 'unreadable',
    });
  });

  it('refuses a workbook that unzips past the cap (the zip-bomb guard)', () => {
    const big = new Uint8Array(101 * 1024 * 1024);
    const bytes = zipSync(
      {
        'xl/workbook.xml': strToU8('<workbook/>'),
        'xl/_rels/workbook.xml.rels': strToU8('<Relationships/>'),
        'xl/worksheets/sheet1.xml': big,
      },
      // Stored, not deflated: the cap counts unzipped bytes either way, and storing is fast.
      { level: 0 },
    );
    expect(readXlsx(bytes)).toEqual({ ok: false, failure: 'unreadable' });
    // Building the 101 MB entry takes about 1 s alone and passed 5 s on a loaded CI runner.
  }, 30_000);

  it('converts column letters and numbers', () => {
    expect(['A', 'Z', 'AA', 'xfd'].map(columnIndex)).toEqual([0, 25, 26, 16383]);
    expect(['5', '5.5', '1E3', '38.000000000000007', 'x'].map(numberText)).toEqual([
      '5',
      '5.5',
      '1000',
      '38',
      'x',
    ]);
  });
});

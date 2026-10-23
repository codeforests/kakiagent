import { strToU8, zipSync } from 'fflate';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { makePdf } from '../../../test/fixtures/pdf.js';
import {
  MAX_UNZIPPED_BYTES,
  parseFile,
  splitParts,
  tidy,
  xmlText,
  type ParseDeps,
} from './parse.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const MENU = 'Chocolate fudge cake (1 kg) — S$55.00\nPandan chiffon cake — S$26.00';

/** Fake OCR: reads the "image" bytes as text, so tests say what a scan shows. */
function fakeDeps(over: Partial<ParseDeps> = {}) {
  const ocr = {
    recognize: vi.fn(async (image: Uint8Array) => ({
      text: new TextDecoder().decode(image),
      confidence: 0.82,
    })),
  };
  const rasterizer = {
    render: vi.fn(async (_pdf: Uint8Array, n: number) => strToU8(`${MENU}\nScanned page ${n}`)),
  };
  return { deps: { ocr, rasterizer, ...over }, ocr, rasterizer };
}
/**
 * A one-entry ZIP deflated by Node's zlib: fflate's JavaScript deflate takes tens of
 * seconds on a 100 MB entry under coverage, zlib a fraction of one.
 */
function zipOne(name: string, data: Uint8Array): Uint8Array {
  const file = Buffer.from(name);
  const body = deflateRawSync(data, { level: 1 });
  const fields = (head: Buffer, at: number) => {
    head.writeUInt16LE(20, at); // version needed
    head.writeUInt16LE(8, at + 4); // deflate
    head.writeUInt32LE(crc32(data), at + 10);
    head.writeUInt32LE(body.length, at + 14);
    head.writeUInt32LE(data.length, at + 18);
    head.writeUInt16LE(file.length, at + 22);
  };
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  fields(local, 4);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  fields(central, 6);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + body.length, 16);
  return Buffer.concat([local, file, body, central, file, end]);
}
const docx = (body: string) =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
    ),
  });
const p = (...runs: string[]) =>
  `<w:p><w:pPr/>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join('')}</w:p>`;

describe('text helpers (FEAT-015 §5.4)', () => {
  it('tidies whitespace inside lines, keeps tabs and folds blank runs', () => {
    expect(tidy('  a   b \t c\r\n\r\n\r\n\r\nd  ')).toBe('a b\tc\n\nd');
  });
  it('splits into parts at line boundaries, cutting only a line longer than a part', () => {
    expect(splitParts('aaaa\nbbbb\ncc', 9)).toEqual(['aaaa\nbbbb', 'cc']);
    expect(splitParts('x'.repeat(20), 8)).toEqual(['x'.repeat(8), 'x'.repeat(8), 'x'.repeat(4)]);
  });
  it('reads Word XML: runs, tabs, breaks, entities, and tables as tab-separated rows', () => {
    const xml =
      p('Refund policy: within 7 days', ' &amp; with receipt') +
      '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C&#x4E2D;</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc>' +
      p('Kaya toast') +
      '</w:tc><w:tc>' +
      p('S$3.50') +
      '</w:tc></w:tr>' +
      '<w:tr><w:tc>' +
      p('Kopi') +
      '</w:tc><w:tc>' +
      p('S$1.80') +
      '</w:tc></w:tr></w:tbl>' +
      p('After the table');
    expect(tidy(xmlText(xml))).toBe(
      'Refund policy: within 7 days & with receipt\nA\tB\nC中\nKaya toast\tS$3.50\nKopi\tS$1.80\nAfter the table',
    );
  });
});

describe('parseFile (KB-02; FEAT-015 §5.4, D8)', () => {
  it('reads a PDF text layer page by page, sending only textless pages to OCR', async () => {
    const { deps, ocr, rasterizer } = fakeDeps();
    const pdf = makePdf([
      { lines: MENU.split('\n') },
      { jpeg: JPEG, width: 1, height: 1 },
      { lines: ['Q: Do you deliver on Sundays?', 'A: Yes, from 10 am to 4 pm.'] },
    ]);
    const out = await parseFile(pdf, 'pdf', deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pages.map((x) => [x.url, x.status, x.ocrConfidence])).toEqual([
      ['page/1', 'included', null],
      ['page/2', 'included', 0.82],
      ['page/3', 'included', null],
    ]);
    expect(out.pages[0]!.text).toBe(MENU);
    expect(out.pages[1]!.text).toContain('Scanned page 2');
    expect(rasterizer.render).toHaveBeenCalledTimes(1);
    expect(rasterizer.render.mock.calls[0]![1]).toBe(2);
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
  });

  it('excludes a page OCR finds no text on, and skips pages over the page and OCR limits', async () => {
    const { deps } = fakeDeps({
      rasterizer: { render: async (_pdf, n) => strToU8(n === 1 ? '  ' : `${MENU} ${n}`) },
      limits: { pages: 4, ocrPages: 2 },
    });
    const scan = { jpeg: JPEG, width: 1, height: 1 };
    const out = await parseFile(
      makePdf([scan, scan, scan, { lines: [MENU] }, scan, scan]),
      'pdf',
      deps,
    );
    if (!out.ok) throw new Error('not ok');
    expect(out.pages.map((x) => [x.url, x.status, x.reason])).toEqual([
      ['page/1', 'excluded', 'no_text'],
      ['page/2', 'included', null],
      ['page/3', 'skipped', 'ocr_limit'],
      ['page/4', 'included', null],
      ['page/5', 'skipped', 'page_limit'],
      ['page/6', 'skipped', 'page_limit'],
    ]);
  });

  it('rethrows an OCR failure so the stage is retried', async () => {
    const { deps } = fakeDeps({
      ocr: { recognize: async () => Promise.reject(new Error('tesseract')) },
    });
    await expect(
      parseFile(makePdf([{ jpeg: JPEG, width: 1, height: 1 }]), 'pdf', deps),
    ).rejects.toThrow('tesseract');
  });

  it('reads DOCX into parts and TXT into parts', async () => {
    const { deps } = fakeDeps();
    const out = await parseFile(
      docx(p('Q: Can I pay by PayNow?') + p('A: Yes, at the counter.')),
      'docx',
      deps,
    );
    expect(out).toEqual({
      ok: true,
      pages: [
        {
          url: 'part/1',
          status: 'included',
          reason: null,
          text: 'Q: Can I pay by PayNow?\nA: Yes, at the counter.',
          ocrConfidence: null,
        },
      ],
    });
    const txt = await parseFile(strToU8('﻿Delivery policy:  free above S$80\r\n'), 'txt', deps);
    expect(txt.ok && txt.pages[0]).toMatchObject({
      url: 'part/1',
      text: 'Delivery policy: free above S$80',
    });
    const long = await parseFile(strToU8(`${'Kaya toast — S$3.50\n'.repeat(4000)}`), 'txt', deps);
    expect(long.ok && long.pages.map((x) => x.url)).toEqual(['part/1', 'part/2']);
  });

  it('reads PPTX slides in number order, one page per slide', async () => {
    const slide = (t: string) =>
      strToU8(`<p:sld><p:cSld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:cSld></p:sld>`);
    const pptx = zipSync({
      'ppt/presentation.xml': strToU8('<p/>'),
      'ppt/slides/slide10.xml': slide('Promotion: Durian week — 20% off until 2026-11-30'),
      'ppt/slides/slide2.xml': slide('Refund policy: within 7 days with receipt'),
      'ppt/slides/slide1.xml': slide('Hi'),
      'ppt/notesSlides/notesSlide1.xml': slide('Speaker notes are not read'),
    });
    const out = await parseFile(pptx, 'pptx', fakeDeps().deps);
    if (!out.ok) throw new Error('not ok');
    expect(out.pages.map((x) => [x.url, x.status, x.text])).toEqual([
      ['slide/1', 'excluded', null],
      ['slide/2', 'included', 'Refund policy: within 7 days with receipt'],
      ['slide/3', 'included', 'Promotion: Durian week — 20% off until 2026-11-30'],
    ]);
  });

  it('OCRs an image as one page', async () => {
    const { deps, ocr } = fakeDeps();
    const out = await parseFile(strToU8(MENU), 'png', deps);
    expect(out).toEqual({
      ok: true,
      pages: [
        { url: 'image/1', status: 'included', reason: null, text: MENU, ocrConfidence: 0.82 },
      ],
    });
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
  });

  it('calls a DOCX that unzips past the cap, or without its document, unreadable', async () => {
    const bomb = zipOne('word/document.xml', new Uint8Array(MAX_UNZIPPED_BYTES + 1));
    expect(await parseFile(bomb, 'docx', fakeDeps().deps)).toEqual({
      ok: false,
      failure: 'unreadable',
    });
    const empty = zipSync({ 'word/other.xml': strToU8('<x/>') });
    expect(await parseFile(empty, 'docx', fakeDeps().deps)).toEqual({
      ok: false,
      failure: 'unreadable',
    });
  });
});

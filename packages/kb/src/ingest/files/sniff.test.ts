import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makePdf } from '../../../test/fixtures/pdf.js';
import { openPdf, pageText } from './pdf.js';
import { sniffType, zipEntries } from './sniff.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url)));
const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(64).fill(0x20)]);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/** Sets the encryption flag (bit 0) on every entry, as a password-protected ZIP has it. */
function encryptFlag(z: Uint8Array): Uint8Array {
  const b = z.slice();
  const v = new DataView(b.buffer);
  for (let i = 0; i + 4 <= b.length; i++) {
    const sig = v.getUint32(i, true);
    if (sig === 0x04034b50) b[i + 6]! |= 1;
    if (sig === 0x02014b50) b[i + 8]! |= 1;
  }
  return b;
}

describe('sniffType (KB-11; FEAT-015 §5.3, D5)', () => {
  it('reads the type from the bytes: PDF, PNG, JPEG, DOCX, PPTX, UTF-8 text', () => {
    expect(sniffType(makePdf([{ lines: ['x'] }]), 'menu.pdf')).toEqual({ ok: true, type: 'pdf' });
    expect(sniffType(PNG, 'a.png')).toEqual({ ok: true, type: 'png' });
    expect(sniffType(JPEG, 'a.jpeg')).toEqual({ ok: true, type: 'jpeg' });
    const docx = zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<w:document/>' });
    expect(sniffType(docx, 'faq.docx')).toEqual({ ok: true, type: 'docx' });
    const pptx = zip({ '[Content_Types].xml': '<x/>', 'ppt/presentation.xml': '<p/>' });
    expect(sniffType(pptx, 'promo.pptx')).toEqual({ ok: true, type: 'pptx' });
    expect(sniffType(strToU8('﻿Refund policy: 7 days\r\n'), 'policies.txt')).toEqual({
      ok: true,
      type: 'txt',
    });
    expect(sniffType(strToU8('退款政策：七天内'), 'notice.TXT')).toEqual({ ok: true, type: 'txt' });
  });

  it('lets the content win over the name: a PNG named .jpg or .pdf is an image', () => {
    expect(sniffType(PNG, 'photo.jpg')).toEqual({ ok: true, type: 'png' });
    expect(sniffType(PNG, 'menu.pdf')).toEqual({ ok: true, type: 'png' });
  });

  it.each([
    ['ELF', [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]],
    ['PE', [0x4d, 0x5a, 0x90, 0x00]],
    ['Mach-O', [0xcf, 0xfa, 0xed, 0xfe]],
    ['fat Mach-O', [0xca, 0xfe, 0xba, 0xbe]],
    ['script', [0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e]],
  ])('refuses a renamed %s executable, whatever its name', (_, sig) => {
    for (const name of ['menu.pdf', 'notes.txt', 'photo.png'])
      expect(sniffType(bytes(...sig), name)).toEqual({ ok: false, failure: 'unsupported_type' });
  });

  it('refuses an executable with a PDF header later in it', () => {
    const b = new Uint8Array([0x4d, 0x5a, ...strToU8('....%PDF-1.4')]);
    expect(sniffType(b, 'x.pdf')).toEqual({ ok: false, failure: 'unsupported_type' });
  });

  it('refuses ZIPs that are not Word or PowerPoint (XLSX is FEAT-016)', () => {
    const xlsx = zip({ '[Content_Types].xml': '<x/>', 'xl/workbook.xml': '<w/>' });
    expect(sniffType(xlsx, 'prices.xlsx')).toEqual({ ok: false, failure: 'unsupported_type' });
    expect(sniffType(zip({ 'a.jpg': 'x' }), 'photos.docx')).toEqual({
      ok: false,
      failure: 'unsupported_type',
    });
  });

  it('refuses a ZIP with an encrypted entry, and an OLE container named .docx or .pptx', () => {
    const docx = zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<w:document/>' });
    expect(zipEntries(encryptFlag(docx))?.encrypted).toBe(true);
    expect(sniffType(encryptFlag(docx), 'faq.docx')).toEqual({ ok: false, failure: 'encrypted' });
    expect(sniffType(OLE, 'faq.docx')).toEqual({ ok: false, failure: 'encrypted' });
    expect(sniffType(OLE, 'deck.PPTX')).toEqual({ ok: false, failure: 'encrypted' });
    // Legacy Office formats aren't in KB-02.
    expect(sniffType(OLE, 'old.doc')).toEqual({ ok: false, failure: 'unsupported_type' });
  });

  it('calls a broken ZIP unreadable', () => {
    const b = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(sniffType(b, 'faq.docx')).toEqual({ ok: false, failure: 'unreadable' });
  });

  it('refuses binary bytes named .txt, and text with any other name', () => {
    expect(sniffType(new Uint8Array([0x41, 0x00, 0x42]), 'notes.txt')).toEqual({
      ok: false,
      failure: 'unsupported_type',
    });
    expect(sniffType(new Uint8Array([0xc3, 0x28, 0x41]), 'notes.txt')).toEqual({
      ok: false,
      failure: 'unsupported_type',
    });
    expect(sniffType(strToU8('hello'), 'notes.md')).toEqual({
      ok: false,
      failure: 'unsupported_type',
    });
  });
});

describe('openPdf (FEAT-015 §5.3 step 5, D3)', () => {
  it('opens a plain PDF and reads its text layer with line breaks', async () => {
    const opened = await openPdf(
      makePdf([{ lines: ['Chocolate fudge cake (1 kg) — S$55.00', 'Q: Open on Sunday?'] }]),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.doc.numPages).toBe(1);
    const text = await pageText(opened.doc, 1);
    expect(text).toContain('Chocolate fudge cake (1 kg) — S$55.00\n');
    expect(text).toContain('Q: Open on Sunday?');
  });

  it('refuses a password-protected PDF and one that only restricts permissions', async () => {
    expect(await openPdf(fixture('protected.pdf'))).toEqual({ ok: false, failure: 'encrypted' });
    expect(await openPdf(fixture('restricted.pdf'))).toEqual({ ok: false, failure: 'encrypted' });
  });

  it('calls a damaged PDF unreadable', async () => {
    expect(await openPdf(strToU8('%PDF-1.4\nnot really a pdf'))).toEqual({
      ok: false,
      failure: 'unreadable',
    });
  });
});

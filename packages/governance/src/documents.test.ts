import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataFlowPdf, dpaPdf } from './documents.js';
import { SUB_PROCESSORS, TRANSFERS } from './registry.js';

/** The PDF's text, extracted with pdf.js, as one whitespace-normalised string. */
async function textOf(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: `${pathToFileURL(join(root, 'standard_fonts')).href}/`,
  });
  const doc = await task.promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const item of content.items) if ('str' in item) parts.push(item.str);
  }
  await task.destroy();
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** A registry value as words, since table cells wrap across lines. */
const words = (s: string) => s.replace(/\s+/g, ' ');

describe('data-intermediary PDFs (GOV-07)', () => {
  it('the data-flow PDF lists every sub-processor and destination, the same every time', async () => {
    const a = await dataFlowPdf();
    expect(Buffer.from(a.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(await dataFlowPdf()).equals(Buffer.from(a))).toBe(true);
    const text = await textOf(a);
    for (const s of SUB_PROCESSORS) expect(text).toContain(words(s.name));
    for (const t of TRANSFERS) expect(text).toContain(words(t.to));
    expect(text).toContain('No tenant data is stored at rest outside Singapore.');
  });

  it('the DPA PDF carries its version, the legal-review notice and the schedules', async () => {
    const a = await dpaPdf({ dpaVersion: '2026-10-20' });
    expect(Buffer.from(a.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(await dpaPdf({ dpaVersion: '2026-10-20' })).equals(Buffer.from(a))).toBe(
      true,
    );
    const text = await textOf(a);
    expect(text).toContain('Version 2026-10-20');
    expect(text).toContain('The full agreement text will be added after legal review.');
    for (const s of SUB_PROCESSORS) expect(text).toContain(words(s.name));
    for (const t of TRANSFERS) expect(text).toContain(words(t.to));
  });
});

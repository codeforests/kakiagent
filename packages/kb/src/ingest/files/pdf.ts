import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

let loaded: Promise<PdfJs> | null = null;
/** pdf.js's legacy build, the one meant for Node; loaded once, on the first PDF. */
const pdfjs = () => (loaded ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const assets = (() => {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  // CMaps decode Chinese text layers; the standard fonts silence pdf.js's font warnings.
  const url = (d: string) => `${pathToFileURL(join(root, d)).href}/`;
  return { cMapUrl: url('cmaps'), standardFontDataUrl: url('standard_fonts') };
})();

/** An `/Encrypt` entry in a trailer or cross-reference stream dictionary (never compressed). */
const ENCRYPT = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/;

export type PdfOpen =
  | { ok: true; doc: PdfDocument; close: () => Promise<void> }
  | { ok: false; failure: 'encrypted' | 'unreadable' };

/**
 * Opens a PDF with no password (FEAT-015 §5.3 step 5). Any encryption, including a PDF that
 * only restricts permissions, is refused (D3); so is one pdf.js can't read.
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfOpen> {
  if (ENCRYPT.test(Buffer.from(bytes).toString('latin1')))
    return { ok: false, failure: 'encrypted' };
  const { getDocument } = await pdfjs();
  try {
    const task = getDocument({
      // pdf.js takes ownership of the buffer it's given.
      data: bytes.slice(),
      ...assets,
      cMapPacked: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    return { ok: true, doc, close: () => task.destroy() };
  } catch (err) {
    return {
      ok: false,
      failure: (err as Error).name === 'PasswordException' ? 'encrypted' : 'unreadable',
    };
  }
}

/** A page's text layer, a line break wherever pdf.js marks the end of a line. */
export async function pageText(doc: PdfDocument, n: number): Promise<string> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
  page.cleanup();
  return text;
}

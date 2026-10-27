import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  DOCUMENTS_UPDATED_ON,
  NO_DATA_AT_REST_ABROAD,
  SUB_PROCESSORS,
  TRANSFERS,
} from './registry.js';

/**
 * The data-flow and DPA PDFs (GOV-07, GOV-11; FEAT-058 §5.1, D2), drawn with pdf-lib from the
 * registry, so they can't drift from the page. A4, the standard Helvetica fonts (the registry
 * is WinAnsi, unit-tested), and dates fixed to the registry date, so the same registry gives
 * byte-identical files.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const WIDTH = A4[0] - 2 * MARGIN;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** A top-to-bottom writer that starts a new page when the next block won't fit. */
class Writer {
  private page: PDFPage;
  private y = A4[1] - MARGIN;

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
  ) {
    this.page = doc.addPage(A4);
  }

  private room(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.doc.addPage(A4);
      this.y = A4[1] - MARGIN;
    }
  }

  text(text: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    for (const line of wrap(text, font, size, WIDTH)) {
      this.room(size * 1.4);
      this.y -= size * 1.4;
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font });
    }
    this.y -= opts.gap ?? 6;
  }

  /** A table as wrapped rows; `widths` are fractions of the text width. */
  table(headers: string[], widths: number[], rows: string[][]) {
    const size = 8;
    const leading = size * 1.35;
    const draw = (cells: string[], font: PDFFont) => {
      const wrapped = cells.map((c, i) => wrap(c, font, size, widths[i]! * WIDTH - 6));
      const height = Math.max(...wrapped.map((w) => w.length)) * leading + 4;
      this.room(height);
      let x = MARGIN;
      wrapped.forEach((lines, i) => {
        lines.forEach((line, n) =>
          this.page.drawText(line, { x, y: this.y - (n + 1) * leading, size, font }),
        );
        x += widths[i]! * WIDTH;
      });
      this.y -= height;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + 1 },
        end: { x: MARGIN + WIDTH, y: this.y + 1 },
        thickness: 0.3,
      });
    };
    draw(headers, this.fonts.bold);
    for (const row of rows) draw(row, this.fonts.regular);
    this.y -= 10;
  }
}

async function build(title: string, fill: (w: Writer) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const at = new Date(`${DOCUMENTS_UPDATED_ON}T00:00:00Z`);
  doc.setTitle(title);
  doc.setAuthor('KakiAgent');
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const w = new Writer(doc, fonts);
  w.text(title, { size: 18, bold: true, gap: 4 });
  w.text(`Updated ${DOCUMENTS_UPDATED_ON}`, { size: 9, gap: 14 });
  fill(w);
  return doc.save();
}

const subProcessorTable = (w: Writer) =>
  w.table(
    ['Sub-processor', 'Service', 'Purpose', 'Location', 'Data at rest'],
    [0.22, 0.16, 0.3, 0.22, 0.1],
    SUB_PROCESSORS.map((s) => [
      s.name,
      s.service,
      s.purpose,
      s.location,
      s.dataAtRest ? 'Yes' : 'No',
    ]),
  );

const transferTable = (w: Writer) =>
  w.table(
    ['Data', 'From', 'To', 'Purpose', 'Safeguard', 'Retention'],
    [0.18, 0.15, 0.17, 0.14, 0.24, 0.12],
    TRANSFERS.map((t) => [t.data, t.from, t.to, t.purpose, t.safeguard, t.retention]),
  );

export function dataFlowPdf(): Promise<Uint8Array> {
  return build('KakiAgent data flows', (w) => {
    w.text(
      "KakiAgent processes your visitors' data for you as a data intermediary. This document lists where that data goes.",
      { gap: 12 },
    );
    w.text('Cross-border transfers', { size: 13, bold: true });
    transferTable(w);
    w.text('Sub-processors', { size: 13, bold: true });
    subProcessorTable(w);
    w.text(NO_DATA_AT_REST_ABROAD, { bold: true });
  });
}

export function dpaPdf(input: { dpaVersion: string }): Promise<Uint8Array> {
  return build('KakiAgent Data Processing Agreement', (w) => {
    w.text(`Version ${input.dpaVersion}`, { bold: true });
    w.text('The full agreement text will be added after legal review.', { gap: 14 });
    w.text('Schedule 1: Sub-processors', { size: 13, bold: true });
    subProcessorTable(w);
    w.text('Schedule 2: Transfers and processing locations', { size: 13, bold: true });
    transferTable(w);
    w.text(NO_DATA_AT_REST_ABROAD, { gap: 14 });
    w.text('Schedule 3: Zero-retention terms', { size: 13, bold: true });
    for (const line of [
      'AI replies are generated through Amazon Bedrock with model invocation logging turned off and retention set to none.',
      'The model provider has no access to prompts or replies, and no tenant data is used to train models.',
      'The AWS Organizations AI services opt-out policy is enabled, so AWS AI services do not store content for service improvement.',
    ])
      w.text(`- ${line}`);
  });
}

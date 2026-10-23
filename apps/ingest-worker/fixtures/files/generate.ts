import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { chromium, type Page } from 'playwright-core';
import {
  CHINESE_NOTICE,
  FAQ_DOCX,
  MENU_PHOTO_LINES,
  POLICIES_TXT,
  PRICE_LIST_PAGES,
  PROMO_SLIDES,
  PROTECTED_PASSWORD,
  SCANNED_MENU_PAGES,
} from './content.js';
import { writeSheetFixtures } from './sheets.js';

/**
 * `pnpm --filter @kaki/ingest-worker fixtures:files`: regenerates the committed file
 * fixtures (FEAT-015 §5.9) with Chromium (PDFs, images), qpdf (the encrypted PDF) and
 * fflate (DOCX, PPTX). Needs `qpdf` on the PATH; CHROMIUM_EXECUTABLE_PATH can name a
 * Chromium. The EICAR file is never written (tests build it at run time).
 */
const DIR = fileURLToPath(new URL('.', import.meta.url));
const out = (name: string, bytes: Uint8Array | string) => {
  writeFileSync(join(DIR, name), bytes);
  console.warn(`wrote ${name}`);
};

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const doc = (body: string, style = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: 'DejaVu Sans', Arial, sans-serif; color: #000; background: #fff; }
    ${style}
  </style></head><body>${body}</body></html>`;

/** A white card of large black lines, as a phone photo or a scanner would see a menu. */
async function picture(page: Page, lines: string[], type: 'png' | 'jpeg', font = 'inherit') {
  await page.setViewportSize({ width: 1400, height: 120 + lines.length * 70 });
  await page.setContent(
    doc(
      lines.map((l) => `<p>${esc(l)}</p>`).join(''),
      `body { padding: 40px; font-size: 44px; font-family: ${font}; } p { margin: 0 0 22px; }`,
    ),
  );
  return page.screenshot({ type, fullPage: true, ...(type === 'jpeg' ? { quality: 90 } : {}) });
}

async function pdf(page: Page, pages: string[]) {
  await page.setContent(
    doc(
      pages.map((p) => `<section>${p}</section>`).join(''),
      'section { page-break-after: always; padding: 20px; font-size: 16px; } section:last-child { page-break-after: auto; } img { width: 100%; }',
    ),
  );
  return page.pdf({ format: 'A4', printBackground: true });
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function docx(): Uint8Array {
  const [title, ...rest] = FAQ_DOCX.paragraphs;
  const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const body = [
    // A title with a tab inside, and a line break after it (§5.4 w:tab, w:br).
    `<w:p><w:r><w:t>${esc(title!)}</w:t><w:tab/><w:t>2026</w:t><w:br/><w:t>Updated monthly</w:t></w:r></w:p>`,
    ...rest.map(para),
    `<w:tbl>${FAQ_DOCX.table.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`,
  ].join('');
  return zipSync({
    '[Content_Types].xml': strToU8(
      xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    ),
    '_rels/.rels': strToU8(
      xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    ),
    'word/document.xml': strToU8(xml(`<w:document ${W}><w:body>${body}</w:body></w:document>`)),
  });
}

function pptx(): Uint8Array {
  const slide = (lines: string[]) =>
    xml(
      `<p:sld ${A} ${P}><p:cSld><p:spTree><p:sp><p:txBody>${lines
        .map((l) => `<a:p><a:r><a:t>${esc(l)}</a:t></a:r></a:p>`)
        .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${PROMO_SLIDES.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
      ),
    ),
    'ppt/presentation.xml': strToU8(xml(`<p:presentation ${P}/>`)),
  };
  // Written out of order, so the parser's number order is what puts them right.
  [...PROMO_SLIDES.keys()].reverse().forEach((i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slide(PROMO_SLIDES[i]!));
    files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(slide(['Speaker notes, not read']));
  });
  return zipSync(files);
}

/**
 * The OLE compound file Office writes for a password-protected .docx (MS-OFFCRYPTO): a
 * header, one FAT sector, a directory and an `EncryptedPackage` stream.
 */
function oleDocx(): Uint8Array {
  const SECTOR = 512;
  const STREAM = 4096; // at the mini-stream cutoff, so it lives in regular sectors
  const buf = Buffer.alloc(SECTOR * (3 + STREAM / SECTOR));
  const END = 0xfffffffe;
  const FREE = 0xffffffff;
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(buf, 0);
  buf.writeUInt16LE(0x3e, 24); // minor version
  buf.writeUInt16LE(3, 26); // major version 3: 512-byte sectors
  buf.writeUInt16LE(0xfffe, 28); // byte order
  buf.writeUInt16LE(9, 30); // sector shift
  buf.writeUInt16LE(6, 32); // mini sector shift
  buf.writeUInt32LE(1, 44); // FAT sectors
  buf.writeUInt32LE(1, 48); // first directory sector
  buf.writeUInt32LE(4096, 56); // mini-stream cutoff
  buf.writeUInt32LE(END, 60); // no mini FAT
  buf.writeUInt32LE(END, 68); // no DIFAT sectors
  for (let i = 0; i < 109; i++) buf.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);
  const sector = (n: number) => SECTOR * (n + 1);
  const fat = sector(0);
  const dataSectors = STREAM / SECTOR;
  for (let i = 0; i < SECTOR / 4; i++) {
    let v = FREE;
    if (i === 0)
      v = 0xfffffffd; // the FAT itself
    else if (i === 1)
      v = END; // the directory
    else if (i >= 2 && i < 2 + dataSectors) v = i === 1 + dataSectors ? END : i + 1;
    buf.writeUInt32LE(v, fat + i * 4);
  }
  const entry = (
    n: number,
    name: string,
    type: number,
    child: number,
    start: number,
    size: number,
  ) => {
    const at = sector(1) + n * 128;
    if (name) {
      buf.write(name, at, 'utf16le');
      buf.writeUInt16LE((name.length + 1) * 2, at + 64);
    }
    buf.writeUInt8(type, at + 66);
    buf.writeUInt8(1, at + 67); // black
    buf.writeUInt32LE(FREE, at + 68);
    buf.writeUInt32LE(FREE, at + 72);
    buf.writeUInt32LE(child, at + 76);
    buf.writeUInt32LE(start, at + 116);
    buf.writeUInt32LE(size, at + 120);
  };
  entry(0, 'Root Entry', 5, 1, END, 0);
  entry(1, 'EncryptedPackage', 2, FREE, 2, STREAM);
  entry(2, '', 0, FREE, 0, 0);
  entry(3, '', 0, FREE, 0, 0);
  for (let i = 0; i < STREAM; i++) buf[sector(2) + i] = (i * 151 + 7) & 0xff;
  return buf;
}

/** An ELF header and some padding, named `.pdf` (the renamed-executable criterion). */
function elf(): Uint8Array {
  const buf = Buffer.alloc(256);
  Buffer.from('7f454c46020101', 'hex').copy(buf, 0);
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(0x3e, 18); // x86-64
  return buf;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
});
try {
  const page = await browser.newPage();
  const lines = (ls: string[]) => ls.map((l) => `<p>${esc(l)}</p>`).join('');

  const priceList = await pdf(page, PRICE_LIST_PAGES.map(lines));
  out('price-list.pdf', priceList);

  const scans = [];
  for (const p of SCANNED_MENU_PAGES) scans.push(await picture(page, p, 'png'));
  out(
    'scanned-menu.pdf',
    await pdf(
      page,
      scans.map((png) => `<img alt="" src="data:image/png;base64,${png.toString('base64')}">`),
    ),
  );

  out('menu-photo.png', await picture(page, MENU_PHOTO_LINES, 'png'));
  out('menu-photo.jpg', await picture(page, MENU_PHOTO_LINES, 'jpeg'));
  out(
    'chinese-notice.png',
    await picture(page, [CHINESE_NOTICE], 'png', "'WenQuanYi Zen Hei', 'Noto Sans CJK SC'"),
  );
  out('blank.png', await picture(page, [], 'png'));

  const tmp = mkdtempSync(join(tmpdir(), 'kaki-fixtures-'));
  try {
    const plain = join(tmp, 'plain.pdf');
    writeFileSync(plain, priceList);
    execFileSync('qpdf', [
      '--encrypt',
      PROTECTED_PASSWORD,
      `${PROTECTED_PASSWORD}-owner`,
      '256',
      '--',
      plain,
      join(DIR, 'protected.pdf'),
    ]);
    console.warn('wrote protected.pdf');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}

out('faq.docx', docx());
out('promo.pptx', pptx());
out('policies.txt', POLICIES_TXT);
out('protected.docx', oleDocx());
out('program.pdf', elf());
writeSheetFixtures();

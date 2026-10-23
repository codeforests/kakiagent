/**
 * A minimal PDF writer for tests (FEAT-015): each page is either lines of Helvetica text
 * (a text layer) or a JPEG drawn full-page (a scan, with no text layer).
 */
export type TestPage = { lines: string[] } | { jpeg: Uint8Array; width: number; height: number };

export function makePdf(pages: TestPage[]): Uint8Array {
  const objects: (string | Uint8Array)[][] = [];
  const add = (...parts: (string | Uint8Array)[]) => {
    objects.push(parts);
    return objects.length;
  };
  const catalog = add(); // filled below
  const pagesObj = add();
  const font = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const kids: number[] = [];
  for (const page of pages) {
    let content: string;
    let resources: string;
    if ('lines' in page) {
      const esc = (t: string) =>
        t
          .replace(/[\\()]/g, (c) => `\\${c}`)
          .replace(/—/g, '\\227')
          .replace(/–/g, '\\226');
      content = `BT /F1 12 Tf 14 TL 50 780 Td ${page.lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
    } else {
      const img = add(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
        page.jpeg,
        '\nendstream',
      );
      content = `q 595 0 0 842 0 0 cm /Im1 Do Q`;
      resources = `<< /XObject << /Im1 ${img} 0 R >> >>`;
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Contents ${stream} 0 R /Resources ${resources} >>`,
      ),
    );
  }
  objects[catalog - 1] = [`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`];
  objects[pagesObj - 1] = [
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((parts, i) => {
    offsets.push(offset);
    const buf = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      ...parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(buf);
    offset += buf.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
  ].join('');
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

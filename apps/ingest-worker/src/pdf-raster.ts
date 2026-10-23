import { OcrUnavailableError, type PdfRasterizer } from '@kaki/kb';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.js';

/**
 * `pdftoppm` (poppler) renders one page at 200 dpi for OCR (FEAT-015 §5.4), in a temp
 * directory of its own that is removed whatever happens. A failure is transient, like OCR.
 */
export function pdftoppmRasterizer(cfg: { path: string; timeoutMs?: number }): PdfRasterizer {
  return {
    async render(pdf, page) {
      const dir = await mkdtemp(join(tmpdir(), 'kaki-raster-'));
      try {
        const input = join(dir, 'in.pdf');
        await writeFile(input, pdf);
        const n = String(page);
        await run(
          cfg.path,
          ['-f', n, '-l', n, '-r', '200', '-png', '-singlefile', input, join(dir, 'page')],
          { timeoutMs: cfg.timeoutMs ?? 60_000 },
        );
        return new Uint8Array(await readFile(join(dir, 'page.png')));
      } catch (err) {
        throw new OcrUnavailableError('pdftoppm failed', { cause: err });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

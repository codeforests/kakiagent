import { describe, expect, it } from 'vitest';
import { DOCUMENTS_UPDATED_ON, SINGAPORE, SUB_PROCESSORS, TRANSFERS } from './registry.js';

/** Characters the PDFs' standard fonts can draw (WinAnsi, printable). */
const WIN_ANSI = /^[\x20-\x7e -ÿ–—‘’“”•…]*$/;

describe('data-intermediary registry (GOV-07, GOV-11)', () => {
  it('has a date and no empty fields', () => {
    expect(DOCUMENTS_UPDATED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const row of [...SUB_PROCESSORS, ...TRANSFERS])
      for (const v of Object.values(row)) if (typeof v === 'string') expect(v.trim()).not.toBe('');
  });

  it('lists a transfer for every location outside Singapore (D5)', () => {
    const abroad = SUB_PROCESSORS.filter((s) => s.location !== SINGAPORE);
    expect(abroad.length).toBeGreaterThan(0);
    for (const s of abroad) expect(TRANSFERS.map((t) => t.to)).toContain(s.location);
    expect(SUB_PROCESSORS.filter((s) => s.dataAtRest).every((s) => s.location === SINGAPORE)).toBe(
      true,
    );
  });

  it('keeps all text WinAnsi-encodable for the PDFs', () => {
    for (const row of [...SUB_PROCESSORS, ...TRANSFERS])
      for (const v of Object.values(row)) if (typeof v === 'string') expect(v).toMatch(WIN_ANSI);
  });
});

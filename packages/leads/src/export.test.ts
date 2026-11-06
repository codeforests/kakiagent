import { describe, expect, it } from 'vitest';
import {
  csvCell,
  CSV_HEADER,
  CSV_REMINDER,
  exportFileName,
  leadsCsv,
  sgtDateTime,
} from './export.js';
import type { LeadDbRow } from './list.js';

const row = (over: Partial<LeadDbRow> = {}): LeadDbRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  version: 1,
  status: 'new',
  name: 'Tan, "Mei"',
  email: 'mei@example.com',
  phone: '+6591234567',
  need: '婚礼蛋糕\nthree tiers',
  budget: '=SUM(1)',
  preferred_time: '@noon',
  captures: 1,
  contact_id: '00000000-0000-4000-8000-000000000002',
  conversation_id: null,
  score: 'hot',
  score_points: 5,
  score_reasons: [
    { code: 'keyword', points: 2, detail: 'wedding' },
    { code: 'budget_met', points: 2, detail: '300' },
    { code: 'need_given', points: 1, detail: null },
  ],
  scored_at: '2026-11-18T06:05:00Z',
  created_at: '2026-11-18T06:05:00Z',
  updated_at: '2026-11-18T06:05:00Z',
  updated_key: '2026-11-18 06:05:00+00',
  enquiry_at: '2026-11-18T06:04:00Z',
  marketing_agreed: true,
  marketing_at: '2026-11-18T06:04:30Z',
  ...over,
});

/** A minimal RFC 4180 reader, to prove the output round-trips. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      cells.push(cell);
      out.push(cells);
      cells = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return out;
}

describe('leadsCsv (FEAT-050 §5.4; AC-6, AC-7)', () => {
  it('BOM, reminder line, header, then rows that round-trip', () => {
    const csv = leadsCsv([
      row(),
      row({
        status: 'won',
        score: null,
        score_points: null,
        score_reasons: null,
        scored_at: null,
        marketing_at: null,
        marketing_agreed: null,
        conversation_id: '00000000-0000-4000-8000-000000000003',
      }),
      row({ marketing_agreed: false }),
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = parseCsv(csv.slice(1));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual([CSV_REMINDER]);
    expect(lines[1]).toEqual([...CSV_HEADER]);
    expect(lines[2]).toEqual([
      '18 Nov 2026 14:05',
      '18 Nov 2026 14:05',
      'New',
      'Hot',
      'Mentions "wedding"; Budget meets your S$300 minimum; Said what they need',
      'Tan, "Mei"',
      'mei@example.com',
      "'+6591234567",
      '婚礼蛋糕\nthree tiers',
      "'=SUM(1)",
      "'@noon",
      '18 Nov 2026 14:04',
      'Yes',
      '18 Nov 2026 14:04',
      'Contact form',
    ]);
    const b = lines[3]!;
    expect([b[2], b[3], b[4], b[12], b[13], b[14]]).toEqual([
      'Won',
      'Not scored',
      '',
      'Not asked',
      '',
      'Chat',
    ]);
    expect(lines[4]![12]).toBe('No');
  });

  it('prefixes every formula-like start', () => {
    for (const s of ['=1', '+1', '-1', '@x', '\tx', '\rx'])
      expect(csvCell(s).replace(/^"/, '')).toMatch(/^'/);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });

  it('dates and the file name are in Singapore time', () => {
    expect(sgtDateTime('2026-11-18T16:30:00Z')).toBe('19 Nov 2026 00:30');
    expect(exportFileName(new Date('2026-11-18T16:30:00Z'))).toBe('leads-2026-11-19.csv');
  });
});

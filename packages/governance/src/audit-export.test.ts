import { describe, expect, it } from 'vitest';
import type { AuditRecord } from './audit-read.js';
import { auditCsv, auditExportFileName, auditJson, csvCell, sgtTimestamp } from './audit-export.js';
import { entryHash } from './chain.js';

const T = '00000000-0000-4000-8000-00000000000a';
const U = '00000000-0000-4000-8000-0000000000a1';

/** Two linked entries with real hashes. */
function chain(): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prevHash = '0'.repeat(64);
  const specs = [
    { eventType: 'fact.updated', payload: { formula: '=SUM(1)', note: 'a,b "c"\nd 中文' } },
    { eventType: 'audit.verified', payload: { ok: true, head_seq: 1 } },
  ];
  specs.forEach((s, i) => {
    const fields = {
      tenantId: T,
      seq: i + 1,
      ts: `2026-11-14T0${i}:30:00.000Z`,
      actorType: 'user' as const,
      actorRef: U,
      eventType: s.eventType,
      subjectRefs: ['fact:f1', 'conversation:c1'],
      payload: s.payload,
      piiRef: null,
      piiCommitment: null,
      prevHash,
    };
    const hash = entryHash(fields);
    out.push({ ...fields, hash, pii: 'none' });
    prevHash = hash;
  });
  return out;
}

/** Splits RFC 4180 CSV text into rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

describe('auditCsv (FEAT-060 §5.3, AC-4)', () => {
  it('has a BOM, the header, CRLF rows, and round-trips commas, quotes, newlines and Chinese', () => {
    const csv = auditCsv(chain(), new Map([[U, 'Mei']]));
    expect(csv.startsWith('\uFEFFseq,time_sgt,time_utc,actor_type,')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = parseCsv(csv.slice(1));
    expect(rows).toHaveLength(3);
    const [, first] = rows;
    expect(first!.slice(0, 8)).toEqual([
      '1',
      '2026-11-14 08:30:00',
      '2026-11-14T00:30:00.000Z',
      'user',
      U,
      'Mei',
      'fact.updated',
      'fact:f1 conversation:c1',
    ]);
    expect(JSON.parse(first![8]!)).toEqual({ formula: '=SUM(1)', note: 'a,b "c"\nd 中文' });
    expect(first![9]).toBe('none');
  });

  it('prefixes cells a spreadsheet would read as a formula', () => {
    expect(csvCell('=SUM(1)')).toBe("'=SUM(1)");
    for (const s of ['+1', '-1', '@x', '\tx']) expect(csvCell(s).includes(`'${s[0]}`)).toBe(true);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });
});

describe('auditJson (FEAT-060 §5.3, AC-4)', () => {
  it('keeps every hashed field so each entry recomputes to its hash', () => {
    const json = JSON.parse(
      auditJson(chain(), { tenantId: T, exportedAt: '2026-11-14T02:00:00.000Z', filters: {} }),
    );
    expect(json.count).toBe(2);
    for (const e of json.entries) {
      const recomputed = entryHash({
        tenantId: e.tenant_id,
        seq: e.seq,
        ts: e.ts,
        actorType: e.actor_type,
        actorRef: e.actor_ref,
        eventType: e.event_type,
        subjectRefs: e.subject_refs,
        payload: e.payload,
        piiRef: e.pii_ref,
        piiCommitment: e.pii_commitment,
        prevHash: e.prev_hash,
      });
      expect(recomputed).toBe(e.hash);
    }
    expect(json.entries[1].prev_hash).toBe(json.entries[0].hash);
  });
});

describe('names and dates', () => {
  it('formats SGT and names the file by the SGT day', () => {
    expect(sgtTimestamp('2026-11-14T16:30:00.000Z')).toBe('2026-11-15 00:30:00');
    expect(auditExportFileName(new Date('2026-11-14T16:30:00Z'), 'json')).toBe(
      'audit-log-2026-11-15.json',
    );
  });
});

import { TENANT_SCOPED_TABLES } from '@kaki/db';
import { DSR_COUNT_STORES } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { DSR_STORES, storesWith } from './stores.js';

describe('DSR_STORES (FEAT-061 §5.2, AC-10)', () => {
  it('classifies every tenant-scoped table', () => {
    const missing = TENANT_SCOPED_TABLES.filter((t) => !(t in DSR_STORES));
    expect(missing).toEqual([]);
  });
  it('names no table that does not exist', () => {
    const tables = new Set<string>(TENANT_SCOPED_TABLES);
    expect(Object.keys(DSR_STORES).filter((t) => !tables.has(t))).toEqual([]);
  });
  it('every store a deletion removes reports a count', () => {
    const counted = new Set<string>(DSR_COUNT_STORES);
    const removed = [...storesWith('find+erase'), ...storesWith('erase')].filter(
      (t) => t !== 'coaching_messages',
    );
    expect(removed.filter((t) => !counted.has(t))).toEqual([]);
  });
});

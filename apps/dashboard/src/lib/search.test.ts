import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorLabel,
  canSearch,
  commitSearch,
  highlightParts,
  matchLabel,
  normaliseQuery,
  resetInboxSearch,
  resultsStatus,
  SEARCH_DEBOUNCE_MS,
  setSearchText,
  searchState,
} from './search.ts';

const read = () => searchState();

describe('inbox search helpers (FEAT-046)', () => {
  afterEach(() => {
    resetInboxSearch();
    vi.useRealTimers();
  });

  it('collapses whitespace as the server does', () => {
    expect(normaliseQuery('  jane \n  tan\t ')).toBe('jane tan');
  });

  it('needs 2 to 100 code points', () => {
    expect(canSearch('j')).toBe(false);
    expect(canSearch(' j  ')).toBe(false);
    expect(canSearch('ja')).toBe(true);
    expect(canSearch('美玲')).toBe(true);
    expect(canSearch('😀')).toBe(false);
    expect(canSearch('😀😀')).toBe(true);
    expect(canSearch('a'.repeat(100))).toBe(true);
    expect(canSearch('a'.repeat(101))).toBe(false);
  });

  it('marks the hits', () => {
    expect(
      highlightParts('Hi jane, Jane here', [
        { start: 3, end: 7 },
        { start: 9, end: 13 },
      ]),
    ).toEqual([
      { text: 'Hi ', hit: false },
      { text: 'jane', hit: true },
      { text: ', ', hit: false },
      { text: 'Jane', hit: true },
      { text: ' here', hit: false },
    ]);
    expect(highlightParts('jane', [{ start: 0, end: 4 }])).toEqual([{ text: 'jane', hit: true }]);
    expect(highlightParts('no hit', [])).toEqual([{ text: 'no hit', hit: false }]);
    expect(highlightParts('', [])).toEqual([{ text: '', hit: false }]);
  });

  it('drops ranges out of order or bounds', () => {
    expect(
      highlightParts('abcdef', [
        { start: 2, end: 4 },
        { start: 1, end: 3 },
        { start: 5, end: 9 },
      ]),
    ).toEqual([
      { text: 'ab', hit: false },
      { text: 'cd', hit: true },
      { text: 'ef', hit: false },
    ]);
  });

  it('labels the author and the outcome', () => {
    expect(['visitor', 'agent', 'staff', 'system'].map((a) => authorLabel(a as never))).toEqual([
      'Visitor',
      'Assistant',
      'Team',
      'Update',
    ]);
    expect(resultsStatus(1, false)).toBe('1 conversation matches');
    expect(resultsStatus(3, false)).toBe('3 conversations match');
    expect(resultsStatus(25, true)).toBe('Showing 25 conversations');
  });

  it('commits after the pause, or at once on Enter', () => {
    vi.useFakeTimers();
    setSearchText('ja');
    setSearchText('jan');
    expect(read()).toMatchObject({ text: 'jan', query: '', active: true });
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(read().query).toBe('jan');
    setSearchText('  jane  doe ');
    commitSearch();
    expect(read().query).toBe('jane doe');
  });

  it('ends the search under 2 characters and on reset', () => {
    vi.useFakeTimers();
    setSearchText('jane');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    setSearchText('j');
    expect(read()).toMatchObject({ text: 'j', query: '', active: false });
    setSearchText('jane');
    resetInboxSearch();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(read()).toMatchObject({ text: '', query: '', opened: null, active: false });
  });
});

describe('contact matches (FEAT-049 AC-10)', () => {
  it('labels a contact hit by the field that matched, a message hit by its author', () => {
    expect(matchLabel({ source: 'contact', field: 'email', author: null })).toBe('Email matches ·');
    expect(matchLabel({ source: 'contact', field: 'phone', author: null })).toBe('Phone matches ·');
    expect(matchLabel({ source: 'message', field: null, author: 'visitor' })).toBe(
      `${authorLabel('visitor')}:`,
    );
  });
});

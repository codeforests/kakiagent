import type { SearchMatch } from '@kaki/contracts';
import { useSyncExternalStore } from 'react';

/**
 * Inbox search (FEAT-046, SCR-APP-014). The text lives only in this module's memory, so it
 * survives opening a result and coming back, and never reaches a URL or browser storage
 * (technical-design AC-5).
 */

/** The same collapsing the server's `ConversationSearchRequest` applies. */
export const normaliseQuery = (s: string) => s.replace(/\s+/gu, ' ').trim();

const codePoints = (s: string) => [...s].length;

/** 2–100 characters (code points) after collapsing, as the server counts them. */
export function canSearch(s: string): boolean {
  const n = codePoints(normaliseQuery(s));
  return n >= 2 && n <= 100;
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** Splits an excerpt into plain and marked parts; ranges out of order or bounds are dropped. */
export function highlightParts(excerpt: string, ranges: SearchMatch['ranges']): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let at = 0;
  for (const { start, end } of ranges) {
    if (start < at || end <= start || end > excerpt.length) continue;
    if (start > at) parts.push({ text: excerpt.slice(at, start), hit: false });
    parts.push({ text: excerpt.slice(start, end), hit: true });
    at = end;
  }
  if (at < excerpt.length || parts.length === 0)
    parts.push({ text: excerpt.slice(at), hit: false });
  return parts;
}

const AUTHOR_LABEL: Record<NonNullable<SearchMatch['author']>, string> = {
  visitor: 'Visitor',
  agent: 'Assistant',
  staff: 'Team',
  system: 'Update',
};
export const authorLabel = (a: SearchMatch['author']) => (a ? AUTHOR_LABEL[a] : 'Contact');

const FIELD_LABEL = { name: 'Name', email: 'Email', phone: 'Phone' } as const;

/**
 * The label before a result's excerpt: the message's author ("Visitor:"), or for a contact
 * hit the field that matched ("Email matches ·", FEAT-049 ui-design SCR-APP-014).
 */
export function matchLabel(m: Pick<SearchMatch, 'source' | 'field' | 'author'>): string {
  if (m.source === 'contact') return `${m.field ? FIELD_LABEL[m.field] : 'Contact'} matches ·`;
  return `${authorLabel(m.author)}:`;
}

/** The results region's status line once a search completes. */
export function resultsStatus(n: number, more: boolean): string {
  if (more) return `Showing ${n} conversation${n === 1 ? '' : 's'}`;
  return n === 1 ? '1 conversation matches' : `${n} conversations match`;
}

export const searchKey = (q: string) => ['conversation-search', q] as const;
export const SEARCH_DEBOUNCE_MS = 300;

// ---- The in-memory store -------------------------------------------------------------

interface SearchState {
  /** What is in the field. */
  text: string;
  /** The normalised query last committed (after the pause or Enter); '' when none. */
  query: string;
  /** The result opened last, scrolled into view when the results come back. */
  opened: string | null;
}

const EMPTY: SearchState = { text: '', query: '', opened: null };
let state = EMPTY;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const focusListeners = new Set<() => void>();

function set(next: Partial<SearchState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function commit() {
  clearTimeout(timer);
  const q = normaliseQuery(state.text);
  set({ query: canSearch(q) ? q : '' });
}

/** Typing: commits the query after the pause (2+ characters); under 2 ends the search. */
export function setSearchText(text: string) {
  clearTimeout(timer);
  set({ text });
  if (!canSearch(text)) {
    if (state.query) set({ query: '' });
    return;
  }
  timer = setTimeout(commit, SEARCH_DEBOUNCE_MS);
}

/** Enter: searches at once. */
export const commitSearch = commit;

export const markOpened = (id: string) => set({ opened: id });

/** Escape, Clear and the workspace switch: back to the inbox as it was. */
export function resetInboxSearch() {
  clearTimeout(timer);
  set(EMPTY);
}

/** The top bar's search button, when the field is already on screen. */
export function focusInboxSearch() {
  for (const l of focusListeners) l();
}
export function onFocusInboxSearch(l: () => void) {
  focusListeners.add(l);
  return () => void focusListeners.delete(l);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => state;

/** The store's state; `active` once the text is searchable (the tabs and list give way). */
export const searchState = (s = state) => ({ ...s, active: canSearch(s.text) });

export function useInboxSearch() {
  return searchState(useSyncExternalStore(subscribe, snapshot, snapshot));
}

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * An element's width in CSS px, kept in sync by a ResizeObserver. Attach the returned callback
 * as the element's `ref` (works for elements that mount later, e.g. after loading). It measures
 * as the element attaches, during commit and before paint, so the first frame already has the
 * right layout. 0 until it's mounted.
 */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: T | null) => {
    setEl(node);
    if (node) setWidth(node.getBoundingClientRect().width);
  }, []);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [ref, width];
}

/** Whether a media query matches, kept in sync (the inbox's pane layout by width). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

import type { ReactNode } from 'react';

export interface MetaGridItem {
  label: string;
  value: ReactNode;
  testId?: string;
}

/** `meta-grid` (design.md §4.4): label/value pairs under a detail page's title. */
export function MetaGrid({ items, className }: { items: MetaGridItem[]; className?: string }) {
  return (
    <dl className={className ? `kaki-meta-grid ${className}` : 'kaki-meta-grid'}>
      {items.map((item) => (
        <div key={item.label} className="kaki-meta-grid__item" data-testid={item.testId}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

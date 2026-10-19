import type { ReactNode } from 'react';

export interface StateProps {
  title: string;
  children?: ReactNode;
  /** The one next action (design.md §4.8, NFR-19). */
  action?: ReactNode;
}

/** `empty-state`: one heading, one sentence, one next action. */
export function EmptyState({ title, children, action }: StateProps) {
  return (
    <div className="kaki-state">
      <h2 className="kaki-state__title">{title}</h2>
      {children && <p className="kaki-state__body">{children}</p>}
      {action}
    </div>
  );
}

/** `error-state`: blocking errors use role="alert" (design.md §5 rule 7). */
export function ErrorState({ title, children, action }: StateProps) {
  return (
    <div className="kaki-state kaki-state--error" role="alert">
      <h2 className="kaki-state__title">{title}</h2>
      {children && <p className="kaki-state__body">{children}</p>}
      {action}
    </div>
  );
}

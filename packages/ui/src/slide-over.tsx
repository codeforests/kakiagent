import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

export interface SlideOverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Links or buttons beside the title, before the close button. */
  actions?: ReactNode;
  /** The close button's accessible name. */
  closeLabel?: string;
  children: ReactNode;
  /** Extra class on the panel, e.g. a bottom-sheet variant on phones. */
  className?: string;
  /**
   * Where focus goes on close. Radix returns it to a `Dialog.Trigger`, and this panel has
   * none, so a caller opened from a row passes this (`preventDefault()`, then focus it).
   */
  onCloseAutoFocus?: (e: Event) => void;
}

/**
 * The right slide-over that frames design.md §4.6 `quick-coach-panel` (FEAT-027): 400 px,
 * shadow-lg, full height. Radix traps focus, closes on Esc and returns focus to the
 * trigger.
 */
export function SlideOver({
  open,
  onOpenChange,
  title,
  actions,
  closeLabel = 'Close',
  children,
  className,
  onCloseAutoFocus,
}: SlideOverProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="kaki-dialog__scrim" />
        <Dialog.Content
          className={className ? `kaki-slide-over ${className}` : 'kaki-slide-over'}
          aria-describedby={undefined}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        >
          <div className="kaki-slide-over__head">
            <Dialog.Title className="kaki-dialog__title">{title}</Dialog.Title>
            {actions}
            <Dialog.Close className="kaki-slide-over__close" aria-label={closeLabel}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="kaki-slide-over__body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The form, with its own actions (design.md §4.2 action bar). */
  children: ReactNode;
  /** While saving: Esc and the scrim don't close it. */
  busy?: boolean;
  className?: string;
}

/**
 * design.md §4.3 dialog holding a form (Review's "Edit and approve", FEAT-013): the same
 * frame as `ConfirmDialog`, wider, scrolling inside when the form is taller than the
 * viewport, a bottom sheet below 640 px. Radix traps focus and returns it on close.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  children,
  busy = false,
  className,
}: FormDialogProps) {
  const block = (e: Event) => {
    if (busy) e.preventDefault();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <Dialog.Portal>
        <Dialog.Overlay className="kaki-dialog__scrim" />
        <Dialog.Content
          className={`kaki-dialog kaki-dialog--form${className ? ` ${className}` : ''}`}
          aria-describedby={undefined}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
        >
          <Dialog.Title className="kaki-dialog__title">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import * as Dialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import { Button } from './button.js';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action as a question: "Delete this fact?" */
  title: string;
  /** The consequence, in plain words. */
  children: ReactNode;
  /** Repeats the verb: "Delete fact". */
  confirmLabel: string;
  confirmVariant?: 'primary' | 'danger';
  onConfirm: () => void;
  /** While the action runs: the confirm button shows it, and the dialog can't be closed. */
  busy?: boolean;
  /** The confirm button's text while busy: "Going live…". */
  busyLabel?: string;
  /** The confirm button alone is unavailable (e.g. while its counts load); Cancel still works. */
  confirmDisabled?: boolean;
  /** An inline alert shown above the buttons (a failed attempt). */
  alert?: ReactNode;
  cancelLabel?: string;
  /** Where focus goes on close; `preventDefault()` keeps Radix from returning it to the trigger. */
  onCloseAutoFocus?: (e: Event) => void;
}

/**
 * design.md §4.3 `confirm-dialog` on Radix Dialog: cancel (`secondary`, left) gets the
 * first focus as the least destructive action, confirm on the right, a bottom sheet
 * below 640 px, and no closing by Esc or the scrim while the action is in progress.
 * Radix traps focus and returns it to the trigger on close.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  confirmVariant = 'primary',
  onConfirm,
  busy = false,
  busyLabel = 'Working…',
  confirmDisabled = false,
  alert,
  cancelLabel = 'Cancel',
  onCloseAutoFocus,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const block = (e: Event) => {
    if (busy) e.preventDefault();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <Dialog.Portal>
        <Dialog.Overlay className="kaki-dialog__scrim" />
        <Dialog.Content
          className="kaki-dialog"
          role="alertdialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
        >
          <Dialog.Title className="kaki-dialog__title">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="kaki-dialog__body">{children}</div>
          </Dialog.Description>
          {alert}
          <div className="kaki-dialog__actions">
            <Dialog.Close asChild>
              <Button ref={cancelRef} variant="secondary" disabled={busy}>
                {cancelLabel}
              </Button>
            </Dialog.Close>
            <Button
              variant={confirmVariant}
              onClick={onConfirm}
              disabled={busy || confirmDisabled}
              aria-busy={busy || undefined}
            >
              {busy ? busyLabel : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import type { Fact } from '@kaki/contracts';
import { ConfirmDialog } from '@kaki/ui';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../lib/api.ts';
import { api } from '../lib/api.ts';
import { factTitle } from '../lib/facts.ts';

export type DeleteOutcome = 'deleted' | 'already-deleted';

/**
 * The delete-confirm dialog of SCR-APP-027 and SCR-APP-028 (FEAT-011 ui-design): a
 * `confirm-dialog` that sends `DELETE …?version=` with the version the owner saw.
 * 404 counts as done ("already deleted"); 409 keeps the dialog open with a warning.
 */
export function DeleteFactDialog({
  fact,
  onClose,
  onDone,
  onConflict,
  conflictAction,
}: {
  fact: Fact | null;
  onClose: () => void;
  onDone: (outcome: DeleteOutcome) => void;
  /** Called on a 409, so the caller can refresh what it shows. */
  onConflict?: () => void;
  conflictAction?: React.ReactNode;
}) {
  const remove = useMutation({
    mutationFn: (f: Fact) => api.deleteFact(f.id, f.version),
    onSuccess: () => onDone('deleted'),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) onDone('already-deleted');
      if (err instanceof ApiError && err.status === 409) onConflict?.();
    },
  });
  const status = remove.error instanceof ApiError ? remove.error.status : remove.error ? 0 : null;
  const alert =
    status === 409 ? (
      <div className="alert alert--warning" role="alert">
        <p>This fact changed since you opened it. Close this and try again.</p>
        {conflictAction}
      </div>
    ) : status !== null && status !== 404 ? (
      <div className="alert alert--danger" role="alert">
        <p>We couldn't delete the fact just now. Nothing was changed.</p>
      </div>
    ) : null;
  return (
    <ConfirmDialog
      open={fact !== null}
      onOpenChange={(open) => {
        if (open) return;
        remove.reset();
        onClose();
      }}
      title="Delete this fact?"
      confirmLabel="Delete fact"
      confirmVariant="danger"
      busy={remove.isPending}
      onConfirm={() => fact && remove.mutate(fact)}
      alert={alert}
    >
      <p>
        <strong>{fact ? factTitle(fact) : ''}</strong> will be removed and your assistant stops
        using it straight away. This can't be undone.
      </p>
    </ConfirmDialog>
  );
}

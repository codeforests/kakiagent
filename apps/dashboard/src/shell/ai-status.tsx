import type { Role } from '@kaki/contracts';
import { ConfirmDialog } from '@kaki/ui';
import { forwardRef, useId } from 'react';
import { Link } from 'react-router';
import {
  canToggle,
  PILL_TEXT,
  pausedSince,
  pillState,
  useAiStatus,
  type useSetAiPaused,
} from '../lib/ai-status.ts';
import { ApiError } from '../lib/api.ts';

/** The top-bar AI status pill and SCR-APP-058, the kill-switch dialog (FEAT-057 ui-design). */

export type KillSwitchMode = 'pause' | 'resume';

// Lucide `circle-pause` and `circle-help` (design.md §2.4). Decorative: text carries the meaning.
export function PauseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="ai-icon--paused"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M10 15V9M14 15V9" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  );
}

/**
 * Live, Paused or Not live from `GET /api/v1/ai/status` (D8). A button that opens the
 * dialog for Owners and Admins; a status with a tooltip for Agents. While a pause or
 * resume is in flight it keeps its state and shows a spinner in place of the dot.
 */
export const AiStatusPill = forwardRef<
  HTMLButtonElement,
  { role: Role | null | undefined; acting: boolean; onOpen: (mode: KillSwitchMode) => void }
>(function AiStatusPill({ role, acting, onOpen }, ref) {
  const status = useAiStatus({ enabled: role !== undefined });
  const tipId = useId();
  const manager = canToggle(role);

  let className = 'status-pill status-pill--off';
  let marker = <span className="status-pill__dot" aria-hidden="true" />;
  let text = { long: 'AI status', short: 'AI status' };
  if (status.data) {
    const state = pillState(status.data.status);
    text = PILL_TEXT[state];
    if (state === 'live') className = 'status-pill status-pill--live';
    if (state === 'paused') {
      className = 'status-pill status-pill--paused';
      marker = <PauseIcon />;
    }
  } else if (status.isError) {
    marker = <HelpIcon />;
  }
  if (acting) marker = <span className="spinner status-pill__spinner" aria-hidden="true" />;

  const label = (
    <>
      {status.isPending ? <span className="status-pill__skeleton" aria-hidden="true" /> : marker}
      <span className="status-pill__long">{text.long}</span>
      <span className="status-pill__short" aria-hidden="true">
        {text.short}
      </span>
    </>
  );

  if (role === undefined)
    return (
      <span className="status-pill status-pill--off" aria-busy="true" data-testid="ai-status-pill">
        {label}
      </span>
    );
  if (manager) {
    const paused = status.data?.status.paused ?? false;
    return (
      <button
        ref={ref}
        type="button"
        className={`${className} status-pill--button`}
        aria-haspopup="dialog"
        aria-busy={status.isPending || acting || undefined}
        aria-label={`${text.long}. Pause or resume the AI`}
        data-testid="ai-status-pill"
        onClick={() => onOpen(paused ? 'resume' : 'pause')}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="tooltip-anchor">
      <span
        className={className}
        role="status"
        tabIndex={0}
        aria-busy={status.isPending || undefined}
        aria-describedby={tipId}
        data-testid="ai-status-pill"
      >
        {label}
      </span>
      <span className="tooltip" role="tooltip" id={tipId}>
        Only the Owner or an Admin can pause or resume the AI.
      </span>
    </span>
  );
});

/** SCR-APP-058: pause mode (confirm `danger`) or resume mode (`primary`). */
export function KillSwitchDialog({
  mode,
  onClose,
  change,
  onDone,
}: {
  mode: KillSwitchMode | null;
  onClose: () => void;
  change: ReturnType<typeof useSetAiPaused>;
  onDone: (mode: KillSwitchMode) => void;
}) {
  const status = useAiStatus().data?.status;
  const pause = mode !== 'resume';
  const forbidden = change.error instanceof ApiError && change.error.status === 403;
  const notLive = status && !status.paused && status.liveChannels === 0;

  let alert = null;
  if (forbidden)
    alert = (
      <div className="alert alert--danger" role="alert">
        <p>Only the Owner or an Admin can do this.</p>
      </div>
    );
  else if (change.isError)
    alert = (
      <div className="alert alert--danger" role="alert">
        <p>We couldn't {pause ? 'pause' : 'resume'} the AI. Check your connection and try again.</p>
      </div>
    );

  return (
    <ConfirmDialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={pause ? 'Pause AI on all channels?' : 'Resume AI?'}
      confirmLabel={pause ? 'Pause AI now' : 'Resume AI'}
      confirmVariant={pause ? 'danger' : 'primary'}
      busy={change.isPending}
      busyLabel={pause ? 'Pausing…' : 'Resuming…'}
      confirmDisabled={forbidden}
      onConfirm={() =>
        change.mutate(pause, {
          onSuccess: () => onDone(pause ? 'pause' : 'resume'),
        })
      }
      alert={alert}
    >
      {pause ? (
        <>
          <p>
            Your assistant stops replying everywhere within 5 seconds, including any reply it's
            writing now. Your team can still answer from the Inbox.
          </p>
          {status && (
            <div className="kill-switch__fallback" role="group" aria-label="What visitors see">
              <p className="kill-switch__quote">“{status.fallback.en}”</p>
              <p className="kill-switch__caption">
                <Link to="/settings/assistant" onClick={onClose}>
                  Change it in Assistant settings
                </Link>
              </p>
            </div>
          )}
          {notLive && (
            <div className="alert alert--info">
              <p>
                No channel is live yet. If you pause now, the AI stays off after you go live until
                you resume it.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <p>
            Your assistant starts answering visitors again on every live channel.
            {status && status.liveChannels === 0 && (
              <> No channel is live yet, so visitors won't get AI replies until you go live.</>
            )}
          </p>
          {status && pausedSince(status) && (
            <p className="kill-switch__meta">{pausedSince(status)}</p>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}

import type { Correction, Fact } from '@kaki/contracts';
import { Button, SlideOver } from '@kaki/ui';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { coachAskHref, opensPanel, prefillFor, useBotName } from '../lib/coach.ts';
import { Icon } from '../shell/icon.tsx';
import { CoachChat } from './coach-chat.tsx';

/**
 * design.md §4.6 `quick-coach-panel` (FEAT-027 ui-design): "Ask Coach" on a Review fact
 * card or the Fact page. Wide screens get the slide-over with a new chat and the question
 * prefilled, not sent; narrow ones go to the Coach page. A correction still needs the
 * owner's tap on Confirm.
 */
export function AskCoachButton({
  fact,
  onConfirmed,
}: {
  fact: Pick<Fact, 'type' | 'value' | 'status'>;
  onConfirmed?: (c: Correction) => void;
}) {
  return (
    <CoachPanelButton
      label="Ask Coach"
      prefill={prefillFor(fact)}
      unreviewed={fact.status === 'needs_review'}
      narrowHref={coachAskHref(fact)}
      onConfirmed={onConfirmed}
    />
  );
}

/**
 * The same panel opened with any question prefilled: Replay's "Teach a fix" (FEAT-028
 * ui-design) prefills the customer's question.
 */
export function CoachPanelButton({
  label,
  prefill,
  unreviewed,
  narrowHref,
  onConfirmed,
}: {
  label: string;
  prefill: string;
  unreviewed: boolean;
  /** Where the button goes below 768 px: `/coach?ask=…`. */
  narrowHref: string;
  onConfirmed?: (c: Correction) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const botName = useBotName();

  const start = () => {
    if (!opensPanel(window.innerWidth)) return void navigate(narrowHref);
    setSessionId(null);
    setRound((n) => n + 1);
    setOpen(true);
  };

  return (
    <>
      <Button variant="ghost" onClick={start}>
        <span className="kaki-btn__icon" aria-hidden="true">
          <Icon name="coach" size={16} />
        </span>
        {label}
      </Button>
      <SlideOver
        open={open}
        onOpenChange={setOpen}
        title="Coach"
        closeLabel="Close coach"
        actions={
          <Link to={sessionId ? `/coach?session=${sessionId}` : narrowHref}>Open in Coach</Link>
        }
      >
        {open && (
          <CoachChat
            key={round}
            origin="panel"
            sessionId={sessionId}
            onSession={setSessionId}
            botName={botName}
            initialText={prefill}
            initialUnreviewed={unreviewed}
            onConfirmed={onConfirmed}
            autoFocus
          />
        )}
      </SlideOver>
    </>
  );
}

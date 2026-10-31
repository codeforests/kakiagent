import type { Me } from '@kaki/contracts';
import { Button, ConfirmDialog } from '@kaki/ui';
import { useEffect, useRef, useState } from 'react';
import { dockText, initials, ownerText, type DockMode } from '../lib/inbox.ts';
import {
  MAX_REPLY,
  newClientId,
  type DockActions,
  type DockSummary as Summary,
} from '../lib/takeover.ts';
import { Dock } from './conversation-parts.tsx';

/** The dock by `dockMode` (ui-design SCR-APP-015): takeover bar, composer, owned bar, closed. */
export function ThreadDock({
  conversation,
  me,
  actions,
  phone,
}: {
  conversation: Summary;
  me: Me | undefined;
  actions: DockActions;
  phone: boolean;
}) {
  const { mode, alert } = actions;
  return (
    <>
      {alert && (
        <div className={`alert alert--${alert.tone} dock-alert`} role="alert">
          {alert.text}
          {alert.retry && (
            <>
              {' '}
              <Button variant="ghost" onClick={alert.retry}>
                Try again
              </Button>
            </>
          )}
        </div>
      )}
      {actions.lostDraft && mode !== 'mine' && (
        <LostDraft text={actions.lostDraft} onDismiss={actions.clearLostDraft} />
      )}
      <DockBody conversation={conversation} me={me} actions={actions} phone={phone} mode={mode} />
    </>
  );
}

function DockBody({
  conversation: c,
  me,
  actions,
  phone,
  mode,
}: {
  conversation: Summary;
  me: Me | undefined;
  actions: DockActions;
  phone: boolean;
  mode: DockMode;
}) {
  if (mode === 'closed') return <Dock conversation={c} />;
  if (mode === 'ai') return <TakeoverBar conversation={c} actions={actions} />;
  if (mode === 'mine') return <Composer key={c.id} actions={actions} phone={phone} />;
  return <OwnedBar conversation={c} me={me} actions={actions} />;
}

function useFocusOnArrival<T extends HTMLElement>(
  actions: DockActions,
  target: 'composer' | 'takeover',
) {
  const ref = useRef<T>(null);
  const { focusNext, clearFocus } = actions;
  useEffect(() => {
    if (focusNext !== target || !ref.current) return;
    ref.current.focus();
    clearFocus();
  }, [focusNext, target, clearFocus]);
  return ref;
}

function TakeoverBar({ conversation, actions }: { conversation: Summary; actions: DockActions }) {
  const ref = useFocusOnArrival<HTMLButtonElement>(actions, 'takeover');
  const pending = actions.takeOver.isPending;
  return (
    <div className="thread-dock thread-dock--bar" data-testid="thread-dock" data-mode="ai">
      <p>{dockText(conversation)}</p>
      <Button
        ref={ref}
        onClick={() => actions.takeOver.mutate(undefined)}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending && <span className="spinner" aria-hidden="true" />}
        {pending ? 'Taking over…' : 'Take over'}
      </Button>
    </div>
  );
}

function Composer({ actions, phone }: { actions: DockActions; phone: boolean }) {
  const ref = useFocusOnArrival<HTMLTextAreaElement>(actions, 'composer');
  const [text, setText] = useState('');
  const clientId = useRef(newClientId());
  const sentText = useRef('');
  const { reply, handBack } = actions;
  const tooLong = text.length > MAX_REPLY;
  const empty = text.trim() === '';
  const sending = reply.isPending;

  const send = () => {
    if (empty || tooLong || sending) return;
    // A retry of the same text keeps its ID, so the server stores it once.
    if (sentText.current !== text) {
      clientId.current = newClientId();
      sentText.current = text;
    }
    reply.mutate(
      { body: text, clientMessageId: clientId.current },
      {
        onSuccess: () => {
          setText('');
          sentText.current = '';
          ref.current?.focus();
        },
      },
    );
  };

  return (
    <div className="thread-dock thread-dock--composer" data-testid="thread-dock" data-mode="mine">
      <div className="composer__caption">
        <p>You're handling this conversation. The assistant is paused.</p>
        {!phone && (
          <Button
            variant="secondary"
            onClick={() => handBack.mutate()}
            disabled={handBack.isPending}
            aria-busy={handBack.isPending || undefined}
          >
            {handBack.isPending && <span className="spinner" aria-hidden="true" />}
            Hand back to assistant
          </Button>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor="staff-reply" className="sr-only">
          Reply to visitor
        </label>
        <textarea
          id="staff-reply"
          ref={ref}
          className="input composer__input"
          rows={2}
          placeholder="Write a reply…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? 'staff-reply-error' : undefined}
          readOnly={sending}
        />
        <Button
          type="submit"
          disabled={empty || tooLong || sending}
          aria-busy={sending || undefined}
        >
          {sending && <span className="spinner" aria-hidden="true" />}
          Send
        </Button>
      </form>
      {tooLong && (
        <p id="staff-reply-error" className="field__error">
          Keep replies under 4,000 characters.
        </p>
      )}
    </div>
  );
}

function OwnedBar({
  conversation: c,
  me,
  actions,
}: {
  conversation: Summary;
  me: Me | undefined;
  actions: DockActions;
}) {
  const name = ownerText(c.owner, me?.user.id);
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { request, takeOver, requested } = actions;
  return (
    <div className="thread-dock thread-dock--bar" data-testid="thread-dock" data-mode="other">
      <span className="avatar avatar--sm" aria-hidden="true">
        {initials(name)}
      </span>
      <p>{name} is handling this conversation.</p>
      <div className="thread-dock__actions">
        <Button
          variant="secondary"
          onClick={() => request.mutate()}
          disabled={requested || request.isPending}
          aria-busy={request.isPending || undefined}
        >
          {request.isPending && <span className="spinner" aria-hidden="true" />}
          {requested ? '✓ Request sent' : `Ask ${name} to hand over`}
        </Button>
        {me?.canReassign && c.owner && (
          <Button variant="ghost" ref={trigger} onClick={() => setConfirm(true)}>
            Take over from {name}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Take over from ${name}?`}
        confirmLabel="Take over"
        busy={takeOver.isPending}
        busyLabel="Taking over…"
        onCloseAutoFocus={(e) => {
          // Cancelled: back to the trigger. Taken over: the composer takes focus itself.
          e.preventDefault();
          trigger.current?.focus();
        }}
        onConfirm={() =>
          c.owner &&
          takeOver.mutate(c.owner.userId, {
            onSettled: () => setConfirm(false),
          })
        }
      >
        {name} can no longer reply here. They'll be told you took over.
      </ConfirmDialog>
    </div>
  );
}

/** A reply refused because someone else took over: kept, read-only, with Copy. */
function LostDraft({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="lost-draft">
      <p className="lost-draft__label">Your unsent reply</p>
      <blockquote>{text}</blockquote>
      <div className="thread-dock__actions">
        <Button
          variant="secondary"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

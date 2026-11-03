import type { Me } from '@kaki/contracts';
import { Button, ConfirmDialog } from '@kaki/ui';
import { useEffect, useRef, useState } from 'react';
import { useAiStatus } from '../lib/ai-status.ts';
import { dockText, escalationStrip, initials, ownerText, type DockMode } from '../lib/inbox.ts';
import {
  isStale,
  needsReplaceConfirm,
  PAUSED_HELP,
  sendBody,
  STALE_TEXT,
  SUGGESTION_CAPTION,
  SUGGESTION_LABEL,
} from '../lib/suggestion.ts';
import {
  MAX_REPLY,
  newClientId,
  type DockActions,
  type DockSummary as Summary,
} from '../lib/takeover.ts';
import { Dock, FactLink, Glyph } from './conversation-parts.tsx';

/** The dock by `dockMode` (ui-design SCR-APP-015): takeover bar, composer, owned bar, closed. */
export function ThreadDock({
  conversation,
  me,
  actions,
  phone,
  latestVisitorSeq,
}: {
  conversation: Summary;
  me: Me | undefined;
  actions: DockActions;
  phone: boolean;
  /** The newest visitor message's seq, for a stale suggestion (FEAT-045). */
  latestVisitorSeq: number | null;
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
      <DockBody
        conversation={conversation}
        me={me}
        actions={actions}
        phone={phone}
        mode={mode}
        latestVisitorSeq={latestVisitorSeq}
      />
    </>
  );
}

function DockBody({
  conversation: c,
  me,
  actions,
  phone,
  mode,
  latestVisitorSeq,
}: {
  conversation: Summary;
  me: Me | undefined;
  actions: DockActions;
  phone: boolean;
  mode: DockMode;
  latestVisitorSeq: number | null;
}) {
  if (mode === 'closed') return <Dock conversation={c} />;
  if (mode === 'ai') return <TakeoverBar conversation={c} actions={actions} meId={me?.user.id} />;
  if (mode === 'mine')
    return (
      <Composer key={c.id} actions={actions} phone={phone} latestVisitorSeq={latestVisitorSeq} />
    );
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

function TakeoverBar({
  conversation,
  actions,
  meId,
}: {
  conversation: Summary;
  actions: DockActions;
  meId: string | undefined;
}) {
  const ref = useFocusOnArrival<HTMLButtonElement>(actions, 'takeover');
  const pending = actions.takeOver.isPending;
  const suggesting = actions.suggestAfterTakeover;
  const paused = useSuggestPaused(actions);
  const escalation = conversation.status === 'escalated' ? conversation.escalation : null;
  return (
    <div className="thread-dock thread-dock--bar" data-testid="thread-dock" data-mode="ai">
      {escalation ? (
        <EscalationStrip strip={escalationStrip(escalation, meId)} />
      ) : (
        <p>{dockText(conversation)}</p>
      )}
      <div className="thread-dock__actions">
        <Button
          ref={ref}
          onClick={() => actions.takeOver.mutate(undefined)}
          disabled={pending}
          aria-busy={(pending && !suggesting) || undefined}
        >
          {pending && !suggesting && <span className="spinner" aria-hidden="true" />}
          {pending && !suggesting ? 'Taking over…' : 'Take over'}
        </Button>
        <Button
          variant="secondary"
          onClick={actions.takeOverAndSuggest}
          disabled={pending || paused}
          aria-busy={suggesting || undefined}
          aria-describedby={paused ? 'suggest-paused-help' : undefined}
        >
          {suggesting ? <span className="spinner" aria-hidden="true" /> : <Glyph name="spark" />}
          {suggesting ? 'Taking over…' : 'Suggest a reply'}
        </Button>
      </div>
      {paused && (
        <p id="suggest-paused-help" className="suggest-help">
          {PAUSED_HELP}
        </p>
      )}
    </div>
  );
}

/** The assistant is paused (FEAT-057), from the status or a 409 `ai_paused`. */
function useSuggestPaused(actions: DockActions) {
  const status = useAiStatus();
  return actions.suggestPaused || status.data?.status.paused === true;
}

/** The escalation strip (FEAT-044 ui-design SCR-APP-015): who, since when, and why. */
function EscalationStrip({ strip }: { strip: ReturnType<typeof escalationStrip> }) {
  return (
    <div className="escalation-strip" data-testid="escalation-strip">
      <p>{strip.lead}</p>
      <p>{strip.rest}</p>
      {strip.afterHours && <p className="escalation-strip__caption">{strip.afterHours}</p>}
      {strip.reminders && <p className="escalation-strip__caption">{strip.reminders}</p>}
    </div>
  );
}

function Composer({
  actions,
  phone,
  latestVisitorSeq,
}: {
  actions: DockActions;
  phone: boolean;
  latestVisitorSeq: number | null;
}) {
  const ref = useFocusOnArrival<HTMLTextAreaElement>(actions, 'composer');
  const [text, setText] = useState('');
  const clientId = useRef(newClientId());
  const sentText = useRef('');
  const { reply, handBack, suggest, suggestion } = actions;
  // The draft the box holds (FEAT-045): its ID goes with Send until the box is emptied or sent.
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [announce, setAnnounce] = useState('');
  const paused = useSuggestPaused(actions);
  const tooLong = text.length > MAX_REPLY;
  const empty = text.trim() === '';
  const sending = reply.isPending;
  const writing = suggest.isPending;

  // A new suggestion fills the box, caret at the end.
  if (suggestion && applied !== suggestion.id) {
    setApplied(suggestion.id);
    setText(suggestion.text);
    setDraft({ id: suggestion.id, text: suggestion.text });
    setAnnounce('Suggestion ready. Edit it, then send.');
  }
  useEffect(() => {
    const el = ref.current;
    if (!applied || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [applied, ref]);

  const holding = draft !== null && suggestion?.id === draft.id ? suggestion : null;
  const stale = holding !== null && isStale(holding, latestVisitorSeq);

  const requestSuggestion = () => {
    if (needsReplaceConfirm(text, draft?.text ?? null)) return setConfirmReplace(true);
    suggest.mutate();
  };

  const send = () => {
    if (empty || tooLong || sending) return;
    // A retry of the same text keeps its ID, so the server stores it once.
    if (sentText.current !== text) {
      clientId.current = newClientId();
      sentText.current = text;
    }
    reply.mutate(sendBody(text, clientId.current, draft?.id ?? null), {
      onSuccess: () => {
        setText('');
        setDraft(null);
        sentText.current = '';
        ref.current?.focus();
      },
    });
  };

  const suggestDisabled = paused || sending || writing || actions.suggestBlocked;
  const suggestLabel = writing ? 'Writing…' : holding ? 'Suggest again' : 'Suggest a reply';
  const describedBy =
    [tooLong && 'staff-reply-error', holding && 'suggestion-label'].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="thread-dock thread-dock--composer" data-testid="thread-dock" data-mode="mine">
      <div className="composer__caption">
        <p>You're handling this conversation. The assistant is paused.</p>
        <div className="thread-dock__actions">
          {!phone && (
            <Button
              variant="ghost"
              onClick={requestSuggestion}
              disabled={suggestDisabled}
              aria-busy={writing || undefined}
              aria-describedby={paused ? 'suggest-paused-help' : undefined}
              data-testid="suggest-reply"
            >
              {writing ? <span className="spinner" aria-hidden="true" /> : <Glyph name="spark" />}
              {suggestLabel}
            </Button>
          )}
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
      </div>
      <p className="sr-only" aria-live="polite">
        {writing ? 'Writing a suggestion' : announce}
      </p>
      {paused && (
        <p id="suggest-paused-help" className="suggest-help">
          {PAUSED_HELP}
        </p>
      )}
      {stale && (
        <div className="alert alert--info" data-testid="suggestion-stale">
          {STALE_TEXT}{' '}
          <Button variant="ghost" onClick={requestSuggestion} disabled={suggestDisabled}>
            Suggest again
          </Button>
        </div>
      )}
      {holding && (
        <p id="suggestion-label" className="suggestion-label" data-testid="suggestion-label">
          <Glyph name="spark" size={14} />
          {SUGGESTION_LABEL}
        </p>
      )}
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
          className={`input composer__input${holding ? ' composer__input--suggestion' : ''}`}
          rows={holding ? 5 : 2}
          placeholder={writing ? 'Writing a suggestion…' : 'Write a reply…'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            actions.dismissSuggestNotice();
            if (e.target.value.trim() === '') setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          aria-invalid={tooLong || undefined}
          aria-describedby={describedBy}
          aria-busy={writing || undefined}
          readOnly={sending || writing}
        />
        {phone && (
          <Button
            variant="ghost"
            className="composer__suggest-icon"
            onClick={requestSuggestion}
            disabled={suggestDisabled}
            aria-busy={writing || undefined}
            aria-label={holding ? 'Suggest again' : 'Suggest a reply'}
            aria-describedby={paused ? 'suggest-paused-help' : undefined}
            data-testid="suggest-reply"
          >
            {writing ? <span className="spinner" aria-hidden="true" /> : <Glyph name="spark" />}
          </Button>
        )}
        <Button
          type="submit"
          disabled={empty || tooLong || sending}
          aria-busy={sending || undefined}
        >
          {sending && <span className="spinner" aria-hidden="true" />}
          Send
        </Button>
      </form>
      {holding && (
        <>
          {holding.facts.length > 0 && (
            <ul className="fact-chips" aria-label="Facts the suggestion used">
              {holding.facts.map((f) => (
                <li key={f.id}>
                  <FactLink fact={f} />
                </li>
              ))}
            </ul>
          )}
          <p className="suggest-help">{SUGGESTION_CAPTION}</p>
        </>
      )}
      {tooLong && (
        <p id="staff-reply-error" className="field__error">
          Keep replies under 4,000 characters.
        </p>
      )}
      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title="Replace your reply with a new suggestion?"
        confirmLabel="Replace"
        cancelLabel="Keep my reply"
        onConfirm={() => {
          setConfirmReplace(false);
          suggest.mutate();
        }}
      >
        What you've written will be replaced.
      </ConfirmDialog>
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

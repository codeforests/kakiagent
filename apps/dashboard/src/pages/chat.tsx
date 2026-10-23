import type { Source } from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { dayLabel, updatedLabel } from '../lib/facts.ts';
import { useToast } from '../lib/form.ts';
import {
  busy,
  CHAT_REDACTION_NOTICE,
  chatTypeLabel,
  failureText,
  sizeLabel,
  stageLabel,
  useRetry,
  useStatusAnnouncements,
} from '../lib/sources.ts';
import { ReviewQueue } from './review.tsx';
import { SourceProgress, SourceState, UploadAgain } from './sources.tsx';

type Chat = NonNullable<Source['chat']>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const REDACTED_LABEL: [keyof Chat['redacted'], string][] = [
  ['names', 'Names'],
  ['phones', 'Phone numbers'],
  ['emails', 'E-mail addresses'],
  ['ids', 'NRIC and card numbers'],
  ['addresses', 'Addresses'],
];

/**
 * SCR-APP-026 Chat-history import (KB-04; FEAT-017 ui-design): a chat export's route
 * renders this instead of SCR-APP-024, with the same loading and error states.
 */
export function ChatPage({ source }: { source: Source }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [confirming, setConfirming] = useState(false);
  const [announced, setAnnounced] = useStatusAnnouncements([source]);
  const retry = useRetry((s) => setAnnounced(`Retrying ${s.name}.`));
  const remove = useMutation({
    mutationFn: (s: Source) => api.deleteSource(s.id, s.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      void navigate('/knowledge/sources', { state: { toast: 'Chat export deleted.' } });
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['sources'] });
        void navigate('/knowledge/sources', {
          state: { toast: 'This chat export was already deleted.' },
        });
      } else if (err instanceof ApiError && err.status === 409)
        await queryClient.invalidateQueries({ queryKey: ['source', source.id] });
    },
  });
  const removeError = remove.error instanceof ApiError ? remove.error : null;
  const file = source.file;
  const typeLabel = chatTypeLabel(source);
  const chat = source.chat;
  const suggested = source.counts.facts;
  const approved = suggested - source.counts.factsNeedingReview;

  const onRetry = () =>
    retry.mutate(source, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409)
          setToast('This chat export has already changed.');
        else setToast("We couldn't retry just now. Nothing was changed.");
      },
    });

  return (
    <div className="source-page chat-page">
      <Link className="back-link" to="/knowledge/sources">
        Sources
      </Link>
      <div className="source-page__head">
        <div>
          <h1 className="page-title">{source.name}</h1>
          {file && (
            <p className="source-page__meta">
              {[
                ...(typeLabel ? [typeLabel] : []),
                sizeLabel(file.sizeBytes),
                `Uploaded ${updatedLabel(source.createdAt)}`,
              ].join(' · ')}
            </p>
          )}
          {file?.scannedAt && (
            <p className="source-page__meta source-page__clean">
              <CheckIcon /> Checked for malware: none found
            </p>
          )}
        </div>
        <SourceState source={source} />
      </div>

      {busy(source) && (
        <>
          <div className="alert alert--info">
            <p>{CHAT_REDACTION_NOTICE}</p>
          </div>
          <section className="card source-status" aria-label="Status">
            <p className="source-status__stage">
              {source.stage ? stageLabel(source, source.stage) : 'Waiting'}
            </p>
            <SourceProgress source={source} />
          </section>
        </>
      )}

      {chat && <PrivacyCard chat={chat} />}

      {source.status === 'ready' &&
        (suggested > 0 ? (
          <section className="chat-page__suggestions" aria-labelledby="chat-suggestions">
            <h2 id="chat-suggestions" className="section-title">
              Suggested FAQs ({suggested})
            </h2>
            <p className="chat-page__lead">
              These come from your replies in the chat. Approve the ones customers should get, edit
              any wording, and discard the rest.
            </p>
            <ReviewQueue
              scoped={{
                sourceId: source.id,
                type: 'faq',
                empty: (
                  <EmptyState
                    title="All suggestions reviewed"
                    action={<Link to={`/knowledge?sourceId=${source.id}`}>See your FAQs</Link>}
                  >
                    {`${approved} approved`}
                  </EmptyState>
                ),
              }}
            />
          </section>
        ) : (
          <EmptyState title="No questions found">
            {`We read ${chat ? `${chat.messages} ` : 'the '}messages but didn't find questions with a general answer from you. Chats where customers ask about prices, opening hours or how things work give the best suggestions.`}
          </EmptyState>
        ))}

      {source.status === 'failed' && (
        <div className="alert alert--danger" role="alert">
          <p>{failureText(source)}</p>
          {source.retryable ? (
            <Button
              variant="secondary"
              onClick={onRetry}
              disabled={retry.isPending}
              aria-busy={retry.isPending || undefined}
            >
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          ) : (
            <UploadAgain source={source} />
          )}
        </div>
      )}

      <div className="source-page__footer">
        <Button variant="danger-ghost" onClick={() => setConfirming(true)}>
          Delete chat export…
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (open) return;
          remove.reset();
          setConfirming(false);
        }}
        title="Delete this chat export?"
        confirmLabel="Delete chat export"
        confirmVariant="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(source)}
        alert={
          removeError?.code === 'invalid_state' ? (
            <div className="alert alert--warning" role="alert">
              <p>This chat export is still being read. Try again when it's finished.</p>
            </div>
          ) : removeError?.code === 'version_conflict' ? (
            <div className="alert alert--warning" role="alert">
              <p>This chat export changed since you opened it. Close this and try again.</p>
            </div>
          ) : remove.isError && removeError?.status !== 404 ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't delete the chat export just now. Nothing was changed.</p>
            </div>
          ) : null
        }
      >
        <p>Its suggestions and any FAQs you approved from it are removed.</p>
      </ConfirmDialog>

      <div className="sr-only" aria-live="polite">
        {announced}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/** What the parse removed and read; counts only, never the removed values (NFR-11). */
function PrivacyCard({ chat }: { chat: Chat }) {
  const removed = REDACTED_LABEL.filter(([key]) => chat.redacted[key] > 0);
  return (
    <section className="card chat-privacy" aria-labelledby="chat-privacy">
      <h2 id="chat-privacy" className="section-title">
        Personal data removed
      </h2>
      {removed.length > 0 ? (
        <dl className="chat-privacy__counts">
          {removed.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{chat.redacted[key]}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>We didn't find any personal data to remove.</p>
      )}
      {chat.exportDeletedAt && (
        <p className="chat-privacy__deleted">
          <CheckIcon /> The export file was deleted on {updatedLabel(chat.exportDeletedAt)}
        </p>
      )}
      <p className="chat-privacy__read">
        {`${plural(chat.messages, 'message')} from ${dayLabel(chat.from)} to ${dayLabel(chat.to)} · ${plural(chat.exchanges, 'question')} answered by you`}
      </p>
      {chat.messagesSkipped > 0 && (
        <p className="chat-privacy__skipped">Only the latest {chat.messages} messages were read.</p>
      )}
    </section>
  );
}

function CheckIcon() {
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
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

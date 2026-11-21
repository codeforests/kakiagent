import {
  DSR_VERIFY_METHODS,
  type DsrDetail,
  type DsrEraseResult,
  type DsrFindResult,
  type DsrVerifyMethod,
} from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState, FormDialog } from '@kaki/ui';
import { useMutation, type UseQueryResult } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import {
  conversationTicked,
  dsrDay,
  dsrErrorText,
  nothingPicked,
  otherText,
  personCounts,
  phoneText,
  pickedCounts,
  pickedText,
  recoveryOf,
  removedText,
  requesterLabel,
  searchedText,
  selectionBody,
  sizeText,
  toggle,
  VERIFY_METHOD_TEXT,
  withPerson,
  type Picked,
} from '../lib/data-requests.ts';
import { save } from '../lib/download.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { CHANNEL_LABEL } from '../lib/inbox.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';

/** SCR-APP-049's step cards: verify, find, act, done (FEAT-061 ui-design). */

export interface PageAlert {
  text: string;
  recovery: 'reload' | 'search';
}

interface Ctx {
  d: DsrDetail;
  update: (next: DsrDetail) => void;
  /** Shows the page alert for a 409/422 that needs a reload or a new search; true if it did. */
  fail: (err: unknown) => boolean;
  setToast: (t: string) => void;
}

const channelLabel = (c: string) => (CHANNEL_LABEL as Record<string, string>)[c] ?? c;

// ---- Step 1 · Verify identity ---------------------------------------------------------------

export function VerifyCard({ d, update, fail, setToast }: Ctx) {
  const [method, setMethod] = useState<DsrVerifyMethod | ''>('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const errors = {
    method: method ? undefined : 'Choose how you checked',
    note: note.trim() ? undefined : 'Say what you checked',
  };
  const verify = useMutation({
    mutationFn: () =>
      api.dataRequestAction(d.id, 'verify', {
        version: d.version,
        method: method || 'other',
        note,
      }),
    onSuccess: (next) => {
      update(next);
      setToast('Identity verified.');
    },
    onError: (err) => void fail(err),
  });
  const refuse = useMutation({
    mutationFn: (reason: string) =>
      api.dataRequestAction(d.id, 'unverified', { version: d.version, reason }),
    onSuccess: (next) => {
      update(next);
      setRefusing(false);
      setToast('Request closed as not verified.');
    },
    onError: (err) => {
      if (fail(err)) setRefusing(false);
    },
  });

  if (d.verification) {
    const v = d.verification;
    return (
      <section className="card stack" aria-labelledby="dsr-verify-title" data-testid="dsr-verified">
        <h2 className="section-title" id="dsr-verify-title">
          Step 1 · Verify identity
        </h2>
        <p className="dsr-verified">
          <span className="dsr-tick" aria-hidden="true">
            ✓
          </span>
          Identity verified by {v.by ?? 'a team member'} on {dsrDay(v.at)}:{' '}
          {VERIFY_METHOD_TEXT[v.method]}. {v.note}
        </p>
      </section>
    );
  }
  if (d.status !== 'open') return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (errors.method || errors.note) return;
    verify.mutate();
  };
  const shown = submitted ? errors : { method: undefined, note: undefined };
  const busy = verify.isPending;
  return (
    <section className="card stack" aria-labelledby="dsr-verify-title">
      <h2 className="section-title" id="dsr-verify-title">
        Step 1 · Verify identity
      </h2>
      <p>Check the person asking is the customer before you act. Write down how you checked.</p>
      <form className="fact-form" onSubmit={submit} noValidate>
        <fieldset
          className="radio-group"
          aria-invalid={shown.method ? true : undefined}
          aria-describedby={shown.method ? 'dsr-method-error' : undefined}
        >
          <legend className="field__label">How did you check?</legend>
          {DSR_VERIFY_METHODS.map((m, i) => (
            <label className="radio" key={m}>
              <input
                type="radio"
                name="dsr-method"
                id={i === 0 ? 'dsr-method' : undefined}
                checked={method === m}
                onChange={() => setMethod(m)}
                disabled={busy}
              />
              <span>{VERIFY_METHOD_TEXT[m]}</span>
            </label>
          ))}
          {shown.method && (
            <p className="field__error" id="dsr-method-error">
              <span aria-hidden="true">!</span> {shown.method}
            </p>
          )}
        </fieldset>
        <Field
          id="dsr-verify-note"
          label="Note"
          error={shown.note}
          help="What you checked. Don't type ID numbers; they'll be masked."
        >
          <textarea
            id="dsr-verify-note"
            className="input input--area"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={shown.note ? true : undefined}
            aria-describedby={describedBy('dsr-verify-note', shown.note, true)}
            readOnly={busy}
          />
        </Field>
        {verify.isError && !recoveryOf(verify.error) && (
          <div className="alert alert--danger" role="alert">
            <p>{dsrErrorText(verify.error)}</p>
          </div>
        )}
        <div className="dsr-actions">
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Saving…' : 'Mark identity verified'}
          </Button>
          <Button
            type="button"
            variant="danger-ghost"
            onClick={() => setRefusing(true)}
            disabled={busy}
          >
            Couldn't verify
          </Button>
        </div>
      </form>
      <CloseDialog
        open={refusing}
        onOpenChange={setRefusing}
        title="Close as not verified?"
        body="The request is closed and no data is shown, sent or deleted."
        confirmLabel="Close request"
        busy={refuse.isPending}
        error={refuse.isError && !recoveryOf(refuse.error) ? dsrErrorText(refuse.error) : null}
        onConfirm={(reason) => refuse.mutate(reason)}
      />
    </section>
  );
}

/** A confirm dialog with a required Reason (Couldn't verify; Close without action). */
export function CloseDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  busy,
  error,
  quickReasons = [],
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  quickReasons?: string[];
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const missing = tried && !reason.trim() ? 'Enter a reason' : undefined;
  const id = `dsr-reason-${title.length}`;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          setTried(false);
        }
        onOpenChange(o);
      }}
      title={title}
      confirmLabel={confirmLabel}
      confirmVariant="danger"
      busy={busy}
      busyLabel="Closing…"
      onConfirm={() => {
        setTried(true);
        if (reason.trim()) onConfirm(reason.trim());
      }}
      alert={
        error ? (
          <div className="alert alert--danger" role="alert">
            <p>{error}</p>
          </div>
        ) : undefined
      }
    >
      <p>{body}</p>
      {quickReasons.length > 0 && (
        <div className="dsr-quick" role="group" aria-label="Common reasons">
          {quickReasons.map((q) => (
            <Button key={q} type="button" variant="secondary" onClick={() => setReason(q)}>
              {q}
            </Button>
          ))}
        </div>
      )}
      <Field id={id} label="Reason" error={missing}>
        <textarea
          id={id}
          className="input input--area"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={missing ? true : undefined}
          aria-describedby={describedBy(id, missing)}
          readOnly={busy}
        />
      </Field>
    </ConfirmDialog>
  );
}

// ---- Step 2 · Data we hold ------------------------------------------------------------------

export function FindCard({
  d,
  find,
  picked,
  onPick,
  onEditSearch,
}: Ctx & {
  find: UseQueryResult<DsrFindResult>;
  picked: Picked | null;
  onPick: (p: Picked) => void;
  onEditSearch: () => void;
}) {
  // Ticking matters only where the next step uses it: export and delete, once verified.
  const selectable = d.status === 'verified' && d.type !== 'correction';
  const r = find.data;
  const empty = r && r.contacts.length + r.conversations.length + r.kb.length === 0;
  return (
    <section className="card stack dsr-find" aria-labelledby="dsr-find-title">
      <h2 className="section-title" id="dsr-find-title">
        Step 2 · Data we hold
      </h2>
      <p aria-live="polite" className="dsr-caption">
        {find.isPending
          ? 'Searching every store…'
          : r
            ? `Searched for: ${searchedText(r.searchedFor)}`
            : ''}
        {r && d.status === 'open' && (
          <>
            {' '}
            <Button variant="ghost" className="kaki-btn--sm" onClick={onEditSearch}>
              Edit search
            </Button>
          </>
        )}
      </p>
      {d.status === 'open' && r && (
        <p className="dsr-caption">A preview: verify their identity before you act on it.</p>
      )}
      {find.isPending && (
        <div aria-hidden="true">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}
      {find.isError && (
        <ErrorState
          title="Couldn't search for their data"
          action={
            <Button variant="secondary" onClick={() => void find.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {empty && (
        <EmptyState title="We hold no data for these details">
          You can complete the request and tell them so.
        </EmptyState>
      )}
      {r && !empty && (
        <>
          {r.contacts.length > 0 && (
            <div className="stack">
              <h3 className="subsection-title">People</h3>
              <ul className="dsr-people">
                {r.contacts.map((c) => (
                  <li key={c.id} className="dsr-person" data-testid="dsr-person">
                    {selectable && picked ? (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={picked.contactIds.includes(c.id)}
                          onChange={(e) =>
                            onPick({
                              ...picked,
                              contactIds: toggle(picked.contactIds, c.id, e.target.checked),
                            })
                          }
                        />
                        <span className="dsr-person__name">{c.name || 'No name given'}</span>
                      </label>
                    ) : (
                      <span className="dsr-person__name">{c.name || 'No name given'}</span>
                    )}
                    <span className="dsr-caption">
                      {requesterLabel({
                        email: c.email,
                        phone: c.phone,
                        telegramId: c.telegram,
                      })}
                    </span>
                    <span className="dsr-caption">{personCounts(c)}</span>
                    <Link to={`/contacts/${c.id}`}>Open contact</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.conversations.length > 0 && (
            <div className="stack">
              <h3 className="subsection-title">Conversations</h3>
              <div className="table-scroll">
                <table className="fact-table dsr-convs">
                  <thead>
                    <tr>
                      {selectable && (
                        <th scope="col">
                          <span className="sr-only">Include</span>
                        </th>
                      )}
                      <th scope="col">Channel</th>
                      <th scope="col">Started</th>
                      <th scope="col">Last message</th>
                      <th scope="col">Messages</th>
                      <th scope="col">Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.conversations.map((c) => {
                      const locked = picked ? withPerson(c, picked) : false;
                      return (
                        <tr key={c.id} className="dsr-conv" data-testid="dsr-conversation">
                          {selectable && picked && (
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Include the ${channelLabel(c.channel)} conversation started ${dsrDay(c.startedAt)}`}
                                checked={conversationTicked(c, picked)}
                                disabled={locked}
                                onChange={(e) =>
                                  onPick({
                                    ...picked,
                                    conversationIds: toggle(
                                      picked.conversationIds,
                                      c.id,
                                      e.target.checked,
                                    ),
                                  })
                                }
                              />
                            </td>
                          )}
                          <td>
                            <Link to={`/inbox/${c.id}`}>{channelLabel(c.channel)}</Link>
                            {c.match === 'mention' && (
                              <>
                                {' '}
                                <span className="chip chip--neutral">Mentions them</span>
                              </>
                            )}
                          </td>
                          <td>{dsrDay(c.startedAt)}</td>
                          <td>{dsrDay(c.lastMessageAt)}</td>
                          <td>{c.messages}</td>
                          <td>{c.attachments}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {r.attachments.length > 0 && (
            <div className="stack">
              <h3 className="subsection-title">Files</h3>
              <ul className="dsr-files">
                {r.attachments.map((a) => (
                  <li key={a.id}>
                    <span>{a.name}</span>{' '}
                    <span className="dsr-caption">
                      {sizeText(a.size)}
                      {a.contentType ? ` · ${a.contentType}` : ''}
                    </span>{' '}
                    {a.status === 'clean' && (
                      <a href={api.attachmentUrl(a.id)} aria-label={`Download ${a.name}`}>
                        Download
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <p className="dsr-caption">Send these with the export if they asked for a copy.</p>
            </div>
          )}
          {r.kb.length > 0 && (
            <div className="stack">
              <h3 className="subsection-title">Knowledge</h3>
              <ul className="dsr-kb">
                {r.kb.map((k) => {
                  const list = k.kind === 'fact' ? 'factIds' : 'stagedFactIds';
                  const title = `${k.kind === 'fact' ? 'Fact' : 'Waiting for review'}: ${k.title}`;
                  return (
                    <li key={k.id}>
                      {selectable && picked ? (
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={picked[list].includes(k.id)}
                            onChange={(e) =>
                              onPick({
                                ...picked,
                                [list]: toggle(picked[list], k.id, e.target.checked),
                              })
                            }
                          />
                          <span>{title}</span>
                        </label>
                      ) : (
                        <span>{title}</span>
                      )}
                      <span className="dsr-caption dsr-kb__excerpt">{k.excerpt}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="dsr-caption">Only tick items that are about this person.</p>
            </div>
          )}
          {r.contacts.length > 0 && (
            <p className="dsr-caption" data-testid="dsr-other">
              Also removed with the person: {otherText(r.other)}
            </p>
          )}
          {selectable && picked && (
            <p className="dsr-summary" aria-live="polite" data-testid="dsr-selected">
              Selected: {pickedText(pickedCounts(r, picked))}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---- Step 3 · Act ---------------------------------------------------------------------------

export function ActCard({
  d,
  update,
  fail,
  setToast,
  find,
  picked,
  onErased,
}: Ctx & { find: DsrFindResult; picked: Picked; onErased: (r: DsrEraseResult) => void }) {
  const { guard } = useReauthGuard();
  const counts = pickedCounts(find, picked);
  const nothing = nothingPicked(counts);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const [completing, setCompleting] = useState(false);
  const [correcting, setCorrecting] = useState<DsrFindResult['contacts'][number] | null>(null);

  const doExport = useMutation({
    mutationFn: () =>
      guard(() =>
        api.exportDataRequest(d.id, { version: d.version, selection: selectionBody(find, picked) }),
      ),
    onSuccess: ({ name, blob }) => {
      save(blob, name ?? `data-request-${d.ref}.json`);
      setExporting(false);
      setToast('Export downloaded. This is recorded in the audit log.');
    },
    onError: (err) => {
      if (err instanceof ReauthCancelled) return;
      if (fail(err)) setExporting(false);
    },
  });
  const erase = useMutation({
    mutationFn: () =>
      guard(() =>
        api.eraseDataRequest(d.id, {
          version: d.version,
          selection: selectionBody(find, picked),
          confirm: 'delete',
        }),
      ),
    onSuccess: (res) => {
      onErased(res);
      update(res.detail);
      setDeleting(false);
      setToast('Data deleted.');
    },
    onError: (err) => {
      if (err instanceof ReauthCancelled) return;
      if (fail(err)) setDeleting(false);
    },
  });
  const complete = useMutation({
    mutationFn: (note: string) =>
      api.dataRequestAction(d.id, 'complete', { version: d.version, note }),
    onSuccess: (next) => {
      update(next);
      setCompleting(false);
      setToast('Request completed.');
    },
    onError: (err) => {
      if (fail(err)) setCompleting(false);
    },
  });

  const typedOk = typed.trim().toLowerCase() === 'delete';
  const errorAlert = (err: unknown) =>
    err && !(err instanceof ReauthCancelled) && !recoveryOf(err) ? (
      <div className="alert alert--danger" role="alert">
        <p>{dsrErrorText(err)}</p>
      </div>
    ) : undefined;

  return (
    <section className="card stack" aria-labelledby="dsr-act-title">
      <h2 className="section-title" id="dsr-act-title">
        Step 3 ·{' '}
        {d.type === 'access'
          ? 'Send them a copy'
          : d.type === 'correction'
            ? 'Correct their details'
            : 'Delete their data'}
      </h2>
      {d.type === 'access' && (
        <div className="dsr-actions">
          <Button onClick={() => setExporting(true)} disabled={nothing}>
            Export data
          </Button>
          <Button variant="secondary" onClick={() => setCompleting(true)}>
            Mark completed
          </Button>
        </div>
      )}
      {d.type === 'correction' && (
        <>
          {find.contacts.length === 0 && (
            <p className="dsr-caption">Nobody was found to correct.</p>
          )}
          <ul className="dsr-people">
            {find.contacts.map((c) => (
              <li key={c.id} className="dsr-person">
                <span className="dsr-person__name">{c.name || 'No name given'}</span>
                <Button variant="secondary" onClick={() => setCorrecting(c)}>
                  Correct details
                  <span className="sr-only"> for {c.name || 'this person'}</span>
                </Button>
              </li>
            ))}
          </ul>
          <div className="dsr-actions">
            <Button variant="secondary" onClick={() => setCompleting(true)}>
              Mark completed
            </Button>
          </div>
        </>
      )}
      {d.type === 'deletion' && (
        <>
          <p>Everything ticked above is deleted for good. Backups clear within 35 days.</p>
          <div className="dsr-actions">
            <Button variant="danger" onClick={() => setDeleting(true)} disabled={nothing}>
              Delete selected data
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={exporting}
        onOpenChange={(o) => {
          if (!o) doExport.reset();
          setExporting(o);
        }}
        title="Export this person's data"
        confirmLabel="Export"
        busy={doExport.isPending}
        busyLabel="Exporting…"
        onConfirm={() => doExport.mutate()}
        alert={errorAlert(doExport.error)}
      >
        <p>
          A JSON file with {counts.conversations} conversations and {counts.messages} messages. It
          holds personal data: send it only to the requester.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => {
          if (!o) {
            setTyped('');
            erase.reset();
          }
          setDeleting(o);
        }}
        title="Delete this person's data?"
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmDisabled={!typedOk}
        busy={erase.isPending}
        busyLabel="Deleting…"
        onConfirm={() => {
          if (typedOk) erase.mutate();
        }}
        alert={errorAlert(erase.error)}
      >
        <p data-testid="dsr-delete-counts">{pickedText(counts, true)}.</p>
        <p>This can't be undone. It is removed now; backups clear within 35 days.</p>
        <Field id="dsr-confirm" label="Type delete to confirm">
          <input
            id="dsr-confirm"
            className="input"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            readOnly={erase.isPending}
          />
        </Field>
      </ConfirmDialog>

      <CompleteDialog
        open={completing}
        onOpenChange={setCompleting}
        busy={complete.isPending}
        error={
          complete.isError && !recoveryOf(complete.error) ? dsrErrorText(complete.error) : null
        }
        onConfirm={(note) => complete.mutate(note)}
      />
      {correcting && (
        <CorrectDialog
          d={d}
          person={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={(next) => {
            update(next);
            setCorrecting(null);
            setToast('Details corrected.');
          }}
          fail={fail}
        />
      )}
    </section>
  );
}

function CompleteDialog({
  open,
  onOpenChange,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string | null;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark this request completed?"
      confirmLabel="Mark completed"
      busy={busy}
      busyLabel="Saving…"
      onConfirm={() => onConfirm(note)}
      alert={
        error ? (
          <div className="alert alert--danger" role="alert">
            <p>{error}</p>
          </div>
        ) : undefined
      }
    >
      <p>The request moves to Closed.</p>
      <Field id="dsr-complete-note" label="What you sent them (optional)">
        <textarea
          id="dsr-complete-note"
          className="input input--area"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          readOnly={busy}
        />
      </Field>
    </ConfirmDialog>
  );
}

type Person = DsrFindResult['contacts'][number];

/** "Correct details": only changed fields are sent; a cleared field clears it (null). */
function CorrectDialog({
  d,
  person,
  onClose,
  onSaved,
  fail,
}: {
  d: DsrDetail;
  person: Person;
  onClose: () => void;
  onSaved: (next: DsrDetail) => void;
  fail: (err: unknown) => boolean;
}) {
  const lead = person.leads.find((l) => l.status === 'new' || l.status === 'contacted');
  const start = {
    name: person.name ?? '',
    email: person.email ?? '',
    phone: person.phone ? phoneText(person.phone) : '',
    need: lead?.need ?? '',
    budget: lead?.budget ?? '',
    preferredTime: lead?.preferredTime ?? '',
  };
  const [v, setV] = useState(start);
  const [noChange, setNoChange] = useState(false);
  const changed = (k: keyof typeof start) => (v[k] !== start[k] ? v[k].trim() || null : undefined);
  const save = useMutation({
    mutationFn: () => {
      const contact = { name: changed('name'), email: changed('email'), phone: changed('phone') };
      const leadPatch = lead
        ? {
            id: lead.id,
            need: changed('need'),
            budget: changed('budget'),
            preferredTime: changed('preferredTime'),
          }
        : undefined;
      return api.correctDataRequest(d.id, {
        version: d.version,
        contactId: person.id,
        contact,
        ...(leadPatch &&
        [leadPatch.need, leadPatch.budget, leadPatch.preferredTime].some((x) => x !== undefined)
          ? { lead: leadPatch }
          : {}),
      });
    },
    onSuccess: onSaved,
    onError: (err) => {
      if (fail(err)) onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const any = (Object.keys(start) as (keyof typeof start)[]).some((k) => v[k] !== start[k]);
    setNoChange(!any);
    if (any) save.mutate();
  };
  const busy = save.isPending;
  const input = (k: keyof typeof start, label: string, type = 'text') => (
    <Field id={`dsr-fix-${k}`} label={label}>
      <input
        id={`dsr-fix-${k}`}
        className="input"
        type={type}
        autoComplete="off"
        value={v[k]}
        onChange={(e) => setV({ ...v, [k]: e.target.value })}
        readOnly={busy}
      />
    </Field>
  );
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Correct details" busy={busy}>
      <form className="fact-form" onSubmit={submit} noValidate>
        {input('name', 'Name')}
        {input('email', 'Email', 'email')}
        {input('phone', 'Phone (+65)', 'tel')}
        {lead && (
          <>
            {input('need', 'Need')}
            {input('budget', 'Budget')}
            {input('preferredTime', 'Preferred time')}
          </>
        )}
        <p className="dsr-caption">Messages can't be edited; they're a record of what was said.</p>
        {(noChange || save.isError) && (
          <div className="alert alert--danger" role="alert">
            <p>{noChange ? 'Change at least one field first.' : dsrErrorText(save.error)}</p>
          </div>
        )}
        <div className="kaki-dialog__actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

// ---- Done ----------------------------------------------------------------------------------

export function DoneCard({ d, erased }: { d: DsrDetail; erased: DsrEraseResult | null }) {
  const outcome = d.closed?.outcome;
  const counts = erased?.counts ?? outcome?.counts ?? {};
  const seq = erased?.auditSeq ?? outcome?.auditSeq;
  const chain = erased?.chain ?? 'not_checked';
  return (
    <section className="card stack" aria-labelledby="dsr-done-title" data-testid="dsr-done">
      <h2 className="sr-only" id="dsr-done-title">
        Deletion done
      </h2>
      <div className="alert alert--success">
        <p>Data deleted on {d.closed ? dsrDay(d.closed.at) : dsrDay(d.createdAt)}.</p>
      </div>
      <dl className="kaki-meta-grid dsr-meta">
        <div className="kaki-meta-grid__item">
          <dt>Removed</dt>
          <dd data-testid="dsr-removed">{removedText(counts)}</dd>
        </div>
        <div className="kaki-meta-grid__item">
          <dt>Files in storage</dt>
          <dd data-testid="dsr-objects">
            {d.objects === 'pending' ? 'Removing…' : d.objects === 'done' ? 'Removed' : 'None held'}
          </dd>
        </div>
        <div className="kaki-meta-grid__item">
          <dt>Backups</dt>
          <dd>{d.backupsClearBy ? `Cleared by ${dsrDay(d.backupsClearBy)}` : 'Within 35 days'}</dd>
        </div>
        {seq !== undefined && (
          <div className="kaki-meta-grid__item">
            <dt>Audit reference</dt>
            <dd>
              <Link to="/settings/audit?group=contacts">Entry #{seq}</Link>
            </dd>
          </div>
        )}
        <div className="kaki-meta-grid__item">
          <dt>Audit chain</dt>
          <dd data-testid="dsr-chain">
            {chain === 'intact' && <span className="chip chip--success">Chain verified</span>}
            {chain === 'broken' && (
              <>
                <span className="chip chip--danger">Problem found</span>{' '}
                <Link to="/settings/audit">Open the Audit log</Link>
              </>
            )}
            {chain === 'not_checked' && (
              <span className="dsr-caption">
                Check it from the <Link to="/settings/audit">Audit log</Link>
              </span>
            )}
          </dd>
        </div>
      </dl>
      <p className="dsr-caption">Tell the requester the outcome.</p>
    </section>
  );
}

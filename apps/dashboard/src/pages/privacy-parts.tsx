import type { PrivacySettingsResponse } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import {
  formatDay,
  formatSaved,
  noticeBodyOf,
  noticeDraftOf,
  purposeBodyOf,
  purposeDraftOf,
  sameNotice,
  samePurpose,
  validateNotice,
  validatePurpose,
  type NoticeDraft,
  type PurposeDraft,
} from '../lib/privacy.ts';

/**
 * The parts of SCR-APP-047 Privacy and data and SCR-APP-009 (p) the setup step (GOV-14,
 * GOV-07, GOV-11; FEAT-058 ui-design "Shared parts").
 */

const QUERY_KEY = ['privacy-settings'];

/** Loading, error and permission states around the loaded settings; `generation` remounts the forms on Reload. */
export function PrivacyScreen({
  head,
  className,
  children,
}: {
  head: ReactNode;
  className: string;
  children: (data: PrivacySettingsResponse, reload: () => void, generation: number) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const loaded = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.privacySettings(),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
  const reload = () =>
    void queryClient
      .invalidateQueries({ queryKey: QUERY_KEY })
      .then(() => setGeneration((g) => g + 1));

  let body: ReactNode;
  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    body = (
      <EmptyState title="You can't change privacy settings">
        Only the Owner and Admins can change privacy settings.
      </EmptyState>
    );
  else if (loaded.isError)
    body = (
      <ErrorState
        title="We couldn't load your privacy settings."
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  else if (!loaded.data)
    body = (
      <div className="stack" aria-busy="true" aria-label="Loading privacy settings">
        {[0, 1, 2].map((k) => (
          <div className="card" key={k}>
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
        ))}
      </div>
    );
  else body = children(loaded.data, reload, generation);

  return (
    <div className={className}>
      {head}
      {body}
    </div>
  );
}

/** The warning above the cards while either part is missing (ONB-09). */
export function ReadinessAlert({ data }: { data: PrivacySettingsResponse }) {
  const { privacyNotice, purposeStatement } = data.readiness;
  if (privacyNotice && purposeStatement) return null;
  return (
    <div className="alert alert--warning">
      <p>You need a privacy notice and a saved purpose statement before you go live.</p>
      <ul>
        {!privacyNotice && (
          <li>
            <a href="#privacy-notice">Privacy notice</a>
          </li>
        )}
        {!purposeStatement && (
          <li>
            <a href="#privacy-purpose">Why you collect details</a>
          </li>
        )}
      </ul>
    </div>
  );
}

function SavedMarker({ wording }: { wording: { seq: number; savedAt: string } | null }) {
  return wording ? (
    <p className="privacy-saved">{formatSaved(wording)}</p>
  ) : (
    <span className="chip chip--warning privacy-saved">Not saved yet</span>
  );
}

/** One form's save: busy, field errors with the summary, conflict and failure alerts. */
function useSave(
  mutationFn: () => Promise<PrivacySettingsResponse>,
  onSaved: (res: PrivacySettingsResponse) => void,
) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn,
    onSuccess: (res) => {
      queryClient.setQueryData(QUERY_KEY, res);
      onSaved(res);
    },
  });
  const failure =
    save.error instanceof ApiError ? save.error.code : save.error ? 'unavailable' : null;
  return { save, failure, pending: save.isPending };
}

function SaveFailure({ failure, onReload }: { failure: string | null; onReload: () => void }) {
  if (!failure) return null;
  if (failure === 'version_conflict')
    return (
      <div className="alert alert--danger" role="alert">
        <p>Someone else changed this. Reload to see their version.</p>
        <Button variant="secondary" onClick={onReload}>
          Reload
        </Button>
      </div>
    );
  return (
    <div className="alert alert--danger" role="alert">
      <p>We couldn't save. Check your connection and try again.</p>
    </div>
  );
}

export function ErrorSummary({
  errors,
  prefix,
  focusKey,
}: {
  errors: Record<string, string | undefined>;
  prefix: string;
  focusKey: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusKey) ref.current?.focus();
  }, [focusKey]);
  const list = Object.entries(errors).filter((e): e is [string, string] => Boolean(e[1]));
  if (!list.length) return null;
  return (
    <div className="alert alert--danger" role="alert" tabIndex={-1} ref={ref}>
      <p className="alert__title">Check these fields</p>
      <ul>
        {list.map(([f, msg]) => (
          <li key={f}>
            <a
              href={`#${prefix}-${f}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`${prefix}-${f}`)?.focus();
              }}
            >
              {msg}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NoticeForm({
  data,
  onReload,
  onToast,
}: {
  data: PrivacySettingsResponse;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [initial, setInitial] = useState(() => noticeDraftOf(data));
  const [draft, setDraft] = useState<NoticeDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const errors = validateNotice(draft);
  const shown = submitted ? errors : {};
  const { save, failure, pending } = useSave(
    // The latest version from the cache: a purpose save in between bumps it.
    () => api.savePrivacyNotice(noticeBodyOf(draft, data.version)),
    (res) => {
      setInitial(noticeDraftOf(res));
      setSubmitted(false);
      onToast('Saved. Visitors now see this privacy notice.');
    },
  );
  const changed = !sameNotice(draft, initial);
  const { notice, defaults } = data;
  const set = <K extends keyof NoticeDraft>(key: K, value: NoticeDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setAttempts((n) => n + 1);
      return;
    }
    save.mutate();
  }

  const text = (
    key: 'contactName' | 'contactEmail' | 'contactPhone' | 'address',
    label: string,
    opts: { help?: string; type?: string; autoComplete?: string; maxLength: number },
  ) => {
    const id = `notice-${key}`;
    const error = shown[key as keyof typeof shown];
    return (
      <Field id={id} label={label} error={error} help={opts.help}>
        <input
          id={id}
          className="input"
          type={opts.type ?? 'text'}
          autoComplete={opts.autoComplete}
          maxLength={opts.maxLength}
          value={draft[key]}
          onChange={(e) => set(key, e.target.value)}
          readOnly={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, Boolean(opts.help))}
        />
      </Field>
    );
  };

  return (
    <section className="card stack" id="privacy-notice" aria-labelledby="privacy-notice-title">
      <h2 className="section-title" id="privacy-notice-title">
        Privacy notice
      </h2>
      <p className="privacy-lede">
        Visitors see a link to this in the chat menu and below the chat. You need one before you go
        live.
      </p>
      <ErrorSummary errors={shown} prefix="notice" focusKey={attempts} />
      <SaveFailure failure={failure} onReload={onReload} />
      <form className="stack" onSubmit={submit} noValidate aria-label="Privacy notice">
        <fieldset className="radio-group">
          <legend className="field__label">Where is your privacy notice?</legend>
          {(
            [
              ['link', 'On my website'],
              ['template', 'Use the KakiAgent template'],
            ] as const
          ).map(([value, label]) => (
            <label className="radio" key={value}>
              <input
                type="radio"
                name="notice-mode"
                checked={draft.mode === value}
                onChange={() => set('mode', value)}
                disabled={pending}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {draft.mode === 'link' ? (
          <Field
            id="notice-url"
            label="Link to your privacy notice (required)"
            error={shown.url}
            help="Use the page's full address, starting with https://"
          >
            <input
              id="notice-url"
              className="input"
              type="url"
              inputMode="url"
              maxLength={2048}
              placeholder="e.g. https://kakibakery.sg/privacy"
              value={draft.url}
              onChange={(e) => set('url', e.target.value)}
              readOnly={pending}
              aria-invalid={shown.url ? true : undefined}
              aria-describedby={describedBy('notice-url', shown.url, true)}
            />
          </Field>
        ) : (
          <>
            <p className="privacy-business">
              Business: {defaults.template.organisationName}
              {defaults.template.uen && ` · UEN ${defaults.template.uen}`}{' '}
              <Link to="/settings/business-profile">Edit in Business profile</Link>
            </p>
            {text('contactName', 'Contact person (required)', {
              help: 'Who visitors can ask about their data, often your data protection officer.',
              autoComplete: 'name',
              maxLength: 120,
            })}
            {text('contactEmail', 'Contact email (required)', {
              type: 'email',
              autoComplete: 'email',
              maxLength: 254,
            })}
            {text('contactPhone', 'Contact phone', {
              type: 'tel',
              autoComplete: 'tel',
              maxLength: 40,
            })}
            {text('address', 'Business address', {
              autoComplete: 'street-address',
              maxLength: 300,
            })}
            <Field
              id="notice-extra"
              label="Anything else to tell visitors"
              help="Plain text. Up to 2,000 characters."
            >
              <textarea
                id="notice-extra"
                className="input input--area"
                maxLength={2000}
                value={draft.extra}
                onChange={(e) => set('extra', e.target.value)}
                readOnly={pending}
                aria-describedby="notice-extra-help"
              />
            </Field>
            {notice.mode === 'template' && (
              <p className="privacy-preview-link">
                <a href={notice.publicUrl} target="_blank" rel="noreferrer noopener">
                  Preview your notice<span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="privacy-saved">Template version {notice.templateVersion}</span>
              </p>
            )}
          </>
        )}

        <div className="privacy-form__actions">
          <Button type="submit" disabled={!changed || pending} aria-busy={pending || undefined}>
            {pending ? 'Saving…' : 'Save privacy notice'}
          </Button>
          <SavedMarker wording={notice.mode === 'none' ? null : notice.wording} />
        </div>
      </form>
    </section>
  );
}

const CONSENT_QUESTION = 'Is it OK for us to use your details for this?';

export function PurposeForm({
  data,
  onReload,
  onToast,
}: {
  data: PrivacySettingsResponse;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [initial, setInitial] = useState(() => purposeDraftOf(data));
  const [draft, setDraft] = useState<PurposeDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const errors = validatePurpose(draft);
  const shown = submitted ? errors : {};
  const { save, failure, pending } = useSave(
    () => api.savePurposeStatement(purposeBodyOf(draft, data.version)),
    (res) => {
      setInitial(purposeDraftOf(res));
      setSubmitted(false);
      onToast('Saved. Visitors will see this before giving their details.');
    },
  );
  const { wording } = data.purpose;
  // The default counts as unsaved (D6), so it can be saved as it is.
  const canSave = !wording || !samePurpose(draft, initial);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setAttempts((n) => n + 1);
      return;
    }
    save.mutate();
  }

  const area = (key: 'en' | 'zh', label: string, help?: string) => {
    const id = `purpose-${key}`;
    return (
      <Field id={id} label={label} error={shown[key]} help={help}>
        <textarea
          id={id}
          className="input input--area"
          lang={key === 'zh' ? 'zh-Hans' : undefined}
          value={draft[key]}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          readOnly={pending}
          aria-invalid={shown[key] ? true : undefined}
          aria-describedby={describedBy(id, shown[key], Boolean(help))}
        />
      </Field>
    );
  };

  return (
    <section className="card stack" id="privacy-purpose" aria-labelledby="privacy-purpose-title">
      <h2 className="section-title" id="privacy-purpose-title">
        Why you collect details (PDPA purpose)
      </h2>
      <p className="privacy-lede">
        Before your assistant asks for a name, phone or email, visitors see this and are asked if
        it's OK.
      </p>
      <ErrorSummary errors={shown} prefix="purpose" focusKey={attempts} />
      <SaveFailure failure={failure} onReload={onReload} />
      <form className="stack" onSubmit={submit} noValidate aria-label="Purpose statement">
        {area('en', 'English (required)')}
        {area(
          'zh',
          '中文 (Chinese)',
          'Shown to visitors chatting in Chinese. Leave empty to show the English text.',
        )}
        <div className="consent-preview" role="group" aria-label="What visitors see">
          <p>{draft.en.trim() || ' '}</p>
          <p className="consent-preview__question">{CONSENT_QUESTION}</p>
          <div className="consent-preview__pills" aria-hidden="true">
            <span className="consent-preview__pill">Yes</span>
            <span className="consent-preview__pill">No thanks</span>
          </div>
          <p className="privacy-saved">The question is the same for every business.</p>
        </div>
        {!wording && (
          <div className="alert alert--info">
            <p>Review the text and save it. Your assistant can't ask for details until you do.</p>
          </div>
        )}
        <div className="privacy-form__actions">
          <Button type="submit" disabled={!canSave || pending} aria-busy={pending || undefined}>
            {pending ? 'Saving…' : 'Save purpose statement'}
          </Button>
          <SavedMarker wording={wording} />
        </div>
      </form>
    </section>
  );
}

const CHECK = (
  <svg className="privacy-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
  </svg>
);
const DOWNLOAD = (
  <svg className="kaki-btn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

/** Fetches the PDF so a failure can say so; the href still works for a new tab or no script. */
function DownloadLink({
  doc,
  children,
  onFail,
}: {
  doc: 'data-flow' | 'dpa';
  children: ReactNode;
  onFail: () => void;
}) {
  const href = api.documentUrl(doc);
  async function download(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    try {
      const res = await fetch(href, { credentials: 'include' });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        `kakiagent-${doc}.pdf`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      // Attached for Firefox, which ignores clicks on a detached link.
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      onFail();
    }
  }
  return (
    <Button variant="secondary" asChild>
      <a href={href} download onClick={(e) => void download(e)}>
        {DOWNLOAD}
        {children}
      </a>
    </Button>
  );
}

export function DocumentsSection({
  data,
  onToast,
}: {
  data: PrivacySettingsResponse;
  onToast: (message: string) => void;
}) {
  const { documents } = data;
  const fail = () => onToast("We couldn't download the PDF. Try again.");
  return (
    <section className="card stack" id="documents" aria-labelledby="privacy-documents-title">
      <h2 className="section-title" id="privacy-documents-title">
        Where your data goes
      </h2>
      <p className="privacy-lede">
        KakiAgent processes your visitors' data for you. These are the services we use and where
        data is processed. Updated {formatDay(documents.updatedOn)}.
      </p>
      <p className="privacy-statement">
        {CHECK}
        All your data is stored in Singapore.
      </p>

      <table className="privacy-table">
        <caption className="subsection-title">Services we use</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">What it does</th>
            <th scope="col">Where</th>
            <th scope="col">Stores your data</th>
          </tr>
        </thead>
        <tbody>
          {documents.subProcessors.map((s) => (
            <tr key={s.name}>
              <th scope="row" data-label="Service">
                {s.name}
                <span className="privacy-table__sub">{s.service}</span>
              </th>
              <td data-label="What it does">{s.purpose}</td>
              <td data-label="Where">{s.location}</td>
              <td data-label="Stores your data">{s.dataAtRest ? 'Yes' : 'No, processed only'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="privacy-table">
        <caption className="subsection-title">Data processed outside Singapore</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Goes to</th>
            <th scope="col">Why</th>
            <th scope="col">Protection</th>
            <th scope="col">Kept</th>
          </tr>
        </thead>
        <tbody>
          {documents.transfers.map((t) => (
            <tr key={`${t.data}-${t.to}`}>
              <th scope="row" data-label="Data">
                {t.data}
              </th>
              <td data-label="Goes to">{t.to}</td>
              <td data-label="Why">{t.purpose}</td>
              <td data-label="Protection">{t.safeguard}</td>
              <td data-label="Kept">{t.retention}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="privacy-downloads">
        <DownloadLink doc="data-flow" onFail={fail}>
          Download data-flow PDF
        </DownloadLink>
        <div className="privacy-downloads__dpa">
          <DownloadLink doc="dpa" onFail={fail}>
            Download DPA (version {documents.dpaVersion})
          </DownloadLink>
          <p className="privacy-saved">
            The full agreement text will be added after legal review. The schedules are final.
          </p>
        </div>
      </div>
    </section>
  );
}

export function TermsSection({ data }: { data: PrivacySettingsResponse }) {
  return (
    <section className="card stack" aria-labelledby="privacy-terms-title">
      <h2 className="section-title" id="privacy-terms-title">
        Terms you accepted
      </h2>
      <ul className="privacy-terms">
        {data.terms.map((t) => {
          const newer = t.acceptedVersion !== t.currentVersion;
          return (
            <li key={t.document}>
              <span>
                {t.title}
                {t.acceptedVersion && t.acceptedAt
                  ? ` · version ${t.acceptedVersion} · accepted ${formatDay(t.acceptedAt)}`
                  : ' · not accepted yet'}
              </span>
              {newer && (
                <>
                  <span className="chip chip--warning">New version {t.currentVersion}</span>
                  <p className="privacy-saved">
                    You'll be asked to accept it the next time you sign in.
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

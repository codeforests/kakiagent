import { LEAD_FIELD_KEYS, type LeadFieldMode, type LeadSettings } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import {
  FIELD_LABELS,
  MODE_LABELS,
  diffLeadSettings,
  KEYWORD_MAX,
  keywordError,
  leadBodyOf,
  leadDraftOf,
  leadServerErrors,
  useSaveLeadSettings,
  validateLeadDraft,
  wordingCaption,
  type LeadDraft,
} from '../lib/leads.ts';
import { ErrorSummary } from './privacy-parts.tsx';

/** The parts of SCR-APP-043 Leads and consent (FEAT-049 ui-design): one form, one Save. */

const MODES: LeadFieldMode[] = ['off', 'optional', 'required'];

export function LeadSettingsForm({
  data,
  business,
  onReload,
  onToast,
}: {
  data: LeadSettings;
  business: string;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [initial, setInitial] = useState(() => leadDraftOf(data, business));
  const [draft, setDraft] = useState<LeadDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [server, setServer] = useState<ReturnType<typeof leadServerErrors>>({});
  const save = useSaveLeadSettings();
  const pending = save.isPending;
  const errors = { ...(submitted ? validateLeadDraft(draft) : {}), ...server };
  const stale = save.error instanceof ApiError && save.error.code === 'stale';
  const failed =
    save.isError && !stale && !(save.error instanceof ApiError && save.error.status === 400);
  const dirty = diffLeadSettings(initial, draft).length > 0 || data.version === 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServer({});
    if (Object.keys(validateLeadDraft(draft)).length) {
      setAttempts((n) => n + 1);
      return;
    }
    save.mutate(leadBodyOf(draft, data.version), {
      onSuccess: (res) => {
        setInitial(leadDraftOf(res, business));
        setDraft(leadDraftOf(res, business));
        setSubmitted(false);
        onToast(
          res.rescored > 0
            ? `Lead settings saved. ${res.rescored} open ${res.rescored === 1 ? 'lead' : 'leads'} rescored.`
            : 'Lead settings saved',
        );
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 400) {
          setServer(leadServerErrors(String(err.details.code ?? '')));
          setAttempts((n) => n + 1);
        }
      },
    });
  }

  const setMode = (key: (typeof LEAD_FIELD_KEYS)[number], mode: LeadFieldMode) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.key === key ? { ...f, mode } : f)) }));
  const setMarketing = (patch: Partial<LeadDraft['marketing']>) =>
    setDraft((d) => ({ ...d, marketing: { ...d.marketing, ...patch } }));
  // The Lead page links to `#qualification`; the card renders after the settings load.
  useEffect(() => {
    if (window.location.hash === '#qualification')
      document.getElementById('qualification')?.scrollIntoView();
  }, []);
  const setQualification = (patch: Partial<LeadDraft['qualification']>) =>
    setDraft((d) => ({ ...d, qualification: { ...d.qualification, ...patch } }));
  const saved = wordingCaption(data.marketing.wording);

  return (
    <form className="stack leads-form" onSubmit={submit} noValidate aria-label="Leads and consent">
      <ErrorSummary errors={errors} prefix="leads" focusKey={attempts} />
      {stale && (
        <div className="alert alert--warning" role="alert">
          <p>Someone else changed these settings. Your changes weren't saved.</p>
          <Button type="button" variant="secondary" onClick={onReload}>
            Load their version
          </Button>
        </div>
      )}
      <section className="card stack" aria-labelledby="leads-fields-title">
        <h2 className="section-title" id="leads-fields-title">
          Lead fields
        </h2>
        <p className="privacy-lede">
          What the assistant asks for when a visitor leaves their details.
        </p>
        <div className="leads-rows">
          {draft.fields.map((f) => {
            const id = `leads-${f.key}`;
            const error = f.key === 'email' ? errors.email : undefined;
            return (
              <fieldset
                className="leads-row"
                key={f.key}
                aria-describedby={error ? `${id}-error` : undefined}
              >
                <legend className="leads-row__label">{FIELD_LABELS[f.key]}</legend>
                <div className="segmented">
                  {MODES.map((mode, i) => (
                    <label className="segmented__option" key={mode}>
                      <input
                        type="radio"
                        name={id}
                        id={i === 0 ? id : undefined}
                        value={mode}
                        checked={f.mode === mode}
                        disabled={pending}
                        aria-invalid={error ? true : undefined}
                        onChange={() => setMode(f.key, mode)}
                      />
                      <span>{MODE_LABELS[mode]}</span>
                    </label>
                  ))}
                </div>
                {error && (
                  <p className="field__error leads-row__error" id={`${id}-error`}>
                    <span aria-hidden="true">!</span> {error}
                  </p>
                )}
              </fieldset>
            );
          })}
        </div>
      </section>

      <section
        className="card stack"
        id="qualification"
        aria-labelledby="leads-qualification-title"
      >
        <h2 className="section-title" id="leads-qualification-title">
          Qualification
        </h2>
        <p className="privacy-lede">
          Decides which leads are hot, warm or cold. Your assistant adds points for asking for a
          quote, leaving phone and email, and saying when.
        </p>
        <KeywordListEditor
          items={draft.qualification.keywords}
          disabled={pending}
          onChange={(keywords) => setQualification({ keywords })}
        />
        <Field
          id="leads-minBudget"
          label="Minimum budget"
          error={errors.minBudget}
          help="Leads whose budget meets this get extra points. Leave empty to ignore budget."
        >
          <div className="input-adorned">
            <span className="input-adorned__prefix" aria-hidden="true">
              S$
            </span>
            <input
              id="leads-minBudget"
              className="input leads-budget"
              inputMode="numeric"
              value={draft.qualification.minBudget}
              readOnly={pending}
              aria-invalid={errors.minBudget ? true : undefined}
              aria-describedby={describedBy('leads-minBudget', errors.minBudget, true)}
              onChange={(e) => setQualification({ minBudget: e.target.value })}
            />
          </div>
        </Field>
      </section>

      <section className="card stack" aria-labelledby="leads-consent-title">
        <h2 className="section-title" id="leads-consent-title">
          Consent
        </h2>
        <div className="stack leads-purpose">
          <h3 className="leads-subtitle">Purpose statement</h3>
          {!data.purpose.saved && <span className="chip chip--info">Not saved yet</span>}
          <p className="leads-quote">{data.purpose.text.en}</p>
          <Link to="/settings/privacy#privacy-purpose">Edit on Privacy and data</Link>
        </div>
        <div className="stack">
          <h3 className="leads-subtitle" id="leads-marketing-label">
            Marketing opt-in
          </h3>
          <div className="fact-form__status">
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={draft.marketing.enabled}
              aria-labelledby="leads-marketing-toggle"
              aria-describedby="leads-marketing-help"
              disabled={pending}
              onClick={() => setMarketing({ enabled: !draft.marketing.enabled })}
            >
              <span className="toggle__thumb" aria-hidden="true" />
            </button>
            <span id="leads-marketing-toggle">Ask visitors if they want offers and news</span>
          </div>
          <p className="field__help" id="leads-marketing-help">
            Shown as a separate, unticked checkbox. Visitors can leave their details without
            agreeing.
          </p>
          {draft.marketing.enabled && (
            <>
              <Field
                id="leads-marketingEn"
                label="Opt-in wording (English)"
                error={errors.marketingEn}
              >
                <textarea
                  id="leads-marketingEn"
                  className="input input--area"
                  value={draft.marketing.en}
                  maxLength={600}
                  readOnly={pending}
                  aria-invalid={errors.marketingEn ? true : undefined}
                  aria-describedby={describedBy('leads-marketingEn', errors.marketingEn, false)}
                  onChange={(e) => setMarketing({ en: e.target.value })}
                />
              </Field>
              <Field id="leads-marketingZh" label="Opt-in wording (Chinese, optional)">
                <textarea
                  id="leads-marketingZh"
                  className="input input--area"
                  lang="zh-Hans"
                  value={draft.marketing.zh}
                  maxLength={600}
                  readOnly={pending}
                  onChange={(e) => setMarketing({ zh: e.target.value })}
                />
              </Field>
              {saved && <p className="privacy-saved">{saved}</p>}
            </>
          )}
          <p className="field__help">
            The Do Not Call Registry applies to phone and SMS marketing.
          </p>
        </div>
      </section>

      {failed && (
        <div className="alert alert--danger" role="alert">
          <p>Couldn't save. Try again.</p>
        </div>
      )}
      <div className="action-bar">
        <Button type="submit" disabled={!dirty || pending} aria-busy={pending || undefined}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/**
 * "Keywords that make a lead hot": the list-with-Add pattern of Rules' topics
 * (`TopicListEditor`), with this card's limits and words (FEAT-050 ui-design SCR-APP-043).
 */
function KeywordListEditor({
  items,
  onChange,
  disabled,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  disabled: boolean;
}) {
  const id = 'leads-keywords';
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  function add(e: FormEvent | KeyboardEvent) {
    e.preventDefault();
    const err = keywordError(items, value);
    setError(err);
    if (err) return;
    const keyword = value.trim().replace(/\s+/g, ' ');
    onChange([...items, keyword]);
    setValue('');
    setAnnounce(`Added ${keyword}`);
  }

  function remove(index: number) {
    const keyword = items[index];
    onChange(items.filter((_, i) => i !== index));
    setAnnounce(`Removed ${keyword}`);
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
      const next = buttons?.[Math.min(index, buttons.length - 1)];
      (next ?? inputRef.current)?.focus();
    });
  }

  return (
    <div className="field rules-topics">
      <div className="rules-topics__head">
        <label className="field__label" htmlFor={id}>
          Keywords that make a lead hot
        </label>
        <span className="field__counter">
          {items.length} of {KEYWORD_MAX}
        </span>
      </div>
      <p className="field__help" id={`${id}-help`}>
        Matched in what the visitor says they need. For example: wedding, corporate, 婚礼.
      </p>
      <div className="rules-add">
        <input
          id={id}
          ref={inputRef}
          className="input"
          placeholder="Add a keyword"
          value={value}
          maxLength={60}
          readOnly={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(e);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, true)}
        />
        <Button type="button" variant="secondary" disabled={disabled} onClick={add}>
          Add
        </Button>
      </div>
      {error && (
        <p className="field__error" id={`${id}-error`}>
          <span aria-hidden="true">!</span> {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="field__help">None yet.</p>
      ) : (
        <ul className="origin-list" aria-label="Keywords that make a lead hot" ref={listRef}>
          {items.map((k, i) => (
            <li key={`${k}-${i}`} className="origin-row">
              <span className="origin-row__host">{k}</span>
              <button
                type="button"
                className="icon-button origin-row__remove"
                aria-label={`Remove ${k}`}
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

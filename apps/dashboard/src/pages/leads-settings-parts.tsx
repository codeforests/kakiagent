import { LEAD_FIELD_KEYS, type LeadFieldMode, type LeadSettings } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import {
  FIELD_LABELS,
  MODE_LABELS,
  diffLeadSettings,
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
        onToast('Lead settings saved');
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

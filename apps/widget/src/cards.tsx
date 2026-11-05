/**
 * Consent and details in the panel (SCR-WGT-003, SCR-WGT-005; FEAT-049 §5.6): the consent
 * card, the lead form card and the fallback contact form. State lives in each card; the
 * answers go to the api, which records consent and the lead (LED-01, LED-02, LED-08).
 */
import type { LeadCaptureConfig, Message, MessageCard } from '@kaki/contracts';

/** The consent and lead-form cards; the quote card (FEAT-055) renders on its own. */
export type LeadMessageCard = Exclude<MessageCard, { kind: 'quote' }>;
import type { LeadFieldKey } from '@kaki/contracts/lead-check';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { createApi } from './api.js';
import {
  fieldErrorText,
  langOf,
  leadFormView,
  leadValues,
  localText,
  sentSummary,
  timeLabel,
  validateLead,
  type LeadErrors,
} from './chat.js';
import type { Locale, Strings } from './strings.js';

type Api = ReturnType<typeof createApi>;

const EXTERNAL_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

const icon = (d: string, cls?: string) => (
  <svg
    class={cls}
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d={d} />
  </svg>
);
const ERROR_ICON = icon('M12 7v6M12 16.5h.01');
const TICK_ICON = icon('m8 12 3 3 5-6', 'tick');
const INFO_ICON = icon('M12 11v5M12 8h.01');
const SPINNER = <span class="spin" aria-hidden="true" />;

/** A link to the tenant's privacy notice, in a new tab (FEAT-033 AC-5). */
export function PrivacyLink({ url, t, class: cls }: { url: string; t: Strings; class?: string }) {
  return (
    <a
      class={cls}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      role={cls ? 'menuitem' : undefined}
      tabIndex={cls ? -1 : undefined}
    >
      {t.privacyNotice}
      <span class="sr-only"> {t.opensInNewTab}</span>
      {cls && EXTERNAL_ICON}
    </a>
  );
}

interface Common {
  lead: LeadCaptureConfig;
  /** A 409 `wording_changed` brought the current config (null: no longer capturing). */
  onLeadCapture(next: LeadCaptureConfig | null): void;
  /** Null in the dashboard's preview: nothing is sent. */
  api: Api | null;
  locale: Locale;
  t: Strings;
  business: string;
  privacyUrl: string | null;
}

/** The lead form's values and errors; focus goes to the error summary when it is shown. */
function useLeadForm(lead: LeadCaptureConfig, prefill: LeadMessageCard['prefill']) {
  const [values, setValues] = useState(() => leadValues(lead.fields, prefill));
  const [errors, setErrors] = useState<LeadErrors>({});
  const [needsContact, setNeedsContact] = useState(false);
  const [shown, setShown] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) summaryRef.current?.focus();
  }, [shown]);
  return {
    values,
    errors,
    needsContact,
    summaryRef,
    set: (key: LeadFieldKey, v: string) => setValues((x) => ({ ...x, [key]: v })),
    show(e: LeadErrors, contact: boolean) {
      setErrors(e);
      setNeedsContact(contact);
      setShown((n) => n + 1);
    },
    clear() {
      setErrors({});
      setNeedsContact(false);
    },
  };
}
type LeadForm = ReturnType<typeof useLeadForm>;

/** Focuses a control by id inside the panel's shadow root (error summary links). */
function focusById(from: EventTarget | null, id: string) {
  const root = (from as Node | null)?.getRootNode() as ShadowRoot | Document | undefined;
  (root?.getElementById(id) as HTMLElement | null)?.focus();
}

/** The fields, in the business's order, with the error summary above them (SCR-WGT-003 form). */
function LeadFields({
  form,
  lead,
  t,
  idp,
  readOnly,
  extra = [],
}: {
  form: LeadForm;
  lead: LeadCaptureConfig;
  t: Strings;
  idp: string;
  readOnly: boolean;
  extra?: { id: string; text: string }[];
}) {
  const view = leadFormView(lead.fields, t);
  // Neither phone nor email: one error, on the first of the two shown (D6).
  const contactKey = view.fields.find((f) => f.key === 'phone' || f.key === 'email')?.key;
  const errorOf = (key: LeadFieldKey) => {
    const code = form.errors[key];
    if (code) return fieldErrorText(key, code, t);
    return form.needsContact && key === contactKey ? t.errContact : null;
  };
  const listed = [
    ...view.fields.flatMap((f) => {
      const text = errorOf(f.key);
      return text ? [{ id: `${idp}-${f.key}`, text }] : [];
    }),
    ...extra,
  ];
  return (
    <>
      {listed.length > 0 && (
        <div class="lead-sum" role="alert" tabIndex={-1} ref={form.summaryRef}>
          <p>{t.checkFields(String(listed.length))}</p>
          <ul>
            {listed.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  class="lnk"
                  onClick={(ev) => focusById(ev.currentTarget, e.id)}
                >
                  {e.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.fields.map((f) => {
        const id = `${idp}-${f.key}`;
        const err = errorOf(f.key);
        const described = [f.help && `${id}-help`, err && `${id}-err`].filter(Boolean).join(' ');
        const props = {
          id,
          value: form.values[f.key] ?? '',
          readOnly,
          autocomplete: f.autocomplete,
          'aria-invalid': err ? ('true' as const) : undefined,
          'aria-describedby': described || undefined,
          onInput: (e: Event) => form.set(f.key, (e.currentTarget as HTMLInputElement).value),
        };
        return (
          <div class="fld" key={f.key}>
            {view.contactCaption && f.key === contactKey && <p class="cap">{t.contactCaption}</p>}
            <label for={id}>
              {f.label}
              {f.required && ` ${t.requiredMark}`}
            </label>
            {f.kind === 'textarea' ? (
              <textarea rows={3} maxLength={1000} {...props} />
            ) : (
              <input
                // Preact's typings narrow per input type; text, tel and email share a branch.
                type={f.kind as 'text'}
                inputMode={f.kind === 'tel' ? ('tel' as const) : undefined}
                {...props}
              />
            )}
            {f.help && (
              <p class="help" id={`${id}-help`}>
                {f.help}
              </p>
            )}
            {err && (
              <p class="ferr" id={`${id}-err`}>
                {ERROR_ICON}
                {err}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The purpose statement as saved and the privacy notice link. */
function Purpose({ lead, locale, t, privacyUrl }: Common) {
  const text = localText(lead.purpose.text, locale);
  return (
    <>
      <p class="purpose" lang={langOf(text)}>
        {text}
      </p>
      {privacyUrl && (
        <p>
          <PrivacyLink url={privacyUrl} t={t} />
        </p>
      )}
    </>
  );
}

/** The separate, unticked, optional marketing opt-in (LED-08, D3); nothing when not asked. */
function MarketingBox({
  lead,
  locale,
  t,
  id,
  checked,
  disabled,
  onChange,
}: Pick<Common, 'lead' | 'locale' | 't'> & {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange(v: boolean): void;
}) {
  if (!lead.marketing) return null;
  const text = localText(lead.marketing.text, locale);
  return (
    <>
      <div class="chk">
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
        />
        <label for={id} lang={langOf(text)}>
          {text}
        </label>
      </div>
      <p class="cap">{t.marketingCaption}</p>
    </>
  );
}

type Step = 'consent' | 'form' | 'declined' | 'sent' | 'cancelled';

/**
 * The consent card and, after Agree, the lead form card under the message that carries them
 * (SCR-WGT-003). Only the active card can be answered; an earlier unanswered one reads
 * "Not answered".
 */
export function LeadCard(
  p: Common & {
    m: Message & { card: LeadMessageCard };
    active: boolean;
    conversationId: string | null;
    onNotice(notice: Message): void;
    focusComposer(): void;
  },
) {
  const { lead, t, locale } = p;
  const card = p.m.card;
  const idp = `k-${p.m.id}`;
  const [step, setStep] = useState<Step>(card.kind === 'consent' ? 'consent' : 'form');
  const [consentId, setConsentId] = useState(card.kind === 'lead_form' ? card.consentId : null);
  const [agreed, setAgreed] = useState<{ at: Date; offers: boolean } | null>(null);
  const [busy, setBusy] = useState<'agree' | 'decline' | 'send' | null>(null);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState(false);
  const [offers, setOffers] = useState(false);
  const [sent, setSent] = useState('');
  const form = useLeadForm(lead, card.prefill);
  const formRef = useRef<HTMLFormElement>(null);
  const focusForm = useRef(false);
  useEffect(() => {
    if (step !== 'form' || !focusForm.current) return;
    focusForm.current = false;
    formRef.current?.querySelector<HTMLElement>('input,textarea')?.focus();
  }, [step]);

  async function answer(yes: boolean) {
    if (busy || !p.api || !p.conversationId) return;
    setBusy(yes ? 'agree' : 'decline');
    setFailed(false);
    try {
      const marketing =
        yes && lead.marketing ? { wordingId: lead.marketing.wordingId, agreed: offers } : undefined;
      const r = await p.api.consent(p.conversationId, {
        purposeWordingId: lead.purpose.wordingId,
        agreed: yes,
        ...(marketing && { marketing }),
      });
      if (!r.ok) {
        if (r.status === 409 && r.body.error === 'wording_changed') {
          p.onLeadCapture(r.body.leadCapture ?? null);
          setChanged(true);
        } else setFailed(true);
        return;
      }
      setChanged(false);
      if (yes) {
        setConsentId(r.data.consentId);
        setAgreed({ at: new Date(), offers: !!marketing?.agreed });
        focusForm.current = true;
        setStep('form');
      } else {
        setStep('declined');
        p.focusComposer();
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  async function send(e: Event) {
    e.preventDefault();
    if (busy || !p.api || !p.conversationId || !consentId) return;
    const v = validateLead(lead.fields, form.values);
    if (!v.ok) return form.show(v.errors, v.needsContact);
    form.clear();
    setBusy('send');
    setFailed(false);
    try {
      const r = await p.api.submitLead(p.conversationId, { consentId, fields: v.value });
      if (r.ok) {
        setSent(sentSummary(v.value));
        setStep('sent');
        p.onNotice(r.data.notice);
      } else if (r.status === 422) form.show(r.body.fields, r.body.needsContact);
      else if (r.body.error === 'consent_required' || r.body.error === 'wording_changed') {
        // Consent withdrawn or reworded elsewhere: ask again with a fresh consent card.
        if (r.body.leadCapture !== undefined) p.onLeadCapture(r.body.leadCapture);
        setConsentId(null);
        setAgreed(null);
        setStep('consent');
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  const agreedLine = agreed && (
    <p class="lead-line">
      {TICK_ICON}
      {t.agreedLine(timeLabel(agreed.at, locale))}
      {agreed.offers && ` · ${t.offersYes}`}
    </p>
  );
  const done = (...lines: preact.ComponentChildren[]) => (
    <li class="lead-done" data-card={card.kind}>
      {agreedLine}
      {lines}
    </li>
  );

  if (step === 'declined')
    return (
      <>
        {done(<p class="lead-line">{t.declinedLine}</p>)}
        <li class="notice">{t.declinedNotice}</li>
      </>
    );
  if (step === 'sent')
    return done(
      <p class="lead-line">
        {TICK_ICON}
        {t.sentLine}
        {sent && ` · ${sent}`}
      </p>,
    );
  if (step === 'cancelled') return done(<p class="lead-line">{t.cancelledLine}</p>);
  if (!p.active) return done(<p class="lead-line">{t.notAnswered}</p>);

  const title = `${idp}-title`;
  if (step === 'consent') {
    const prompt = localText(lead.prompt, locale);
    return (
      <li class="lead-item" data-card="consent">
        <div class="lead-card" role="group" aria-labelledby={title}>
          <span class="sr-only">{t.consentAsks(p.business)}</span>
          <h3 id={title} lang={langOf(prompt)}>
            {prompt}
          </h3>
          {changed && (
            <p class="lead-info">
              {INFO_ICON}
              {t.wordingChanged}
            </p>
          )}
          <Purpose {...p} />
          <MarketingBox
            {...p}
            id={`${idp}-offers`}
            checked={offers}
            disabled={!!busy}
            onChange={setOffers}
          />
          {failed && (
            <p class="lead-err" role="alert">
              {ERROR_ICON}
              {t.consentFailed}
            </p>
          )}
          <div class="row">
            <button
              type="button"
              class="btn sec"
              disabled={!!busy}
              aria-busy={busy === 'decline' || undefined}
              onClick={() => void answer(false)}
            >
              {busy === 'decline' && SPINNER}
              {t.notNow}
            </button>
            <button
              type="button"
              class="btn pri"
              disabled={!!busy}
              aria-busy={busy === 'agree' || undefined}
              onClick={() => void answer(true)}
            >
              {busy === 'agree' && SPINNER}
              {t.agree}
            </button>
          </div>
          <p class="cap">{t.withdrawCaption}</p>
        </div>
      </li>
    );
  }

  return (
    <>
      {agreed && done()}
      <li class="lead-item" data-card="lead_form">
        <div class="lead-card" role="group" aria-labelledby={title}>
          <form noValidate onSubmit={(e) => void send(e)} ref={formRef}>
            <h3 id={title}>{t.detailsTitle}</h3>
            <p class="cap">{t.detailsIntro(p.business)}</p>
            <LeadFields form={form} lead={lead} t={t} idp={idp} readOnly={busy === 'send'} />
            {failed && (
              <p class="lead-err" role="alert">
                {ERROR_ICON}
                {t.sendFailed}
              </p>
            )}
            <div class="row">
              <button
                type="button"
                class="btn ghost"
                disabled={!!busy}
                onClick={() => {
                  setStep('cancelled');
                  p.focusComposer();
                }}
              >
                {t.cancel}
              </button>
              <button type="submit" class="btn pri" aria-busy={busy === 'send' || undefined}>
                {busy === 'send' && SPINNER}
                {busy === 'send' ? t.sending : t.sendDetails}
              </button>
            </div>
          </form>
        </div>
      </li>
    </>
  );
}

/**
 * The fallback contact form (SCR-WGT-005), from the paused notice or the not-live card:
 * consent and details in one request (`POST /widget/v1/contact`).
 */
export function ContactForm(
  p: Common & { api: Api; conversationId: string | null; onBack(): void },
) {
  const { lead, t } = p;
  const idp = 'k-contact';
  const form = useLeadForm(lead, {});
  const [agree, setAgree] = useState(false);
  const [agreeErr, setAgreeErr] = useState(false);
  const [offers, setOffers] = useState(false);
  const [state, setState] = useState<'form' | 'sending' | 'sent' | 'failed'>('form');
  const [changed, setChanged] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('input,textarea')?.focus();
  }, []);
  useEffect(() => {
    if (state === 'sent') sentRef.current?.focus();
  }, [state]);

  async function send(e: Event) {
    e.preventDefault();
    if (state === 'sending') return;
    const v = validateLead(lead.fields, form.values);
    setAgreeErr(!agree);
    if (!v.ok || !agree) return form.show(v.errors, v.needsContact);
    form.clear();
    setState('sending');
    try {
      const r = await p.api.submitContact({
        ...(p.conversationId && { conversationId: p.conversationId }),
        purposeWordingId: lead.purpose.wordingId,
        agreed: true,
        ...(lead.marketing && {
          marketing: { wordingId: lead.marketing.wordingId, agreed: offers },
        }),
        fields: v.value,
      });
      if (r.ok) return setState('sent');
      setState(r.status === 422 || r.body.error === 'wording_changed' ? 'form' : 'failed');
      if (r.status === 422) form.show(r.body.fields, r.body.needsContact);
      else if (r.body.error === 'wording_changed') {
        p.onLeadCapture(r.body.leadCapture ?? null);
        setChanged(true);
        setAgree(false);
      }
    } catch {
      setState('failed');
    }
  }

  if (state === 'sent')
    return (
      <div class="lead-ok" role="alert" tabIndex={-1} ref={sentRef}>
        {TICK_ICON}
        {t.contactSent(p.business)}
      </div>
    );
  const sending = state === 'sending';
  return (
    <div class="lead-card" role="region" aria-label={t.leaveDetails}>
      <form noValidate onSubmit={(e) => void send(e)} ref={rootRef}>
        <p>{t.contactIntro(p.business)}</p>
        {changed && (
          <p class="lead-info">
            {INFO_ICON}
            {t.wordingChanged}
          </p>
        )}
        <LeadFields
          form={form}
          lead={lead}
          t={t}
          idp={idp}
          readOnly={sending}
          extra={agreeErr ? [{ id: `${idp}-agree`, text: t.errAgree }] : []}
        />
        <Purpose {...p} />
        <div class="chk">
          <input
            type="checkbox"
            id={`${idp}-agree`}
            checked={agree}
            disabled={sending}
            aria-invalid={agreeErr ? 'true' : undefined}
            aria-describedby={agreeErr ? `${idp}-agree-err` : undefined}
            onChange={(e) => {
              setAgree((e.currentTarget as HTMLInputElement).checked);
              setAgreeErr(false);
            }}
          />
          <label for={`${idp}-agree`}>
            {t.contactAgree(p.business)} {t.requiredMark}
          </label>
        </div>
        {agreeErr && (
          <p class="ferr" id={`${idp}-agree-err`}>
            {ERROR_ICON}
            {t.errAgree}
          </p>
        )}
        <MarketingBox
          {...p}
          id={`${idp}-offers`}
          checked={offers}
          disabled={sending}
          onChange={setOffers}
        />
        {state === 'failed' && (
          <p class="lead-err" role="alert">
            {ERROR_ICON}
            {t.sendFailed}
          </p>
        )}
        <div class="row">
          <button type="button" class="btn ghost" disabled={sending} onClick={p.onBack}>
            {t.back}
          </button>
          <button type="submit" class="btn pri" aria-busy={sending || undefined}>
            {sending && SPINNER}
            {sending ? t.sending : t.send}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Consent and details in the panel (SCR-WGT-003, SCR-WGT-005; FEAT-049 §5.6): the consent
 * card, the lead form card and the fallback contact form. State lives in each card; the
 * answers go to the api, which records consent and the lead (LED-01, LED-02, LED-08).
 */
import type { LeadCaptureConfig, Message, MessageCard } from '@kaki/contracts';

/** The consent and lead-form cards; the quote card (FEAT-055) renders on its own. */
export type LeadMessageCard = Extract<MessageCard, { kind: 'consent' | 'lead_form' }>;
import { isEmail, type LeadFieldKey } from '@kaki/contracts/lead-check';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { createApi } from './api.js';
import {
  boldParts,
  fieldErrorText,
  handoffErrorText,
  handoffOptions,
  langOf,
  leadFormView,
  leadValues,
  localText,
  quoteView,
  sentSummary,
  timeLabel,
  validateLead,
  withdrawChoices,
  withdrawLine,
  withdrawStateOf,
  type HandoffChannel,
  type HandoffFailure,
  type LeadErrors,
  type WithdrawChoice,
  type WithdrawState,
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

/**
 * The withdraw confirm card (SCR-WGT-003 withdrawn; FEAT-051 §5.6, AC-10): "Yes, stop",
 * "Just stop offers" (only when offers were agreed) and "Keep my details". The api records the
 * withdrawal; "Keep" sends nothing. Styled like the consent card.
 */
export function WithdrawCard(p: {
  m: Message & { card: Extract<MessageCard, { kind: 'withdraw' }> };
  active: boolean;
  api: Api | null;
  conversationId: string | null;
  t: Strings;
  locale: Locale;
  business: string;
  onNotice(notice: Message): void;
  focusComposer(): void;
}) {
  const { t, business } = p;
  const [state, setState] = useState<WithdrawState>('asked');
  const [at, setAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState<WithdrawChoice | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(c: WithdrawChoice) {
    if (busy) return;
    if (c === 'keep') {
      setState('kept');
      p.focusComposer();
      return;
    }
    if (!p.api || !p.conversationId) return;
    setBusy(c);
    setFailed(false);
    try {
      const r = await p.api.withdraw(p.conversationId, { messageId: p.m.id, scope: c });
      setAt(new Date());
      setState(withdrawStateOf(c, r.status));
      if (r.notice) p.onNotice(r.notice);
      else p.focusComposer();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  const line = withdrawLine(state, t, business, timeLabel(at ?? new Date(), p.locale));
  if (line !== null)
    return (
      <li class="lead-done" data-card="withdraw" data-state={state}>
        <p class="lead-line">
          {(state === 'all' || state === 'marketing') && TICK_ICON}
          {line}
        </p>
      </li>
    );
  if (!p.active)
    return (
      <li class="lead-done" data-card="withdraw">
        <p class="lead-line">{t.notAnswered}</p>
      </li>
    );

  const title = `k-${p.m.id}-title`;
  const label: Record<WithdrawChoice, string> = {
    all: t.withdrawYes,
    marketing: t.withdrawOffersOnly,
    keep: t.withdrawKeep,
  };
  const cls: Record<WithdrawChoice, string> = { all: 'pri', marketing: 'sec', keep: 'ghost' };
  return (
    <li class="lead-item" data-card="withdraw">
      <div class="lead-card" role="group" aria-labelledby={title}>
        <span class="sr-only">{t.withdrawAsks(business)}</span>
        <h3 id={title}>{t.withdrawTitle}</h3>
        <p class="cap">{t.withdrawBody(business)}</p>
        {p.m.card.offers && <p class="cap">{t.withdrawOffersCaption(business)}</p>}
        {failed && (
          <p class="lead-err" role="alert">
            {ERROR_ICON}
            {t.consentFailed}
          </p>
        )}
        <div class="row">
          {withdrawChoices(p.m.card.offers)
            .slice()
            .reverse()
            .map((c) => (
              <button
                key={c}
                type="button"
                class={`btn ${cls[c]}`}
                data-choice={c}
                disabled={!!busy}
                aria-busy={busy === c || undefined}
                onClick={() => void choose(c)}
              >
                {busy === c && SPINNER}
                {label[c]}
              </button>
            ))}
        </div>
      </div>
    </li>
  );
}

/**
 * The approved quote (SCR-WGT-002; FEAT-055 §5.6): read-only, in place of the message's text
 * bubble; its labels follow the message's language. A nested `ul` of lines only (axe list
 * rule: no `li role` inside the log).
 */
export function QuoteCard({
  m,
  t,
}: {
  m: Message & { card: Extract<MessageCard, { kind: 'quote' }> };
  t: Strings;
}) {
  const v = quoteView(m.card, t);
  return (
    <li class="quote-item" data-card="quote" lang={langOf(m.body)}>
      <div class="quote-card" role="group" aria-label={t.quoteTitle}>
        <h3>{t.quoteTitle}</h3>
        {v.lines.length > 0 && (
          <ul class="quote-lines">
            {v.lines.map((l) => (
              <li key={l.key}>
                <span class="ql">{l.label}</span>
                <span class="qa">{l.amount}</span>
                <span class="qe">{l.each}</span>
              </li>
            ))}
          </ul>
        )}
        {v.discount && (
          <p class="quote-row">
            <span class="ql">{v.discount.label}</span>
            <span class="qa">{v.discount.amount}</span>
          </p>
        )}
        <p class="quote-row quote-total">
          <span class="ql">{t.quoteTotal}</span>
          <span class="qa">{v.total}</span>
        </p>
        {v.gst && <p class="cap">{v.gst}</p>}
        {v.note && <p class="quote-note">{v.note}</p>}
      </div>
    </li>
  );
}

const TELEGRAM_ICON = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M21.5 4.1 2.9 11.3c-1 .4-1 1.6 0 1.9l4.6 1.5 1.8 5.6c.2.7 1.1.9 1.6.4l2.6-2.4 4.8 3.5c.6.4 1.4.1 1.6-.6L22.9 5.4c.2-.9-.6-1.6-1.4-1.3Zm-3.3 3.6-8.4 7.6-.3 3.3-1.4-4.4 9.6-6.8c.4-.3.8.1.5.3Z" />
  </svg>
);
const MAIL_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);

/** `a **b** c` with the marked word in bold. */
function Bold({ text, vars }: { text: string; vars?: Record<string, string> }) {
  return (
    <>
      {boldParts(text, vars).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.text))}
    </>
  );
}

type HandoffView =
  | { s: 'options' }
  | { s: 'telegram'; url: string; expiresAt: number }
  | { s: 'expired' }
  | { s: 'email' }
  | { s: 'sent'; sentTo: string }
  | { s: 'stayed' };

/**
 * Continue elsewhere (SCR-WGT-004; FEAT-038 §5.8): one card for the agent's stored `handoff`
 * card and the menu's local one. The redeem itself arrives as the moved notice (panel).
 */
export function HandoffCard(p: {
  id: string;
  flags: { telegram: boolean; email: boolean };
  active: boolean;
  local: boolean;
  /** Bumped by the menu when the local card is already open: focus moves back to it. */
  focusRequest: number;
  api: Api | null;
  conversationId: string | null;
  t: Strings;
  bot: string;
  privacyUrl: string | null;
  onMoved(channel: HandoffChannel): void;
  focusComposer(): void;
}) {
  const { t } = p;
  const [view, setView] = useState<HandoffView>({ s: 'options' });
  const [busy, setBusy] = useState<HandoffChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState(false);
  const [removed, setRemoved] = useState<HandoffChannel[]>([]);
  const [email, setEmail] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(p.local ? 'first' : null);
  const idp = `k-${p.id}`;

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (!target || !rootRef.current) return;
    const el =
      target === 'first'
        ? rootRef.current.querySelector<HTMLElement>('button, a')
        : rootRef.current.querySelector<HTMLElement>(`[data-focus="${target}"]`);
    el?.focus();
  });
  // The menu again while this card is open: back to its first control (a stayed card reopens).
  useEffect(() => {
    if (p.focusRequest === 0) return;
    if (view.s === 'stayed') {
      focusNext.current = 'first';
      setView({ s: 'options' });
    } else rootRef.current?.querySelector<HTMLElement>('button, a')?.focus();
  }, [p.focusRequest]);
  // The Telegram link's local expiry (ui-design: "This link has expired.").
  useEffect(() => {
    if (view.s !== 'telegram') return;
    const timer = setTimeout(
      () => setView({ s: 'expired' }),
      Math.max(0, view.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view]);

  function fail(code: HandoffFailure, channel: HandoffChannel) {
    if (code === 'invalid_email') {
      setFieldError(true);
      focusNext.current = 'email';
      return;
    }
    if (code === 'channel_unavailable') {
      setRemoved((r) => [...r, channel]);
      setView({ s: 'options' });
    }
    setError(handoffErrorText(code, channel, t));
  }

  async function request(channel: HandoffChannel) {
    if (busy || !p.api || !p.conversationId) return;
    if (channel === 'email' && !isEmail(email)) {
      setFieldError(true);
      focusNext.current = 'email';
      setError(null);
      return;
    }
    setBusy(channel);
    setError(null);
    setFieldError(false);
    const r = await p.api.handoff(
      p.conversationId,
      channel === 'email' ? { channel, email: email.trim() } : { channel },
    );
    setBusy(null);
    if (!r.ok) {
      if (r.error === 'moved') return p.onMoved(r.channel ?? channel);
      return fail(r.error, channel);
    }
    if (r.data.channel === 'telegram') {
      setView({ s: 'telegram', url: r.data.url, expiresAt: Date.parse(r.data.expiresAt) });
      focusNext.current = 'open';
    } else {
      setView({ s: 'sent', sentTo: r.data.sentTo });
      focusNext.current = 'sent';
    }
  }

  function choose(channel: HandoffChannel) {
    if (channel === 'telegram') return void request('telegram');
    setError(null);
    setView({ s: 'email' });
    focusNext.current = 'email';
  }

  function back() {
    setError(null);
    setFieldError(false);
    setView({ s: 'options' });
    focusNext.current = 'first';
  }

  if (view.s === 'stayed')
    return (
      <li class="lead-done" data-card="handoff" data-state="stayed">
        <p class="lead-line">{t.handoffStayed}</p>
      </li>
    );
  if (!p.active) {
    if (view.s === 'sent')
      return (
        <li class="lead-done" data-card="handoff" data-state="sent">
          <p class="lead-line">
            <Bold text={t.handoffSent} vars={{ to: view.sentTo }} />
          </p>
        </li>
      );
    return p.local ? null : (
      <li class="lead-done" data-card="handoff">
        <p class="lead-line">{t.notAnswered}</p>
      </li>
    );
  }

  const title = `${idp}-title`;
  const options = handoffOptions(p.flags, removed);
  const alert = error && (
    <p class="lead-err" role="alert">
      {ERROR_ICON}
      {error}
    </p>
  );
  let body;
  if (view.s === 'telegram')
    body = (
      <>
        <p>
          <Bold text={t.handoffTelegramReady} />
        </p>
        <div class="opts">
          <a class="btn pri" href={view.url} target="_blank" rel="noopener" data-focus="open">
            {TELEGRAM_ICON}
            {t.openTelegram}
            <span class="sr-only"> {t.opensTelegram}</span>
          </a>
          <button type="button" class="btn ghost" onClick={back}>
            {t.handoffBack}
          </button>
        </div>
      </>
    );
  else if (view.s === 'expired')
    body = (
      <>
        <p data-focus="expired" tabIndex={-1}>
          {t.handoffExpired}
        </p>
        {alert}
        <div class="opts">
          <button
            type="button"
            class="btn sec"
            disabled={!!busy}
            aria-busy={busy === 'telegram' || undefined}
            onClick={() => void request('telegram')}
          >
            {busy === 'telegram' && SPINNER}
            {t.handoffNewLink}
          </button>
          <button type="button" class="btn ghost" onClick={back}>
            {t.handoffBack}
          </button>
        </div>
      </>
    );
  else if (view.s === 'email') {
    const id = `${idp}-email`;
    body = (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void request('email');
        }}
      >
        <div class="fld">
          <label for={id}>{t.handoffEmailLabel}</label>
          <input
            id={id}
            type="email"
            inputMode="email"
            autocomplete="email"
            maxLength={254}
            value={email}
            readOnly={busy === 'email'}
            data-focus="email"
            aria-invalid={fieldError ? 'true' : undefined}
            aria-describedby={`${id}-help${fieldError ? ` ${id}-err` : ''}`}
            onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
          />
          <p class="help" id={`${id}-help`}>
            {t.handoffEmailHelp}
            {p.privacyUrl && (
              <>
                {' '}
                <PrivacyLink url={p.privacyUrl} t={t} />
              </>
            )}
          </p>
          {fieldError && (
            <p class="ferr" id={`${id}-err`}>
              {ERROR_ICON}
              {t.errEmail}
            </p>
          )}
        </div>
        {alert}
        <div class="row">
          <button type="button" class="btn ghost" onClick={back} disabled={busy === 'email'}>
            {t.handoffBack}
          </button>
          <button
            type="submit"
            class="btn pri"
            disabled={busy === 'email'}
            aria-busy={busy === 'email' || undefined}
          >
            {busy === 'email' && SPINNER}
            {busy === 'email' ? t.handoffSending : t.handoffSend}
          </button>
        </div>
      </form>
    );
  } else if (view.s === 'sent')
    body = (
      <>
        <p class="lead-line" data-focus="sent" tabIndex={-1}>
          {TICK_ICON}
          <span>
            <Bold text={t.handoffSent} vars={{ to: view.sentTo }} />
          </span>
        </p>
        {alert}
        <div class="opts">
          <button
            type="button"
            class="btn ghost"
            disabled={!!busy}
            aria-busy={busy === 'email' || undefined}
            onClick={() => void request('email')}
          >
            {busy === 'email' && SPINNER}
            {t.handoffSendAgain}
          </button>
          <button
            type="button"
            class="btn ghost"
            disabled={!!busy}
            onClick={() => {
              setEmail('');
              setError(null);
              setView({ s: 'email' });
              focusNext.current = 'email';
            }}
          >
            {t.handoffOtherEmail}
          </button>
        </div>
      </>
    );
  else
    body = (
      <>
        <p class="cap">{t.handoffBody}</p>
        {alert}
        <div class="opts">
          {options.map((c) => (
            <button
              key={c}
              type="button"
              class="btn sec"
              data-channel={c}
              disabled={!!busy}
              aria-busy={busy === c || undefined}
              onClick={() => choose(c)}
            >
              {busy === c ? SPINNER : c === 'telegram' ? TELEGRAM_ICON : MAIL_ICON}
              {c === 'telegram' ? t.handoffTelegram : t.handoffEmail}
            </button>
          ))}
          <button
            type="button"
            class="btn ghost"
            onClick={() => {
              setView({ s: 'stayed' });
              p.focusComposer();
            }}
          >
            {t.handoffStay}
          </button>
        </div>
      </>
    );
  return (
    <li class="lead-item" data-card="handoff" data-state={view.s}>
      <div class="lead-card hand" role="group" aria-labelledby={title} ref={rootRef}>
        {!p.local && <span class="sr-only">{t.handoffOffers(p.bot)}</span>}
        <h3 id={title}>{t.handoffTitle}</h3>
        {body}
      </div>
    </li>
  );
}

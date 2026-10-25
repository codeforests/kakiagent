import {
  BusinessProfileBody,
  exceptionIssues,
  formatSgPhone,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type BusinessProfile,
  type BusinessProfileInput,
  type BusinessProfileResponse,
  type Industry,
  type ProfileLanguage,
  type PublicHoliday,
  type Weekday,
} from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy, useToast } from '../lib/form.ts';
import { INDUSTRY_LABEL, INDUSTRY_OPTIONS } from '../lib/industry.ts';

/**
 * SCR-APP-044 Business profile and SCR-APP-006 (p) the setup step (ONB-03, ONB-06;
 * FEAT-009 ui-design). One form in two modes; FEAT-035 adds the wizard frame.
 */

type Mode = 'settings' | 'setup';

const LANGUAGE_OPTIONS: { value: ProfileLanguage; label: string; lang: string }[] = [
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'zh', label: '中文', lang: 'zh-Hans' },
  { value: 'ms', label: 'Bahasa Melayu', lang: 'ms' },
  { value: 'ta', label: 'தமிழ்', lang: 'ta' },
];

/** A time range as the inputs hold it: a close of 00:00 means midnight (24:00). */
interface Range {
  open: string;
  close: string;
}
interface Closure {
  key: number;
  day: string;
  label: string;
}

interface Draft {
  name: string;
  uen: string;
  industry: Industry | '';
  contactEmail: string;
  contactPhone: string;
  languages: ProfileLanguage[];
  gstRegistered: boolean;
  hoursSet: boolean;
  hours: Record<Weekday, Range[]>;
  openOnPublicHolidays: boolean;
  /** Per listed public holiday: open that day. */
  holidayOpen: Record<string, boolean>;
  closures: Closure[];
}

/** Hours offered when the owner first turns hours on. */
const STARTER: Record<Weekday, Range[]> = Object.fromEntries(
  WEEKDAYS.map((d) => [d, d === 'sun' ? [] : [{ open: '09:00', close: '18:00' }]]),
) as Record<Weekday, Range[]>;

let nextKey = 1;

/** Today in Singapore, `YYYY-MM-DD`. */
const sgToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

function fromProfile(p: BusinessProfile, holidays: PublicHoliday[]): Draft {
  const listed = new Set(holidays.map((h) => h.day));
  const holidayOpen: Record<string, boolean> = {};
  for (const h of holidays) holidayOpen[h.day] = p.openOnPublicHolidays;
  const closures: Closure[] = [];
  for (const e of p.exceptions) {
    if (listed.has(e.day)) holidayOpen[e.day] = e.kind === 'open';
    else closures.push({ key: nextKey++, day: e.day, label: e.label ?? '' });
  }
  return {
    name: p.name,
    uen: p.uen ?? '',
    industry: p.industry ?? '',
    contactEmail: p.contactEmail ?? '',
    contactPhone: p.contactPhone ? formatSgPhone(p.contactPhone) : '',
    languages: p.languages,
    gstRegistered: p.gstRegistered,
    hoursSet: p.hours !== null,
    hours: p.hours
      ? (Object.fromEntries(
          WEEKDAYS.map((d) => [
            d,
            p.hours![d].map((r) => ({
              open: r.open,
              close: r.close === '24:00' ? '00:00' : r.close,
            })),
          ]),
        ) as Record<Weekday, Range[]>)
      : STARTER,
    openOnPublicHolidays: p.openOnPublicHolidays,
    holidayOpen,
    closures,
  };
}

/** Where each `exceptions` entry came from, so an issue can name its field. */
type Source = { holiday: string } | { closure: number };

function bodyOf(d: Draft, version: number, holidays: PublicHoliday[]) {
  const sources: Source[] = [];
  const exceptions: BusinessProfileInput['exceptions'] = [];
  for (const h of holidays) {
    const open = d.holidayOpen[h.day] ?? d.openOnPublicHolidays;
    if (open === d.openOnPublicHolidays) continue;
    exceptions.push({ day: h.day, kind: open ? 'open' : 'closed', label: null });
    sources.push({ holiday: h.day });
  }
  for (const c of d.closures) {
    exceptions.push({ day: c.day, kind: 'closed', label: c.label });
    sources.push({ closure: c.key });
  }
  const body: BusinessProfileInput = {
    version,
    name: d.name,
    uen: d.uen,
    industry: d.industry || null,
    contactEmail: d.contactEmail,
    contactPhone: d.contactPhone,
    languages: d.languages,
    gstRegistered: d.gstRegistered,
    hours: d.hoursSet
      ? (Object.fromEntries(
          WEEKDAYS.map((w) => [
            w,
            d.hours[w].map((r) => ({
              open: r.open,
              close: r.close === '00:00' ? '24:00' : r.close,
            })),
          ]),
        ) as BusinessProfileInput['hours'])
      : null,
    openOnPublicHolidays: d.openOnPublicHolidays,
    exceptions,
  };
  return { body, sources };
}

/** Field ids are `profile-<key>`; the error summary links to them. */
type Errors = Record<string, string>;

function validate(d: Draft, holidays: PublicHoliday[]): Errors {
  const { body, sources } = bodyOf(d, 1, holidays);
  const errors: Errors = {};
  const at = (path: PropertyKey[]): string => {
    const [key, a, b] = path;
    if (key === 'hours' && typeof a === 'string')
      return `hours-${a}-${typeof b === 'number' ? b : 0}-open`;
    if (key === 'exceptions') {
      const src = typeof a === 'number' ? sources[a] : undefined;
      if (src && 'closure' in src)
        return `closure-${src.closure}-${b === 'label' ? 'label' : 'day'}`;
      if (src) return `holiday-${src.holiday}`;
      const first = d.closures[0];
      return first ? `closure-${first.key}-day` : 'closures';
    }
    return String(key);
  };
  const parsed = BusinessProfileBody.safeParse(body);
  if (!parsed.success) for (const i of parsed.error.issues) errors[at(i.path)] ??= i.message;
  const holidayDays = new Set(holidays.map((h) => h.day));
  for (const i of exceptionIssues(body, {
    isHoliday: (day) => holidayDays.has(day),
    today: sgToday(),
  }))
    errors[at(i.path)] ??= i.message;
  return errors;
}

/** `Fri 25 Dec 2026` (design.md §6 dates). */
function dayLabel(day: string) {
  return new Date(`${day}T12:00:00+08:00`).toLocaleDateString('en-SG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Singapore',
  });
}

export function BusinessProfilePage() {
  return <ProfileScreen mode="settings" />;
}

export function SetupProfilePage() {
  return <ProfileScreen mode="setup" />;
}

function ProfileScreen({ mode }: { mode: Mode }) {
  // Held here, not in the form: a save bumps the version, which remounts the form.
  const [toast, setToast] = useToast();
  const loaded = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.businessProfile(),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });

  const head =
    mode === 'settings' ? (
      <>
        <Link className="back-link" to="/settings">
          Settings
        </Link>
        <h1 className="page-title">Business profile</h1>
        <p className="page-lede">
          Your details and opening hours. Your assistant uses your hours to tell visitors when
          you're open.
        </p>
      </>
    ) : (
      <>
        <h1 className="page-title">Tell us about your business</h1>
        <p className="page-lede">
          This is the first step of setting up your assistant. You can change any of it later in
          Settings.
        </p>
      </>
    );

  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    return (
      <div className="profile-page">
        {head}
        <EmptyState title="You can't change the business profile">
          Only the Owner or an Admin can change the business profile.
        </EmptyState>
      </div>
    );
  if (loaded.isError)
    return (
      <div className="profile-page">
        {head}
        <ErrorState
          title="We couldn't load your business profile"
          action={
            <Button variant="secondary" onClick={() => void loaded.refetch()}>
              Try again
            </Button>
          }
        >
          Nothing you saved is lost.
        </ErrorState>
      </div>
    );
  if (!loaded.data)
    return (
      <div className="profile-page">
        {head}
        <div className="stack" aria-busy="true" aria-label="Loading business profile">
          {[0, 1, 2].map((k) => (
            <div className="card" key={k}>
              <div className="skeleton-field" />
              <div className="skeleton-field" />
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="profile-page">
      {head}
      <ProfileForm
        key={loaded.data.profile.version}
        mode={mode}
        data={loaded.data}
        onSaved={setToast}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ProfileForm({
  mode,
  data,
  onSaved,
}: {
  mode: Mode;
  data: BusinessProfileResponse;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { profile, calendar, template } = data;
  const [initial] = useState(() => fromProfile(profile, calendar.holidays));
  const [draft, setDraft] = useState<Draft>(initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const errors = validate(draft, calendar.holidays);
  const shown = (f: string) => (submitted || touched[f] ? errors[f] : undefined);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () =>
      api.saveBusinessProfile(
        BusinessProfileBody.parse(bodyOf(draft, profile.version, calendar.holidays).body),
      ),
    onSuccess: (res) => {
      queryClient.setQueryData(['business-profile'], res);
      if (mode === 'setup')
        void navigate('/knowledge', {
          state: { toast: 'Business profile saved. Next, add what your assistant should know.' },
        });
      else onSaved('Business profile saved. Your assistant uses it from the next reply.');
    },
  });
  const failure =
    save.error instanceof ApiError ? save.error.code : save.error ? 'unavailable' : null;
  const readOnly = save.isPending;

  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);

  const blur = (f: string) => () => setTouched((t) => ({ ...t, [f]: true }));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setRanges = (day: Weekday, ranges: Range[]) =>
    setDraft((d) => ({ ...d, hours: { ...d.hours, [day]: ranges } }));

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
    key: 'name' | 'uen' | 'contactEmail' | 'contactPhone',
    label: string,
    opts: { help?: string; placeholder?: string; type?: string; autoComplete?: string } = {},
  ) => {
    const id = `profile-${key}`;
    return (
      <Field id={id} label={label} error={shown(key)} help={opts.help}>
        <input
          id={id}
          className="input"
          type={opts.type ?? 'text'}
          placeholder={opts.placeholder}
          autoComplete={opts.autoComplete}
          value={draft[key]}
          onChange={(e) => set(key, e.target.value)}
          onBlur={blur(key)}
          readOnly={readOnly}
          aria-invalid={shown(key) ? true : undefined}
          aria-describedby={describedBy(id, shown(key), Boolean(opts.help))}
        />
      </Field>
    );
  };

  const errorList = Object.entries(errors);

  return (
    <>
      {submitted && errorList.length > 0 && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="alert__title">Check these fields</p>
          <ul>
            {errorList.map(([f, msg]) => (
              <li key={f}>
                <a
                  href={`#profile-${f}`}
                  onClick={(e) => {
                    // Some browsers don't move focus to a time input on hash navigation.
                    e.preventDefault();
                    document.getElementById(`profile-${f}`)?.focus();
                  }}
                >
                  {msg}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {failure === 'version_conflict' && (
        <div className="alert alert--warning" role="alert">
          <p>
            Someone else saved this profile while you were editing. Reload to see their version,
            then make your change again.
          </p>
          <Button
            variant="secondary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['business-profile'] })}
          >
            Reload
          </Button>
        </div>
      )}
      {failure && failure !== 'version_conflict' && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save your profile just now. Nothing was changed.</p>
        </div>
      )}

      <form className="stack" onSubmit={submit} noValidate>
        <section className="card stack" aria-labelledby="profile-business">
          <h2 className="section-title" id="profile-business">
            Your business
          </h2>
          {text('name', 'Business name (required)', { autoComplete: 'organization' })}
          {text('uen', 'UEN', {
            placeholder: 'e.g. 201912345K',
            help: 'Your Unique Entity Number from ACRA. You can add it later.',
          })}
          <Field
            id="profile-industry"
            label="Industry"
            help="Food and beverage comes with suggested questions to answer."
          >
            <select
              id="profile-industry"
              className="input"
              value={draft.industry}
              onChange={(e) => set('industry', e.target.value as Industry | '')}
              disabled={readOnly}
              aria-describedby="profile-industry-help"
            >
              <option value="">Choose an industry</option>
              {INDUSTRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <label className="radio checkbox">
              <input
                type="checkbox"
                checked={draft.gstRegistered}
                onChange={(e) => set('gstRegistered', e.target.checked)}
                disabled={readOnly}
                aria-describedby="profile-gst-help"
              />
              GST-registered
            </label>
            <p className="field__help" id="profile-gst-help">
              Prices are quoted with GST when you're GST-registered.
            </p>
          </div>
        </section>

        <section className="card stack" aria-labelledby="profile-contact">
          <h2 className="section-title" id="profile-contact">
            Contact
          </h2>
          {text('contactEmail', 'Contact email', { type: 'email', autoComplete: 'email' })}
          {text('contactPhone', 'Contact phone', {
            type: 'tel',
            autoComplete: 'tel',
            placeholder: 'e.g. 9123 4567',
            help: "A Singapore number. Visitors don't see these yet.",
          })}
          <fieldset
            className="radio-group"
            id="profile-languages"
            aria-describedby="profile-languages-help"
          >
            <legend className="field__label">Languages your customers use</legend>
            {LANGUAGE_OPTIONS.map((o) => (
              <label className="radio checkbox" key={o.value}>
                <input
                  type="checkbox"
                  checked={draft.languages.includes(o.value)}
                  onChange={(e) =>
                    set(
                      'languages',
                      e.target.checked
                        ? LANGUAGE_OPTIONS.map((x) => x.value).filter(
                            (v) => v === o.value || draft.languages.includes(v),
                          )
                        : draft.languages.filter((v) => v !== o.value),
                    )
                  }
                  disabled={readOnly}
                />
                <span lang={o.lang}>{o.label}</span>
              </label>
            ))}
            <p className="field__help" id="profile-languages-help">
              Your assistant replies in the visitor's language either way.
            </p>
            {shown('languages') && (
              <p className="field__error">
                <span aria-hidden="true">!</span> {shown('languages')}
              </p>
            )}
          </fieldset>
        </section>

        <section className="card stack" aria-labelledby="profile-hours">
          <h2 className="section-title" id="profile-hours">
            Opening hours
          </h2>
          <Switch
            id="profile-hours-set"
            label="Set opening hours"
            checked={draft.hoursSet}
            disabled={readOnly}
            onChange={(v) => set('hoursSet', v)}
          />
          {!draft.hoursSet ? (
            <p className="field__help">
              Without hours, your assistant doesn't tell visitors when you're closed.
            </p>
          ) : (
            <>
              <ul className="hours-grid">
                {WEEKDAYS.map((day) => (
                  <HoursDay
                    key={day}
                    day={day}
                    ranges={draft.hours[day]}
                    readOnly={readOnly}
                    error={draft.hours[day]
                      .map((_, k) => shown(`hours-${day}-${k}-open`))
                      .find(Boolean)}
                    onChange={(r) => setRanges(day, r)}
                    onCopy={
                      day === 'mon'
                        ? () =>
                            setDraft((d) => ({
                              ...d,
                              hours: {
                                ...d.hours,
                                tue: d.hours.mon,
                                wed: d.hours.mon,
                                thu: d.hours.mon,
                                fri: d.hours.mon,
                              },
                            }))
                        : undefined
                    }
                  />
                ))}
              </ul>
              <p className="field__help">Times are Singapore time. Close at 00:00 for midnight.</p>
            </>
          )}
        </section>

        <section className="card stack" aria-labelledby="profile-holidays">
          <h2 className="section-title" id="profile-holidays">
            Public holidays and closures
          </h2>
          <div className="field">
            <Switch
              id="profile-ph"
              label="Open on public holidays"
              checked={draft.openOnPublicHolidays}
              disabled={readOnly}
              onChange={(v) =>
                // The per-holiday choices start again from the new rule.
                setDraft((d) => ({
                  ...d,
                  openOnPublicHolidays: v,
                  holidayOpen: Object.fromEntries(calendar.holidays.map((h) => [h.day, v])),
                }))
              }
            />
            <p className="field__help">
              With this on, you keep your usual hours on public holidays.
            </p>
          </div>
          <h3 className="subsection-title" id="profile-holiday-list">
            Coming public holidays
          </h3>
          <ul className="holiday-list" aria-labelledby="profile-holiday-list">
            {calendar.holidays.map((h) => (
              <li key={h.day} className="holiday-list__row">
                <span>
                  <span className="holiday-list__day">{dayLabel(h.day)}</span> · {h.name}
                </span>
                <label className="radio checkbox">
                  <input
                    id={`profile-holiday-${h.day}`}
                    type="checkbox"
                    checked={draft.holidayOpen[h.day] ?? draft.openOnPublicHolidays}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        holidayOpen: { ...d.holidayOpen, [h.day]: e.target.checked },
                      }))
                    }
                    disabled={readOnly}
                    aria-label={`Open on ${h.name}, ${dayLabel(h.day)}`}
                  />
                  <span aria-hidden="true">Open</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="field__help">Public holidays are listed through {calendar.coverThrough}.</p>

          <h3 className="subsection-title" id="profile-closures">
            Other closures
          </h3>
          {draft.closures.length === 0 && (
            <p className="field__help">Add days you're closed, like a staff day off.</p>
          )}
          <ul className="closure-list" aria-labelledby="profile-closures">
            {draft.closures.map((c, i) => {
              const dayId = `closure-${c.key}-day`;
              const labelId = `closure-${c.key}-label`;
              const update = (patch: Partial<Closure>) =>
                setDraft((d) => ({
                  ...d,
                  closures: d.closures.map((x) => (x.key === c.key ? { ...x, ...patch } : x)),
                }));
              return (
                <li key={c.key} className="closure-row">
                  <Field
                    id={`profile-${dayId}`}
                    label={`Closure ${i + 1} date`}
                    error={shown(dayId)}
                  >
                    <input
                      id={`profile-${dayId}`}
                      className="input"
                      type="date"
                      min={sgToday()}
                      value={c.day}
                      onChange={(e) => update({ day: e.target.value })}
                      onBlur={blur(dayId)}
                      readOnly={readOnly}
                      aria-invalid={shown(dayId) ? true : undefined}
                      aria-describedby={describedBy(`profile-${dayId}`, shown(dayId))}
                    />
                  </Field>
                  <Field id={`profile-${labelId}`} label="Reason (optional)" error={shown(labelId)}>
                    <input
                      id={`profile-${labelId}`}
                      className="input"
                      placeholder="e.g. Staff day off"
                      maxLength={60}
                      value={c.label}
                      onChange={(e) => update({ label: e.target.value })}
                      readOnly={readOnly}
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={readOnly}
                    aria-label={`Remove closure ${i + 1}`}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        closures: d.closures.filter((x) => x.key !== c.key),
                      }))
                    }
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
          <div>
            <Button
              variant="secondary"
              type="button"
              disabled={readOnly}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  closures: [...d.closures, { key: nextKey++, day: '', label: '' }],
                }))
              }
            >
              Add a closure
            </Button>
          </div>
        </section>

        {mode === 'settings' && (template || draft.industry !== (profile.industry ?? '')) && (
          <section className="card stack" aria-labelledby="profile-suggestions">
            <h2 className="section-title" id="profile-suggestions">
              Suggested questions
              {template ? ` for ${INDUSTRY_LABEL[template.industry]?.toLowerCase()}` : ''}
            </h2>
            {draft.industry !== (profile.industry ?? '') ? (
              <p className="field__help">Save to see the suggested questions for this industry.</p>
            ) : (
              template && (
                <>
                  <p className="page-lede">
                    Customers often ask these. Add your answers so your assistant can reply.
                  </p>
                  <ul className="suggestion-list">
                    {template.suggestedFaqs.map((f) => (
                      <li key={f.id} className="suggestion-list__row">
                        <span className="suggestion-list__text">
                          <span className="suggestion-list__question">{f.question}</span>
                          <span className="field__help">{f.hint}</span>
                        </span>
                        {f.added ? (
                          <span className="status-badge status-badge--approved">
                            <span className="status-badge__dot" aria-hidden="true" />
                            Added
                          </span>
                        ) : (
                          <Button variant="secondary" asChild>
                            <Link
                              to={`/knowledge/facts/new?type=faq&question=${encodeURIComponent(f.question)}`}
                              aria-label={`Add answer: ${f.question}`}
                            >
                              Add answer
                            </Link>
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )
            )}
          </section>
        )}

        <div className="action-bar">
          <Button
            type="submit"
            disabled={readOnly || (mode === 'settings' && !changed)}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? 'Saving…' : mode === 'setup' ? 'Save and continue' : 'Save changes'}
          </Button>
          {mode === 'settings' && (
            <Button
              variant="ghost"
              type="button"
              disabled={readOnly || !changed}
              onClick={() => {
                setDraft(initial);
                setTouched({});
                setSubmitted(false);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </form>
    </>
  );
}

/** `toggle` (design.md §4.2): the label says what "on" means. */
function Switch({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="fact-form__status">
      <button
        id={id}
        type="button"
        role="switch"
        className="toggle"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle__thumb" aria-hidden="true" />
      </button>
      <span id={`${id}-label`}>{label}</span>
    </div>
  );
}

/** One day of the `hours-editor` (design.md §4.2). */
function HoursDay({
  day,
  ranges,
  readOnly,
  error,
  onChange,
  onCopy,
}: {
  day: Weekday;
  ranges: Range[];
  readOnly: boolean;
  error: string | undefined;
  onChange: (r: Range[]) => void;
  onCopy: (() => void) | undefined;
}) {
  const name = WEEKDAY_NAMES[day];
  const open = ranges.length > 0;
  const errorId = `profile-hours-${day}-error`;
  const setRange = (k: number, patch: Partial<Range>) =>
    onChange(ranges.map((r, i) => (i === k ? { ...r, ...patch } : r)));
  return (
    <li className="hours-day">
      <div className="hours-day__head">
        <span className="hours-day__name">{name}</span>
        <button
          type="button"
          role="switch"
          className="toggle"
          aria-checked={open}
          aria-label={`Open on ${name}`}
          disabled={readOnly}
          onClick={() => onChange(open ? [] : [{ open: '09:00', close: '18:00' }])}
        >
          <span className="toggle__thumb" aria-hidden="true" />
        </button>
        {!open && <span className="hours-day__closed">Closed</span>}
      </div>
      {open && (
        <div className="hours-day__ranges">
          {ranges.map((r, k) => {
            const n = ranges.length > 1 ? ` (${k + 1})` : '';
            return (
              <div className="hours-range" key={k}>
                <input
                  id={`profile-hours-${day}-${k}-open`}
                  className="input"
                  type="time"
                  step={900}
                  value={r.open}
                  onChange={(e) => setRange(k, { open: e.target.value })}
                  readOnly={readOnly}
                  aria-label={`${name} opens${n}`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
                <span aria-hidden="true">to</span>
                <input
                  id={`profile-hours-${day}-${k}-close`}
                  className="input"
                  type="time"
                  step={900}
                  value={r.close}
                  onChange={(e) => setRange(k, { close: e.target.value })}
                  readOnly={readOnly}
                  aria-label={`${name} closes${n}`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
                {k > 0 && (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={readOnly}
                    aria-label={`Remove ${name} hours${n}`}
                    onClick={() => onChange(ranges.filter((_, i) => i !== k))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
          <div className="hours-day__actions">
            {ranges.length < 4 && (
              <Button
                variant="ghost"
                type="button"
                disabled={readOnly}
                aria-label={`Add hours on ${name}`}
                onClick={() => {
                  const last = ranges.at(-1)!;
                  onChange([
                    ...ranges,
                    { open: last.close === '00:00' ? '23:00' : last.close, close: '00:00' },
                  ]);
                }}
              >
                Add hours
              </Button>
            )}
            {onCopy && (
              <Button variant="ghost" type="button" disabled={readOnly} onClick={onCopy}>
                Copy Monday to Tue–Fri
              </Button>
            )}
          </div>
          {error && (
            <p className="field__error" id={errorId}>
              <span aria-hidden="true">!</span> {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

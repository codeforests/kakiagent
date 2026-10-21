import type { CreateFactBody, Fact, FactType, PolicyKind, UpdateFactBody } from '@kaki/contracts';
import { Button, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { dayLabel, factTitle, POLICY_KIND_LABEL, promotionWindow, sgToday } from '../lib/facts.ts';
import { DeleteFactDialog, type DeleteOutcome } from './delete-fact.tsx';
import { StatusBadge } from './facts.tsx';
import { NotFound } from './system.tsx';

type Kind = FactType;
type Gst = 'inclusive' | 'exclusive' | '';

interface Draft {
  type: Kind;
  name: string;
  unit: string;
  price: string;
  gst: Gst;
  question: string;
  answer: string;
  kind: PolicyKind | '';
  title: string;
  details: string;
  validFrom: string;
  validUntil: string;
  useInAnswers: boolean;
}

type FieldName =
  'name' | 'price' | 'gst' | 'question' | 'answer' | 'kind' | 'title' | 'details' | 'validUntil';

const BLANK: Draft = {
  type: 'product',
  name: '',
  unit: '',
  price: '',
  gst: '',
  question: '',
  answer: '',
  kind: '',
  title: '',
  details: '',
  validFrom: '',
  validUntil: '',
  useInAnswers: true,
};

const PRICE_RE = /^\d{1,7}(\.\d{1,2})?$/;
const PRICE_MSG = 'Enter the price in dollars and cents, like 55.00';
const GST_MSG = 'Choose whether the price includes GST';

const TYPE_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'product', label: 'Product or service' },
  { value: 'faq', label: 'Question and answer (FAQ)' },
  { value: 'policy', label: 'Policy' },
  { value: 'promotion', label: 'Promotion' },
];

function fromFact(f: Fact): Draft {
  const base = { ...BLANK, type: f.type, useInAnswers: f.status !== 'disabled' };
  const gst = (g: Fact['gstTreatment']): Gst => (g === 'inclusive' || g === 'exclusive' ? g : '');
  switch (f.type) {
    case 'faq':
      return { ...base, question: f.value.question, answer: f.value.answer };
    case 'product':
      return {
        ...base,
        name: f.value.name,
        unit: f.value.unit ?? '',
        price: f.value.price,
        gst: gst(f.gstTreatment),
      };
    case 'policy':
      return { ...base, kind: f.value.kind, title: f.value.title, details: f.value.details };
    case 'promotion':
      return {
        ...base,
        title: f.value.title,
        details: f.value.details,
        price: f.value.price ?? '',
        gst: gst(f.gstTreatment),
        validFrom: f.validFrom ?? '',
        validUntil: f.validUntil ?? '',
      };
  }
}

/** Messages from ui-design SCR-APP-028 "validation" (design.md §4.2). */
function validate(d: Draft, unknownGst: boolean): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  switch (d.type) {
    case 'product':
      if (!d.name.trim()) errors.name = 'Enter the product name';
      if (!PRICE_RE.test(d.price.trim())) errors.price = PRICE_MSG;
      // A stored "unknown" may stay while other fields change (KB-15 review is optional here).
      if (!d.gst && !unknownGst) errors.gst = GST_MSG;
      break;
    case 'faq':
      if (!d.question.trim()) errors.question = 'Enter the question';
      if (!d.answer.trim()) errors.answer = 'Enter the answer';
      break;
    case 'policy':
      if (!d.kind) errors.kind = 'Choose the kind of policy';
      if (!d.title.trim()) errors.title = 'Enter the title';
      if (!d.details.trim()) errors.details = 'Enter the details';
      break;
    case 'promotion':
      if (!d.title.trim()) errors.title = 'Enter the title';
      if (!d.details.trim()) errors.details = 'Enter the details';
      if (d.price.trim() && !PRICE_RE.test(d.price.trim())) errors.price = PRICE_MSG;
      if (d.price.trim() && !d.gst && !unknownGst) errors.gst = GST_MSG;
      if (!d.validUntil) errors.validUntil = 'Choose the end date';
      else if (d.validFrom && d.validFrom > d.validUntil)
        errors.validUntil = 'The end date must be on or after the start date';
      break;
  }
  return errors;
}

/** Price as stored, `55` → `55.00`, so an unchanged price compares equal. */
const normPrice = (p: string) => {
  const [d = '', c = ''] = p.trim().split('.');
  return `${Number(d)}.${c.padEnd(2, '0')}`;
};

function valueOf(d: Draft) {
  switch (d.type) {
    case 'product':
      return { name: d.name.trim(), price: normPrice(d.price), unit: d.unit.trim() || undefined };
    case 'faq':
      return { question: d.question.trim(), answer: d.answer.trim() };
    case 'policy':
      return { kind: d.kind as PolicyKind, title: d.title.trim(), details: d.details.trim() };
    case 'promotion':
      return {
        title: d.title.trim(),
        details: d.details.trim(),
        price: d.price.trim() ? normPrice(d.price) : undefined,
      };
  }
}

const hasPrice = (d: Draft) => d.type === 'product' || (d.type === 'promotion' && !!d.price.trim());

function createBody(d: Draft): CreateFactBody {
  const gstTreatment = d.gst as 'inclusive' | 'exclusive';
  switch (d.type) {
    case 'product':
      return {
        type: 'product',
        value: valueOf(d) as { name: string; price: string; unit?: string },
        gstTreatment,
      };
    case 'faq':
      return { type: 'faq', value: valueOf(d) as { question: string; answer: string } };
    case 'policy':
      return {
        type: 'policy',
        value: valueOf(d) as { kind: PolicyKind; title: string; details: string },
      };
    case 'promotion':
      return {
        type: 'promotion',
        value: valueOf(d) as { title: string; details: string; price?: string },
        ...(hasPrice(d) ? { gstTreatment } : {}),
        ...(d.validFrom ? { validFrom: d.validFrom } : {}),
        validUntil: d.validUntil,
      };
  }
}

/** Only what changed; `null` when nothing did. */
function patchBody(fact: Fact, d: Draft): UpdateFactBody | null {
  const before = fromFact(fact);
  const body: UpdateFactBody = { version: fact.version };
  if (JSON.stringify(valueOf(before)) !== JSON.stringify(valueOf(d))) body.value = valueOf(d);
  if (hasPrice(d) && d.gst && d.gst !== before.gst) body.gstTreatment = d.gst;
  if (d.type === 'promotion') {
    if (d.validFrom !== before.validFrom) body.validFrom = d.validFrom || null;
    if (d.validUntil !== before.validUntil) body.validUntil = d.validUntil;
  }
  if (d.useInAnswers !== before.useInAnswers)
    body.status = d.useInAnswers ? 'approved' : 'disabled';
  return Object.keys(body).length > 1 ? body : null;
}

/** The saved toast (FEAT-022, FEAT-011 ui-design "saved"). */
function savedToast(d: Draft): string {
  if (d.type === 'promotion' && d.validFrom && d.validFrom > sgToday())
    return `Fact saved. Your assistant starts using it on ${dayLabel(d.validFrom)}.`;
  return 'Fact saved. Your assistant uses it from now on.';
}

const DELETE_TOAST: Record<DeleteOutcome, string> = {
  deleted: 'Fact deleted.',
  'already-deleted': 'This fact was already deleted.',
};

/** SCR-APP-028 Fact: create at `/knowledge/facts/new`, edit at `/knowledge/facts/:id` (KB-07, KB-15). */
export function FactPage() {
  const { id } = useParams();
  const editing = id !== undefined;
  const loaded = useQuery({
    queryKey: ['fact', id],
    queryFn: () => api.fact(id!),
    enabled: editing,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });

  if (!editing) return <FactForm fact={null} />;
  if (loaded.error instanceof ApiError && loaded.error.status === 404) return <NotFound />;
  if (loaded.isError)
    return (
      <ErrorState
        title="We couldn't load this fact"
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  if (!loaded.data)
    return (
      <div className="fact-form" aria-busy="true" aria-label="Loading fact">
        <div className="skeleton-field" />
        <div className="skeleton-field" />
        <div className="skeleton-field" />
      </div>
    );
  return (
    <FactForm key={`${loaded.data.fact.id}-${loaded.data.fact.version}`} fact={loaded.data.fact} />
  );
}

function FactForm({ fact }: { fact: Fact | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(fact ? fromFact(fact) : BLANK);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  // KB-15: a stored "unknown" GST treatment may stay through other edits.
  const unknownGst = fact?.gstTreatment === 'unknown' && !draft.gst;
  const errors = validate(draft, unknownGst);
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const patch = fact ? patchBody(fact, draft) : null;

  const save = useMutation({
    mutationFn: () => (fact ? api.updateFact(fact.id, patch!) : api.createFact(createBody(draft))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['facts'] });
      if (fact) queryClient.removeQueries({ queryKey: ['fact', fact.id] });
      void navigate('/knowledge', { state: { toast: savedToast(draft) } });
    },
  });
  const failure =
    save.error instanceof ApiError ? save.error.code : save.error ? 'unavailable' : null;
  // Rejected and conflicted facts are resolved in Review (FEAT-013/014), not here.
  const locked =
    failure === 'invalid_state' || fact?.status === 'rejected' || fact?.status === 'conflicted';
  const readOnly = save.isPending || locked;

  // Each submit with errors moves focus to the summary (design.md §4.2).
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);

  const set = (patchDraft: Partial<Draft>) => setDraft((d) => ({ ...d, ...patchDraft }));
  const blur = (f: FieldName) => () => setTouched((t) => ({ ...t, [f]: true }));
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['fact', fact?.id] });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setAttempts((n) => n + 1);
      return;
    }
    if (fact && !patch) return;
    save.mutate();
  }

  const title = fact ? factTitle(fact).split(', ')[0]! : 'Add a fact';
  const errorList = Object.entries(errors) as [FieldName, string][];
  const ended = fact?.type === 'promotion' && promotionWindow(fact).state === 'ended';

  const input = (
    f: FieldName,
    label: string,
    key: 'name' | 'question' | 'title',
    placeholder: string,
  ) => (
    <Field id={`fact-${f}`} label={label} error={shown(f)}>
      <input
        id={`fact-${f}`}
        className="input"
        placeholder={placeholder}
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        onBlur={blur(f)}
        readOnly={readOnly}
        aria-invalid={shown(f) ? true : undefined}
        aria-describedby={describedBy(`fact-${f}`, shown(f))}
      />
    </Field>
  );
  const area = (
    f: FieldName,
    label: string,
    key: 'answer' | 'details',
    placeholder: string,
    help?: string,
  ) => (
    <Field id={`fact-${f}`} label={label} error={shown(f)} help={help}>
      <textarea
        id={`fact-${f}`}
        className="input input--area"
        placeholder={placeholder}
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        onBlur={blur(f)}
        readOnly={readOnly}
        aria-invalid={shown(f) ? true : undefined}
        aria-describedby={describedBy(`fact-${f}`, shown(f), Boolean(help))}
      />
    </Field>
  );
  const priceField = (label: string) => (
    <Field id="fact-price" label={label} error={shown('price')}>
      <div className="input-adorned">
        <span className="input-adorned__prefix" aria-hidden="true">
          S$
        </span>
        <input
          id="fact-price"
          className="input"
          inputMode="decimal"
          placeholder="e.g. 55.00"
          value={draft.price}
          onChange={(e) => set({ price: e.target.value })}
          onBlur={blur('price')}
          readOnly={readOnly}
          aria-invalid={shown('price') ? true : undefined}
          aria-describedby={describedBy('fact-price', shown('price'))}
        />
      </div>
    </Field>
  );
  const gstField = (required: boolean) => (
    <fieldset
      className="radio-group"
      id="fact-gst"
      aria-describedby={describedBy('fact-gst', shown('gst'), true)}
    >
      <legend className="field__label">{required ? 'GST (required)' : 'GST'}</legend>
      <label className="radio">
        <input
          type="radio"
          name="gst"
          checked={draft.gst === 'inclusive'}
          onChange={() => set({ gst: 'inclusive' })}
          onBlur={blur('gst')}
          disabled={readOnly}
        />
        Price includes GST
      </label>
      <label className="radio">
        <input
          type="radio"
          name="gst"
          checked={draft.gst === 'exclusive'}
          onChange={() => set({ gst: 'exclusive' })}
          onBlur={blur('gst')}
          disabled={readOnly}
        />
        Price is before GST
      </label>
      <p className="field__help" id="fact-gst-help">
        If you're GST-registered, your assistant always quotes prices with GST included.
      </p>
      {shown('gst') && (
        <p className="field__error" id="fact-gst-error">
          <span aria-hidden="true">!</span> {shown('gst')}
        </p>
      )}
    </fieldset>
  );

  return (
    <div className="fact-page">
      <Link className="back-link" to="/knowledge">
        Facts
      </Link>
      <h1 className="page-title">{title}</h1>

      {submitted && errorList.length > 0 && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="alert__title">Check these fields</p>
          <ul>
            {errorList.map(([f, msg]) => (
              <li key={f}>
                <a href={`#fact-${f}`}>{msg}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {failure === 'version_conflict' && (
        <div className="alert alert--warning" role="alert">
          <p>
            Someone else saved this fact while you were editing. Reload to see their version, then
            make your change again.
          </p>
          <Button variant="secondary" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      {locked && (
        <div className="alert alert--info" role="alert">
          <p>This fact can't be edited here.</p>
        </div>
      )}
      {failure && failure !== 'version_conflict' && failure !== 'invalid_state' && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save the fact just now. Nothing was changed. Try again in a moment.</p>
        </div>
      )}
      {fact?.gstTreatment === 'unknown' && !locked && (
        <div className="alert alert--warning">
          <p>Choose whether this price includes GST. Your assistant won't quote it until you do.</p>
        </div>
      )}
      {ended && fact.validUntil && (
        <div className="alert alert--info">
          <p>
            This promotion ended on {dayLabel(fact.validUntil)}, so your assistant no longer
            mentions it. Change the end date to run it again.
          </p>
        </div>
      )}

      <form className="fact-form card" onSubmit={submit} noValidate>
        {fact ? (
          <p className="fact-form__type">
            {TYPE_OPTIONS.find((o) => o.value === fact.type)!.label}
          </p>
        ) : (
          <fieldset className="radio-group">
            <legend className="field__label">Type</legend>
            {TYPE_OPTIONS.map((o) => (
              <label className="radio" key={o.value}>
                <input
                  type="radio"
                  name="type"
                  checked={draft.type === o.value}
                  onChange={() => set({ type: o.value })}
                  disabled={readOnly}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
        )}

        {draft.type === 'product' && (
          <>
            {input('name', 'Name (required)', 'name', 'e.g. Chocolate fudge cake or Cake delivery')}
            <Field id="fact-unit" label="Size or unit">
              <input
                id="fact-unit"
                className="input"
                placeholder="e.g. 1 kg"
                value={draft.unit}
                onChange={(e) => set({ unit: e.target.value })}
                readOnly={readOnly}
              />
            </Field>
            {priceField('Price in S$ (required)')}
            {gstField(true)}
          </>
        )}

        {draft.type === 'faq' && (
          <>
            {input(
              'question',
              'Question (required)',
              'question',
              'e.g. Do you have eggless cakes?',
            )}
            {area('answer', 'Answer (required)', 'answer', 'e.g. Yes, on request, 3 days ahead.')}
          </>
        )}

        {draft.type === 'policy' && (
          <>
            <Field id="fact-kind" label="Kind (required)" error={shown('kind')}>
              <select
                id="fact-kind"
                className="input"
                value={draft.kind}
                onChange={(e) => set({ kind: e.target.value as PolicyKind | '' })}
                onBlur={blur('kind')}
                disabled={readOnly}
                aria-invalid={shown('kind') ? true : undefined}
                aria-describedby={describedBy('fact-kind', shown('kind'))}
              >
                <option value="">Choose…</option>
                {(Object.keys(POLICY_KIND_LABEL) as PolicyKind[]).map((k) => (
                  <option key={k} value={k}>
                    {POLICY_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            {input('title', 'Title (required)', 'title', 'e.g. Refunds on whole cakes')}
            {area(
              'details',
              'Details (required)',
              'details',
              'e.g. Cancel at least 2 days before collection for a full refund.',
              'Your assistant quotes these details as written.',
            )}
          </>
        )}

        {draft.type === 'promotion' && (
          <>
            {input('title', 'Title (required)', 'title', 'e.g. Deepavali bundle')}
            {area(
              'details',
              'Details (required)',
              'details',
              'e.g. Any 2 boxes of kueh with a free ondeh ondeh box.',
            )}
            {priceField('Promotion price in S$')}
            {draft.price.trim() && gstField(true)}
            <div className="date-pair">
              <Field id="fact-validFrom" label="Starts on">
                <input
                  id="fact-validFrom"
                  className="input"
                  type="date"
                  value={draft.validFrom}
                  onChange={(e) => set({ validFrom: e.target.value })}
                  readOnly={readOnly}
                />
              </Field>
              <Field
                id="fact-validUntil"
                label="Ends on (required)"
                error={shown('validUntil')}
                help="Dates are in Singapore time. Your assistant stops mentioning it after the end date."
              >
                <input
                  id="fact-validUntil"
                  className="input"
                  type="date"
                  value={draft.validUntil}
                  onChange={(e) => set({ validUntil: e.target.value })}
                  onBlur={blur('validUntil')}
                  readOnly={readOnly}
                  aria-invalid={shown('validUntil') ? true : undefined}
                  aria-describedby={describedBy('fact-validUntil', shown('validUntil'), true)}
                />
              </Field>
            </div>
          </>
        )}

        {fact && (
          <div className="fact-form__status">
            <StatusBadge status={fact.status} />
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={draft.useInAnswers}
              aria-labelledby="fact-use-label"
              disabled={readOnly || fact.status === 'needs_review'}
              onClick={() => set({ useInAnswers: !draft.useInAnswers })}
            >
              <span className="toggle__thumb" aria-hidden="true" />
            </button>
            <span id="fact-use-label">Use in answers</span>
          </div>
        )}

        <div className="action-bar">
          <Button
            type="submit"
            disabled={readOnly || (fact !== null && patch === null)}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? 'Saving…' : 'Save fact'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => void navigate('/knowledge')}>
            Cancel
          </Button>
          {fact && (
            <Button
              variant="danger-ghost"
              type="button"
              className="action-bar__end"
              disabled={save.isPending}
              onClick={() => setDeleting(true)}
            >
              Delete fact
            </Button>
          )}
        </div>
      </form>

      {fact && (
        <DeleteFactDialog
          fact={deleting ? fact : null}
          onClose={() => setDeleting(false)}
          conflictAction={
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(false);
                reload();
              }}
            >
              Reload
            </Button>
          }
          onDone={async (outcome) => {
            await queryClient.invalidateQueries({ queryKey: ['facts'] });
            queryClient.removeQueries({ queryKey: ['fact', fact.id] });
            void navigate('/knowledge', { state: { toast: DELETE_TOAST[outcome] } });
          }}
        />
      )}
    </div>
  );
}

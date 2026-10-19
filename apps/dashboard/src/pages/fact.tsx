import type { CreateFactBody, Fact, UpdateFactBody } from '@kaki/contracts';
import { Button, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { StatusBadge } from './facts.tsx';
import { NotFound } from './system.tsx';

type Kind = 'product' | 'faq';
type Gst = 'inclusive' | 'exclusive' | '';

interface Draft {
  type: Kind;
  name: string;
  unit: string;
  price: string;
  gst: Gst;
  question: string;
  answer: string;
  useInAnswers: boolean;
}

type FieldName = 'name' | 'price' | 'gst' | 'question' | 'answer';

const BLANK: Draft = {
  type: 'product',
  name: '',
  unit: '',
  price: '',
  gst: '',
  question: '',
  answer: '',
  useInAnswers: true,
};

const PRICE_RE = /^\d{1,7}(\.\d{1,2})?$/;

function fromFact(f: Fact): Draft {
  const base = { ...BLANK, type: f.type, useInAnswers: f.status !== 'disabled' };
  if (f.type === 'faq') return { ...base, question: f.value.question, answer: f.value.answer };
  return {
    ...base,
    name: f.value.name,
    unit: f.value.unit ?? '',
    price: f.value.price,
    gst: f.gstTreatment === 'unknown' ? '' : f.gstTreatment,
  };
}

/** Messages from ui-design SCR-APP-028 "validation" (design.md §4.2). */
function validate(d: Draft): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  if (d.type === 'product') {
    if (!d.name.trim()) errors.name = 'Enter the product name';
    if (!PRICE_RE.test(d.price.trim()))
      errors.price = 'Enter the price in dollars and cents, like 55.00';
    if (!d.gst) errors.gst = 'Choose whether the price includes GST';
  } else {
    if (!d.question.trim()) errors.question = 'Enter the question';
    if (!d.answer.trim()) errors.answer = 'Enter the answer';
  }
  return errors;
}

/** Price as stored, `55` → `55.00`, so an unchanged price compares equal. */
const normPrice = (p: string) => {
  const [d = '', c = ''] = p.trim().split('.');
  return `${Number(d)}.${c.padEnd(2, '0')}`;
};

function valueOf(d: Draft) {
  return d.type === 'product'
    ? { name: d.name.trim(), price: normPrice(d.price), unit: d.unit.trim() || undefined }
    : { question: d.question.trim(), answer: d.answer.trim() };
}

function createBody(d: Draft): CreateFactBody {
  return d.type === 'product'
    ? {
        type: 'product',
        value: valueOf(d) as { name: string; price: string; unit?: string },
        gstTreatment: d.gst as 'inclusive' | 'exclusive',
      }
    : { type: 'faq', value: valueOf(d) as { question: string; answer: string } };
}

/** Only what changed; `null` when nothing did. */
function patchBody(fact: Fact, d: Draft): UpdateFactBody | null {
  const before = fromFact(fact);
  const body: UpdateFactBody = { version: fact.version };
  if (JSON.stringify(valueOf(before)) !== JSON.stringify(valueOf(d))) body.value = valueOf(d);
  if (d.type === 'product' && d.gst && d.gst !== before.gst) body.gstTreatment = d.gst;
  if (d.useInAnswers !== before.useInAnswers)
    body.status = d.useInAnswers ? 'approved' : 'disabled';
  return body.value || body.gstTreatment || body.status ? body : null;
}

function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help && (
        <p className="field__help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          <span aria-hidden="true">!</span> {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, error?: string, help?: boolean) =>
  [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

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
  const summaryRef = useRef<HTMLDivElement>(null);
  const errors = validate(draft);
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const patch = fact ? patchBody(fact, draft) : null;

  const save = useMutation({
    mutationFn: () => (fact ? api.updateFact(fact.id, patch!) : api.createFact(createBody(draft))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['facts'] });
      if (fact) queryClient.removeQueries({ queryKey: ['fact', fact.id] });
      void navigate('/knowledge', { state: { saved: true } });
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

  const title = fact
    ? fact.type === 'product'
      ? fact.value.name
      : fact.value.question
    : 'Add a fact';
  const errorList = Object.entries(errors) as [FieldName, string][];

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
          <Button
            variant="secondary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['fact', fact?.id] })}
          >
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

      <form className="fact-form card" onSubmit={submit} noValidate>
        {fact ? (
          <p className="fact-form__type">
            {fact.type === 'product' ? 'Product and price' : 'Question and answer (FAQ)'}
          </p>
        ) : (
          <fieldset className="radio-group">
            <legend className="field__label">Type</legend>
            <label className="radio">
              <input
                type="radio"
                name="type"
                checked={draft.type === 'product'}
                onChange={() => set({ type: 'product' })}
                disabled={readOnly}
              />
              Product and price
            </label>
            <label className="radio">
              <input
                type="radio"
                name="type"
                checked={draft.type === 'faq'}
                onChange={() => set({ type: 'faq' })}
                disabled={readOnly}
              />
              Question and answer (FAQ)
            </label>
          </fieldset>
        )}

        {draft.type === 'product' ? (
          <>
            <Field id="fact-name" label="Name (required)" error={shown('name')}>
              <input
                id="fact-name"
                className="input"
                placeholder="e.g. Chocolate fudge cake"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                onBlur={blur('name')}
                readOnly={readOnly}
                aria-invalid={shown('name') ? true : undefined}
                aria-describedby={describedBy('fact-name', shown('name'))}
              />
            </Field>
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
            <Field id="fact-price" label="Price in S$ (required)" error={shown('price')}>
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
            <fieldset
              className="radio-group"
              id="fact-gst"
              aria-describedby={describedBy('fact-gst', shown('gst'), true)}
            >
              <legend className="field__label">GST (required)</legend>
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
          </>
        ) : (
          <>
            <Field id="fact-question" label="Question (required)" error={shown('question')}>
              <input
                id="fact-question"
                className="input"
                placeholder="e.g. Do you have eggless cakes?"
                value={draft.question}
                onChange={(e) => set({ question: e.target.value })}
                onBlur={blur('question')}
                readOnly={readOnly}
                aria-invalid={shown('question') ? true : undefined}
                aria-describedby={describedBy('fact-question', shown('question'))}
              />
            </Field>
            <Field id="fact-answer" label="Answer (required)" error={shown('answer')}>
              <textarea
                id="fact-answer"
                className="input input--area"
                placeholder="e.g. Yes, on request, 3 days ahead."
                value={draft.answer}
                onChange={(e) => set({ answer: e.target.value })}
                onBlur={blur('answer')}
                readOnly={readOnly}
                aria-invalid={shown('answer') ? true : undefined}
                aria-describedby={describedBy('fact-answer', shown('answer'))}
              />
            </Field>
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
        </div>
      </form>
    </div>
  );
}

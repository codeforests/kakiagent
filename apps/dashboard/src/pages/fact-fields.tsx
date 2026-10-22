import type { FactType, PolicyKind } from '@kaki/contracts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { POLICY_KIND_LABEL } from '../lib/facts.ts';
import { TYPE_OPTIONS, type Draft, type FieldName } from '../lib/fact-draft.ts';

export interface FactFieldsProps {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  /** The error to show for a field (after it was touched or the form submitted). */
  shown: (f: FieldName) => string | undefined;
  blur: (f: FieldName) => () => void;
  readOnly: boolean;
  /** An existing fact's type, shown as text; null offers the type choice (new facts). */
  fixedType: FactType | null;
}

/**
 * The type-specific fields of SCR-APP-028 (FEAT-011 ui-design), used by the Fact page and
 * by Review's "Edit and approve" dialog (FEAT-013 ui-design).
 */
export function FactFields({ draft, set, shown, blur, readOnly, fixedType }: FactFieldsProps) {
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
    <>
      {fixedType ? (
        <p className="fact-form__type">{TYPE_OPTIONS.find((o) => o.value === fixedType)!.label}</p>
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
          {input('question', 'Question (required)', 'question', 'e.g. Do you have eggless cakes?')}
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
    </>
  );
}

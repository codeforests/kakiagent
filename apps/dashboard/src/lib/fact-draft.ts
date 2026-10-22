import type {
  ApproveFactBody,
  CreateFactBody,
  Fact,
  FactType,
  PolicyKind,
  UpdateFactBody,
} from '@kaki/contracts';

/**
 * The fact form's draft and its rules (SCR-APP-028; FEAT-011 ui-design), shared by the
 * Fact page and Review's "Edit and approve" (FEAT-013).
 */

type Kind = FactType;
export type Gst = 'inclusive' | 'exclusive' | '';

export interface Draft {
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

export type FieldName =
  'name' | 'price' | 'gst' | 'question' | 'answer' | 'kind' | 'title' | 'details' | 'validUntil';

export const BLANK: Draft = {
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

export const TYPE_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'product', label: 'Product or service' },
  { value: 'faq', label: 'Question and answer (FAQ)' },
  { value: 'policy', label: 'Policy' },
  { value: 'promotion', label: 'Promotion' },
];

export function fromFact(f: Fact): Draft {
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
export function validate(d: Draft, unknownGst: boolean): Partial<Record<FieldName, string>> {
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

export function createBody(d: Draft): CreateFactBody {
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
export function patchBody(fact: Fact, d: Draft): UpdateFactBody | null {
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

/** The edit fields of an approval (FEAT-013 §3.2): what changed, without the status. */
export function editBody(fact: Fact, d: Draft): ApproveFactBody {
  const body = patchBody(fact, { ...d, useInAnswers: true }) ?? { version: fact.version };
  delete body.status;
  return body;
}

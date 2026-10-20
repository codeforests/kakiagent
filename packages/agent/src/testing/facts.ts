import type { VisitorFact } from '@kaki/kb';

/** Bakery facts used across the agent's unit tests (plan §6 user flow). */
export const FUDGE: Extract<VisitorFact, { type: 'product' }> = {
  id: '9c1e4a2b-1111-4aaa-8aaa-000000000001',
  type: 'product',
  version: 1,
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

export const EGGLESS: Extract<VisitorFact, { type: 'faq' }> = {
  id: '7b3d0f9e-2222-4bbb-8bbb-000000000002',
  type: 'faq',
  version: 1,
  value: { question: 'Do you have eggless cakes?', answer: 'Yes, on request, 3 days ahead.' },
  gstTreatment: null,
};

export const EXCLUSIVE: Extract<VisitorFact, { type: 'product' }> = {
  id: '5a5a5a5a-3333-4ccc-8ccc-000000000003',
  type: 'product',
  version: 1,
  value: { name: 'Pandan chiffon', priceCents: 5500, currency: 'SGD' },
  gstTreatment: 'exclusive',
};

export const REFUND: Extract<VisitorFact, { type: 'policy' }> = {
  id: '4d4d4d4d-4444-4ddd-8ddd-000000000004',
  type: 'policy',
  version: 1,
  value: {
    kind: 'refund',
    title: 'Refunds on whole cakes',
    details: 'Cancel at least 2 days before collection for a full refund.',
  },
  gstTreatment: null,
};

/** Ends on 31 Oct 2026 (SGT): `validUntil` is 00:00 SGT on 1 Nov. */
export const BUNDLE: Extract<VisitorFact, { type: 'promotion' }> = {
  id: '3e3e3e3e-5555-4eee-8eee-000000000005',
  type: 'promotion',
  version: 1,
  value: {
    title: 'Deepavali kueh bundle',
    details: 'Any 2 boxes of kueh with a free ondeh ondeh box.',
    priceCents: 2000,
    currency: 'SGD',
  },
  gstTreatment: 'exclusive',
  validUntil: new Date('2026-10-31T16:00:00Z'),
};

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

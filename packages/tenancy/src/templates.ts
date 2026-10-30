import type { Industry } from './profile.js';

/**
 * Industry templates (ONB-06; FEAT-009 §5.1, D5). F&B is the pilot vertical (D1) and the
 * only template so far; FEAT-054 adds its boundary-rule topics and FEAT-049 its lead fields.
 * A template holds questions and hints only, never answers: the owner writes each answer
 * as a FAQ fact, so nothing here can reach a visitor as a claim.
 */

export interface SuggestedFaq {
  /** Stable across releases (`fnb.custom-orders`). */
  id: string;
  question: string;
  /** What a good answer covers, for the owner. */
  hint: string;
}

export interface IndustryTemplate {
  suggestedFaqs: readonly SuggestedFaq[];
  /**
   * Topics prefilled on the rules form (FEAT-054 §5.2, D3). A suggestion: in force only once
   * saved. Commitments and discounts stay at the safe defaults for every industry.
   */
  suggestedRules: { allowedTopics: readonly string[]; blockedTopics: readonly string[] };
}

const FNB: IndustryTemplate = {
  suggestedRules: {
    allowedTopics: [
      'Menu and prices',
      'Custom and celebration cakes',
      'Ordering and notice needed',
      'Delivery and self-collection',
      'Allergens, halal and dietary needs',
      'Payment',
      'Events and bulk orders',
    ],
    blockedTopics: ["Competitors' prices", 'Health or weight-loss claims'],
  },
  suggestedFaqs: [
    {
      id: 'fnb.custom-orders',
      question: 'Do you take custom cake orders?',
      hint: 'Say what you can customise, such as size, flavour or a message.',
    },
    {
      id: 'fnb.notice',
      question: 'How far in advance do I need to order?',
      hint: 'Give the notice you need for regular, custom and large orders.',
    },
    {
      id: 'fnb.delivery-area',
      question: 'Do you deliver, and to which areas?',
      hint: 'Name the areas you cover, or say if you deliver islandwide.',
    },
    {
      id: 'fnb.delivery-fee',
      question: 'How much is delivery?',
      hint: 'Give the fee, and the order amount for free delivery if you have one.',
    },
    {
      id: 'fnb.halal',
      question: 'Are you halal-certified?',
      hint: 'Say whether you are MUIS-certified, or whether you use no pork or lard.',
    },
    {
      id: 'fnb.allergens',
      question: 'Do your products contain nuts or other allergens?',
      hint: 'Name common allergens you use and whether your kitchen handles nuts.',
    },
    {
      id: 'fnb.vegetarian',
      question: 'Do you have vegetarian or eggless options?',
      hint: 'List the vegetarian, vegan or eggless items you offer.',
    },
    {
      id: 'fnb.self-collection',
      question: 'Can I collect my order myself?',
      hint: 'Give the collection address and the times orders can be picked up.',
    },
    {
      id: 'fnb.payment',
      question: 'How can I pay?',
      hint: 'List the ways to pay, such as PayNow, card or cash, and when payment is due.',
    },
    {
      id: 'fnb.bulk-orders',
      question: 'Do you cater for events or bulk orders?',
      hint: 'Say the minimum order and how to ask for a quote.',
    },
    {
      id: 'fnb.shelf-life',
      question: 'How long do your products keep, and how should I store them?',
      hint: 'Say how long items stay fresh and whether they need the fridge.',
    },
    {
      id: 'fnb.dine-in',
      question: 'Do you have seating for dine-in?',
      hint: 'Say whether customers can eat in, and how many seats you have.',
    },
  ],
};

export const INDUSTRY_TEMPLATES: Readonly<Partial<Record<Industry, IndustryTemplate>>> = {
  fnb: FNB,
};

/** A question compared without case, extra spaces or a trailing question mark. */
export function questionKey(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*[?？]+$/, '');
}

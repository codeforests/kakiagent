/** Stored fact values (`facts.value`, ADR-010). Prices are integer cents in SGD. */
export interface ProductValue {
  name: string;
  priceCents: number;
  currency: 'SGD';
  unit?: string | undefined;
  /**
   * From an imported spreadsheet (FEAT-016 D8): stored and shown, never given to the model
   * (architecture Q6); `stockAsOf` is the day the count was imported, `YYYY-MM-DD`.
   */
  sku?: string | undefined;
  stock?: number | undefined;
  stockAsOf?: string | undefined;
}

export interface FaqValue {
  question: string;
  answer: string;
}

export const POLICY_KINDS = ['refund', 'delivery', 'booking', 'payment', 'other'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** A policy (KB-05): its details are a protected value, quoted only through a slot. */
export interface PolicyValue {
  kind: PolicyKind;
  title: string;
  details: string;
}

/** A promotion (KB-05) with an optional price; its validity is on the fact (FEAT-011 D3). */
export interface PromotionValue {
  title: string;
  details: string;
  priceCents?: number | undefined;
  currency?: 'SGD' | undefined;
}

export type GstTreatment = 'inclusive' | 'exclusive' | 'unknown';

/** From `validFrom` (inclusive) until `validUntil` (exclusive); null is open-ended. */
export interface Validity {
  validFrom: Date | null;
  validUntil: Date | null;
}

export const NO_VALIDITY: Validity = { validFrom: null, validUntil: null };

/** A fact as the visitor scope sees it: a row of `visitor_facts`. */
export type VisitorFact =
  | {
      id: string;
      type: 'product';
      version: number;
      value: ProductValue;
      gstTreatment: GstTreatment;
    }
  | { id: string; type: 'faq'; version: number; value: FaqValue; gstTreatment: null }
  | { id: string; type: 'policy'; version: number; value: PolicyValue; gstTreatment: null }
  | {
      id: string;
      type: 'promotion';
      version: number;
      value: PromotionValue;
      gstTreatment: GstTreatment | null;
      /** The exclusive end instant; the last day it runs is the day before, in SGT. */
      validUntil: Date | null;
    };

/** What is stored for a fact (KB-07). Only promotions carry validity by hand. */
export type FactInput =
  | { type: 'product'; value: ProductValue; gstTreatment: GstTreatment; validity?: Validity }
  | { type: 'faq'; value: FaqValue; gstTreatment: null; validity?: Validity }
  | { type: 'policy'; value: PolicyValue; gstTreatment: null; validity?: Validity }
  | {
      type: 'promotion';
      value: PromotionValue;
      gstTreatment: GstTreatment | null;
      validity: Validity;
    };

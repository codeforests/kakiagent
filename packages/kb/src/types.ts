/** Stored fact values (`facts.value`, ADR-010). Prices are integer cents in SGD. */
export interface ProductValue {
  name: string;
  priceCents: number;
  currency: 'SGD';
  unit?: string | undefined;
}

export interface FaqValue {
  question: string;
  answer: string;
}

export type GstTreatment = 'inclusive' | 'exclusive' | 'unknown';

/** A fact as the visitor scope sees it: a row of `visitor_facts`. */
export type VisitorFact =
  | {
      id: string;
      type: 'product';
      version: number;
      value: ProductValue;
      gstTreatment: GstTreatment;
    }
  | { id: string; type: 'faq'; version: number; value: FaqValue; gstTreatment: null };

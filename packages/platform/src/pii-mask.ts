/**
 * Edge PII masking (ADR-015, GOV-04). Walking-skeleton stub: a pass-through with the
 * final signature, so every inbound path already calls it. FEAT-003 replaces the body
 * with NRIC, card and bank-number masking.
 */
export function piiMask(text: string): string {
  return text;
}

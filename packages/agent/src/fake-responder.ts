import type { GenerateRequest } from '@kaki/llm-gateway';

/**
 * What the fake model writes in local development and the E2E suite (plan §2, P10): a
 * slot-correct answer built from the first two facts in the prompt, or "I'll check".
 * It reads the fact lines that `factLine` writes into the tail, so it stays in this module.
 */
export function fakeVisitorResponder(req: GenerateRequest): string {
  const facts = [
    ...(req.tail ?? '').matchAll(/^\[f:([0-9a-f]+)\] (product|faq|policy|promotion)\b(.*)$/gm),
  ].slice(0, 2);
  if (!facts.length)
    return "I'm not sure about that. Let me check with the team and get back to you.";
  const parts = facts.map(([, ref, type, rest = '']) => {
    const slot = (field: string) => `[[f:${ref}.${field}]]`;
    switch (type) {
      case 'faq':
        return slot('answer');
      case 'policy':
        return slot('details');
      case 'promotion': {
        const price = rest.includes('| price:') ? slot('price') : '';
        const until = rest.includes('| until:') ? `until ${slot('valid_until')}` : '';
        const extra = [price, until].filter(Boolean).join(', ');
        return `${slot('title')}: ${slot('details')}${extra ? ` (${extra})` : ''}`;
      }
      default: {
        const unit = rest.includes('| unit:') ? ` (${slot('unit')})` : '';
        return `The ${slot('name')}${unit} is ${slot('price')}.`;
      }
    }
  });
  return parts.join(' ');
}

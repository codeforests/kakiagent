import type { GenerateRequest } from '@kaki/llm-gateway';

/**
 * The fake model's extractor (plan §2, P10): a deterministic reader of the fixture site's
 * patterns, so crawl → extract → review runs end to end without a real model. It answers
 * in the `EXTRACTION_SCHEMA` shape, quoting each line it read:
 * - `Chocolate fudge cake (1 kg) — S$55.00` (optionally `(GST incl.)` / `(before GST)`)
 * - `Q: …` followed by `A: …`
 * - `Refund policy: …` (refund, delivery, booking, payment)
 * - `Promotion: <title> — <details> until YYYY-MM-DD`
 * A real model reads any wording; the extraction evals measure that (FEAT-012 AC-6).
 */
export function fakeExtractScript(req: GenerateRequest): string {
  const page = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lines = page.split('\n').map((l) => l.trim());
  const facts: Record<string, unknown>[] = [];
  const product =
    /^(.+?)(?: \(([^)]+)\))? [—–-] S\$(\d{1,6}(?:\.\d{2})?)(?: \((GST incl\.|incl\. GST|before GST|excl\. GST)\))?$/;
  const policy = /^(Refund|Delivery|Booking|Payment) policy: (.+)$/i;
  const promotion = /^Promotion: (.+?) [—–-] (.+?) until (\d{4}-\d{2}-\d{2})$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = promotion.exec(line))) {
      const price = /S\$(\d+(?:\.\d{2})?)/.exec(m[2]!);
      facts.push({
        type: 'promotion',
        quote: line,
        confidence: 0.9,
        title: m[1],
        details: m[2],
        validUntil: m[3],
        ...(price ? { price: price[1], gst: 'unknown' } : {}),
      });
    } else if ((m = policy.exec(line))) {
      const kind = m[1]!.toLowerCase();
      facts.push({
        type: 'policy',
        quote: line,
        confidence: 0.9,
        kind,
        title: `${m[1]![0]!.toUpperCase()}${kind.slice(1)} policy`,
        details: m[2],
      });
    } else if (line.startsWith('Q: ') && lines[i + 1]?.startsWith('A: ')) {
      const answer = lines[i + 1]!;
      facts.push({
        type: 'faq',
        quote: `${line}\n${answer}`,
        confidence: 0.9,
        question: line.slice(3),
        answer: answer.slice(3),
      });
      i++;
    } else if ((m = product.exec(line))) {
      const gst = m[4] ? (/incl/i.test(m[4]) ? 'inclusive' : 'exclusive') : 'unknown';
      facts.push({
        type: 'product',
        quote: line,
        confidence: 0.9,
        name: m[1],
        price: m[3],
        ...(m[2] ? { unit: m[2] } : {}),
        gst,
      });
    }
  }
  return JSON.stringify({ facts });
}

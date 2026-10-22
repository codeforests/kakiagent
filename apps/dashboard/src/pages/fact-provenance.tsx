import type { Fact } from '@kaki/contracts';
import { Link } from 'react-router';

/**
 * SCR-APP-028's Source section (KB-05; FEAT-012 ui-design): the passage a fact was found
 * in, where, and how sure the extractor was. The quote is text, never HTML.
 */
export function FactProvenance({ fact }: { fact: Fact }) {
  const p = fact.provenance;
  if (!p) return null;
  let place = p.url;
  let domain = '';
  try {
    const u = new URL(p.url);
    domain = u.hostname.replace(/^www\./, '');
    place = p.title ?? (u.pathname === '/' ? domain : u.pathname);
  } catch {
    // An unparsable URL is shown as it is.
  }
  const confidence = fact.confidence === null ? null : Math.round(fact.confidence * 100);
  return (
    <section className="fact-source" aria-labelledby="fact-source-title">
      <h2 className="subsection-title" id="fact-source-title">
        Source
      </h2>
      <blockquote className="passage" data-testid="source-passage">
        {p.quote}
      </blockquote>
      <p className="fact-source__meta">
        From{' '}
        <a href={p.url} target="_blank" rel="noreferrer noopener">
          {place}
          {domain && place !== domain ? ` on ${domain}` : ''}
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {confidence !== null && (
          <span className={confidence < 70 ? 'fact-source__low' : undefined}>
            {' '}
            · {confidence < 70 && <span aria-hidden="true">! </span>}
            {confidence}% confidence
          </span>
        )}
        {' · '}
        <Link to={`/knowledge/sources/${p.sourceId}`}>Open source</Link>
      </p>
    </section>
  );
}

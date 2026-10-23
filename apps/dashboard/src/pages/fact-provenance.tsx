import type { Fact } from '@kaki/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import { locationWords } from '../lib/sources.ts';

/**
 * SCR-APP-028's Source section (KB-05; FEAT-012 ui-design): the passage a fact was found
 * in, where, and how sure the extractor was. The quote is text, never HTML.
 */
export function FactProvenance({ fact }: { fact: Fact }) {
  const p = fact.provenance;
  // A file's name comes from the sources list (FEAT-015); "the file" until it loads, or
  // for a role that can't list sources.
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: api.sources,
    enabled: Boolean(p?.location),
    retry: false,
  });
  if (!p) return null;
  const fileName = p.location
    ? (sources.data?.sources.find((s) => s.id === p.sourceId)?.name ?? 'the file')
    : null;
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
        {p.location ? (
          `${locationWords(p.location)} of ${fileName}`
        ) : (
          <a href={p.url} target="_blank" rel="noreferrer noopener">
            {place}
            {domain && place !== domain ? ` on ${domain}` : ''}
            <span aria-hidden="true"> ↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
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

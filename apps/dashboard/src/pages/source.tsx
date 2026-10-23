import type { Source, SourcePage as Page } from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { updatedLabel } from '../lib/facts.ts';
import { useToast } from '../lib/form.ts';
import {
  busy,
  FAILURE_TEXT,
  PAGE_STATE,
  pageResult,
  sourceSummary,
  useRetry,
  useSource,
  useStatusAnnouncements,
} from '../lib/sources.ts';
import { SourceProgress, SourceState } from './sources.tsx';
import { NoPermission } from './system.tsx';

type PageFilter = Page['status'] | '';

const FILTER_LABEL: Record<PageFilter, string> = {
  '': 'All pages',
  included: 'Read',
  excluded: 'Excluded',
  failed: 'Failed',
  skipped: 'Skipped',
};

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/** SCR-APP-024 Source (KB-01, KB-05, KB-12; FEAT-012 ui-design). */
export function SourcePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const loaded = useSource(id);
  const [toast, setToast] = useToast();
  const [filter, setFilter] = useState<PageFilter>('');
  const [confirming, setConfirming] = useState(false);
  const source = loaded.data?.source;
  const [announced, setAnnounced] = useStatusAnnouncements(source ? [source] : undefined);
  const retry = useRetry((s) => setAnnounced(`Retrying ${s.name}.`));
  const remove = useMutation({
    mutationFn: (s: Source) => api.deleteSource(s.id, s.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      void navigate('/knowledge/sources', { state: { toast: 'Source deleted.' } });
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['sources'] });
        void navigate('/knowledge/sources', {
          state: { toast: 'This source was already deleted.' },
        });
      } else if (err instanceof ApiError && err.status === 409)
        await queryClient.invalidateQueries({ queryKey: ['source', id] });
    },
  });

  if (loaded.error instanceof ApiError && loaded.error.status === 403) return <NoPermission />;
  if (loaded.error instanceof ApiError && loaded.error.status === 404)
    return (
      <EmptyState
        title="This source doesn't exist or was deleted."
        action={
          <Button asChild variant="secondary">
            <Link to="/knowledge/sources">Back to Sources</Link>
          </Button>
        }
      />
    );
  if (loaded.isError && !loaded.data)
    return (
      <ErrorState
        title="We couldn't load this source."
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  if (!loaded.data || !source)
    return (
      <div className="source-page" aria-busy="true" aria-label="Loading source">
        <div className="skeleton-field" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="skeleton-row" />
        ))}
      </div>
    );

  const pages = loaded.data.pages;
  const counts = Object.fromEntries(
    (['included', 'excluded', 'failed', 'skipped'] as const).map((s) => [
      s,
      pages.filter((p) => p.status === s).length,
    ]),
  ) as Record<Page['status'], number>;
  const shown = filter ? pages.filter((p) => p.status === filter) : pages;
  const removeError = remove.error instanceof ApiError ? remove.error : null;

  const onRetry = () =>
    retry.mutate(source, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409)
          setToast('This source has already changed.');
        else setToast("We couldn't retry just now. Nothing was changed.");
      },
    });

  return (
    <div className="source-page">
      <Link className="back-link" to="/knowledge/sources">
        Sources
      </Link>
      <div className="source-page__head">
        <div>
          <h1 className="page-title">{source.name}</h1>
          {source.url && (
            <p className="source-page__meta">
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.url}
                <span aria-hidden="true"> ↗</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          )}
          {source.attestedAt && (
            <p className="source-page__meta">
              Confirmed by you on {updatedLabel(source.attestedAt)}
            </p>
          )}
        </div>
        <SourceState source={source} />
      </div>

      <section className="card source-status" aria-label="Status">
        {busy(source) && (
          <>
            <p className="source-status__stage">{sourceSummary(source)}</p>
            <SourceProgress source={source} />
          </>
        )}
        {source.status === 'ready' && (
          <dl className="source-figures">
            <div>
              <dt>Facts found</dt>
              <dd>
                <Link to={`/knowledge?sourceId=${source.id}`}>{source.counts.facts}</Link>
              </dd>
            </div>
            <div>
              <dt>Need review</dt>
              <dd>
                <Link to="/review">{source.counts.factsNeedingReview}</Link>
              </dd>
            </div>
            <div>
              <dt>Pages read</dt>
              <dd>{source.counts.pagesIncluded}</dd>
            </div>
          </dl>
        )}
        {source.status === 'failed' && (
          <div className="alert alert--danger" role="alert">
            <p>{FAILURE_TEXT[source.failure ?? 'internal']}</p>
            <Button
              variant="secondary"
              onClick={onRetry}
              disabled={retry.isPending}
              aria-busy={retry.isPending || undefined}
            >
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        )}
      </section>

      {source.status === 'ready' && source.counts.facts === 0 && (
        <div className="alert alert--info">
          <p>We didn't find facts on these pages. Add files or type facts in by hand.</p>
          <Link to="/knowledge/facts/new">Add a fact</Link>
        </div>
      )}

      <section className="source-pages" aria-labelledby="pages-title">
        <div className="source-pages__head">
          <h2 className="section-title" id="pages-title">
            Pages
          </h2>
          <label className="field field--inline">
            <span className="sr-only">Show</span>
            <select
              className="input"
              value={filter}
              onChange={(e) => setFilter(e.target.value as PageFilter)}
            >
              <option value="">
                {FILTER_LABEL['']} ({pages.length})
              </option>
              {(['included', 'excluded', 'failed', 'skipped'] as const).map((s) => (
                <option key={s} value={s}>
                  {FILTER_LABEL[s]} ({counts[s]})
                </option>
              ))}
            </select>
          </label>
        </div>
        {counts.skipped > 0 && (
          <div className="alert alert--info">
            <p>
              {counts.skipped} pages were skipped because your plan reads up to {source.pageLimit}{' '}
              pages.
            </p>
          </div>
        )}
        {shown.length === 0 && pages.length > 0 && (
          <EmptyState
            title="No pages match this filter."
            action={
              <Button variant="secondary" onClick={() => setFilter('')}>
                Show all pages
              </Button>
            }
          />
        )}
        {shown.length > 0 && (
          <table className="fact-table page-table" data-testid="page-table">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Result</th>
                <th scope="col" className="page-table__num">
                  Facts
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="page-row" data-testid="page-row">
                  <td className="page-row__title">
                    <a href={p.url} target="_blank" rel="noreferrer noopener">
                      {p.title ?? pathOf(p.url)}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    {p.title && <span className="page-row__path">{pathOf(p.url)}</span>}
                  </td>
                  <td className="page-row__result">
                    <span className={`chip chip--${PAGE_STATE[p.status].tone}`}>
                      {PAGE_STATE[p.status].label}
                    </span>
                    {p.status !== 'included' && (
                      // The chip says Excluded, Failed or Skipped; the text says why.
                      <span className="page-row__reason">
                        {' '}
                        {pageResult(p).replace(/^[^:]+: /, '')}
                      </span>
                    )}
                  </td>
                  <td className="page-row__facts page-table__num">
                    {p.status === 'included' ? p.facts : '—'}
                    <span className="page-row__facts-label"> facts</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="source-page__footer">
        <Button variant="danger-ghost" onClick={() => setConfirming(true)}>
          Delete source…
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (open) return;
          remove.reset();
          setConfirming(false);
        }}
        title={`Delete ${source.name}?`}
        confirmLabel="Delete source"
        confirmVariant="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(source)}
        alert={
          removeError?.code === 'invalid_state' ? (
            <div className="alert alert--warning" role="alert">
              <p>This source is still being read. Try again when it's finished.</p>
            </div>
          ) : removeError?.code === 'version_conflict' ? (
            <div className="alert alert--warning" role="alert">
              <p>This source changed since you opened it. Close this and try again.</p>
            </div>
          ) : remove.isError && removeError?.status !== 404 ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't delete the source just now. Nothing was changed.</p>
            </div>
          ) : null
        }
      >
        <p>
          Its {source.counts.facts} {source.counts.facts === 1 ? 'fact' : 'facts'} will be deleted
          too, including any you approved or edited, and your assistant stops using them straight
          away. The page list is removed. This can't be undone.
        </p>
      </ConfirmDialog>

      <div className="sr-only" aria-live="polite">
        {announced}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

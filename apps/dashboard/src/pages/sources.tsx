import type { Source } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import {
  busy,
  fileTypeOf,
  isImage,
  SOURCE_STATE,
  sourceMeta,
  sourceSummary,
  stageProgress,
  useRetry,
  useSources,
  useStatusAnnouncements,
  waitingToMap,
} from '../lib/sources.ts';
import { KnowledgeTabs } from './knowledge-tabs.tsx';
import { NoPermission } from './system.tsx';

export function SourceState({ source }: { source: Source }) {
  // A spreadsheet waiting for its mapping waits for the owner, not for us (FEAT-016).
  const state = waitingToMap(source)
    ? { label: 'Map columns', tone: 'info' as const }
    : SOURCE_STATE[source.status];
  return (
    <span className={`status-badge status-badge--${state.tone}`}>
      {source.status === 'processing' ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <span className="status-badge__dot" aria-hidden="true" />
      )}
      {state.label}
    </span>
  );
}

/** design.md §4.8 `progress`: determinate with a percentage, or indeterminate. */
export function SourceProgress({ source }: { source: Source }) {
  const p = stageProgress(source);
  return (
    <div className="progress" aria-hidden="true">
      <div
        className={`progress__bar${p ? '' : ' progress__bar--indeterminate'}`}
        style={p ? { width: `${p.percent}%` } : undefined}
      />
    </div>
  );
}

/** SCR-APP-023 Sources (KB-01, KB-12; FEAT-012 ui-design). */
export function SourcesPage() {
  const list = useSources();
  const [toast, setToast] = useToast();
  const sources = list.data?.sources;
  const [announced, setAnnounced] = useStatusAnnouncements(sources);
  const retry = useRetry((s) => setAnnounced(`Retrying ${s.name}.`));
  const [retryFailed, setRetryFailed] = useState(false);
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  if (forbidden) return <NoPermission />;

  const onRetry = (s: Source) => {
    setRetryFailed(false);
    retry.mutate(s, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409)
          setToast('This source has already changed.');
        else setRetryFailed(true);
      },
    });
  };
  const add = (
    <Button asChild>
      <Link to="/knowledge/sources/new">Add sources</Link>
    </Button>
  );

  return (
    <div className="sources">
      <h1 className="page-title">Knowledge</h1>
      <KnowledgeTabs />
      <div className="page-header sources__head">
        <div className="page-header__text">
          <h2 className="section-title">Sources</h2>
          <p className="page-lede">
            Websites and files you add are read page by page. The facts we find wait for your review
            before your assistant uses them.
          </p>
        </div>
        {sources && sources.length > 0 && add}
      </div>

      {retryFailed && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't retry just now. Nothing was changed.</p>
        </div>
      )}

      {list.isPending && (
        <ul className="source-list" aria-busy="true" aria-label="Loading sources">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="skeleton-row" />
          ))}
        </ul>
      )}
      {list.isError && !sources && (
        <ErrorState
          title="We couldn't load your sources."
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {sources && sources.length === 0 && (
        <EmptyState title="No sources yet" action={add}>
          Add your website or upload files, and we'll find your products, prices and policies for
          you to review.
        </EmptyState>
      )}
      {sources && sources.length > 0 && (
        <ul className="source-list" data-testid="source-list">
          {sources.map((s) => (
            <li key={s.id} className="source-row" data-testid="source-row">
              <div className="source-row__main">
                <span className="source-row__icon" aria-hidden="true">
                  <SourceIcon source={s} />
                </span>
                <div className="source-row__text">
                  <Link className="source-row__name" to={`/knowledge/sources/${s.id}`}>
                    {s.name}
                  </Link>
                  <span className="source-row__meta">{sourceMeta(s)}</span>
                </div>
                <SourceState source={s} />
              </div>
              <div className="source-row__detail">
                {busy(s) && <SourceProgress source={s} />}
                <p
                  className={`source-row__summary${s.status === 'failed' ? ' source-row__summary--danger' : ''}`}
                >
                  {sourceSummary(s)}
                </p>
                {waitingToMap(s) && <MapColumns source={s} small />}
                {s.status === 'ready' && s.counts.factsNeedingReview > 0 && (
                  <Link to="/review">Review facts</Link>
                )}
                {s.status === 'failed' && s.retryable && (
                  <Button
                    variant="secondary"
                    className="kaki-btn--sm source-row__retry"
                    onClick={() => onRetry(s)}
                    disabled={retry.isPending && retry.variables?.id === s.id}
                    aria-busy={(retry.isPending && retry.variables?.id === s.id) || undefined}
                    aria-label={`Retry ${s.name}`}
                  >
                    {retry.isPending && retry.variables?.id === s.id ? 'Retrying…' : 'Retry'}
                  </Button>
                )}
                {s.status === 'failed' && !s.retryable && <UploadAgain source={s} small />}
              </div>
            </li>
          ))}
        </ul>
      )}

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

/** A failed file only a new upload fixes (FEAT-015 D7): KB-12's retry action for it. */
export function UploadAgain({ source, small = false }: { source: Source; small?: boolean }) {
  return (
    <Button asChild variant="secondary" className={small ? 'kaki-btn--sm source-row__retry' : ''}>
      <Link to="/knowledge/sources/new#files" aria-label={`Upload again: ${source.name}`}>
        Upload again
      </Link>
    </Button>
  );
}

/** The way to SCR-APP-025 for a spreadsheet waiting at `map` (FEAT-016 ui-design). */
export function MapColumns({ source, small = false }: { source: Source; small?: boolean }) {
  return (
    <Button asChild variant="secondary" className={small ? 'kaki-btn--sm source-row__retry' : ''}>
      <Link to={`/knowledge/sources/${source.id}`} aria-label={`Map columns: ${source.name}`}>
        Map columns
      </Link>
    </Button>
  );
}

export function SourceIcon({ source }: { source: Source }) {
  if (!source.file) return <GlobeIcon />;
  if (source.kind === 'spreadsheet') return <TableIcon />;
  return isImage(fileTypeOf(source.name, source.file.type)) ? <PictureIcon /> : <FileIcon />;
}

const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '2',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function FileIcon() {
  return (
    <svg {...iconProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}

export function TableIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 10h18M3 15h18M9 10v10" />
    </svg>
  );
}

export function PictureIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM21 15l-5-5L5 20M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z" />
    </svg>
  );
}

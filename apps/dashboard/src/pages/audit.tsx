import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  auditQueryOf,
  auditSearchOf,
  filterCount,
  useAuditEntries,
  useAuditEntry,
  useAuditFilters,
  detailState,
  without,
  type AuditFilter,
} from '../lib/audit.ts';
import { useToast } from '../lib/form.ts';
import {
  AuditExportDialog,
  AuditFiltersBar,
  AuditTable,
  ConversationChip,
  EntryDetail,
  FiltersSheet,
  VerifyCard,
} from './audit-parts.tsx';
import { Glyph } from './conversation-parts.tsx';

/**
 * `/settings/audit`: SCR-APP-050 Audit log (GOV-01, GOV-02, UC-32; FEAT-060 ui-design), Owner
 * and Admin. Filters live in the URL; "Load more" pages newest first; an entry opens in a
 * slide-over; Verify and Export sit above. No live updates: it refetches on window focus and
 * after a verify or an export.
 */
export function AuditPage() {
  const [search, setSearch] = useSearchParams();
  const filter = auditQueryOf(search);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const allowed = me.data ? me.data.role === 'owner' || me.data.role === 'admin' : undefined;
  const list = useAuditEntries(filter, allowed === true);
  const members = useAuditFilters(allowed === true).data?.members ?? [];
  const rows = list.data?.pages.flatMap((p) => p.entries) ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const loaded = open === null ? undefined : rows.find((r) => r.seq === open);
  const entry = useAuditEntry(open, loaded);
  const [exporting, setExporting] = useState(false);
  const [sheet, setSheet] = useState(false);
  const exportButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openEntry = (seq: number) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(seq);
  };
  const [toast, setToast] = useToast();
  const now = new Date();

  const go = (f: AuditFilter) => setSearch(auditSearchOf(f), { replace: true });
  const n = filterCount(filter);
  const forbidden =
    allowed === false || (list.error instanceof ApiError && list.error.status === 403);

  const header = (
    <>
      <nav aria-label="Breadcrumb">
        <ol className="email-breadcrumb">
          <li>
            <Link to="/settings">Settings</Link>
          </li>
          <li aria-current="page">Audit log</li>
        </ol>
      </nav>
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Audit log</h1>
          <p className="page-lede">
            Every decision the assistant made and every change your team made. Entries can't be
            edited or deleted.
          </p>
        </div>
        {allowed && (
          <Button ref={exportButton} variant="secondary" onClick={() => setExporting(true)}>
            <Glyph name="download" /> Export
          </Button>
        )}
      </div>
    </>
  );

  if (forbidden)
    return (
      <div className="audit">
        {header}
        <EmptyState title="You don't have access to this page">
          Only the Owner and Admins can see the audit log.
        </EmptyState>
      </div>
    );

  const bar = (prefix: string) => (
    <AuditFiltersBar filter={filter} members={members} onChange={go} idPrefix={prefix} now={now} />
  );
  const clearFilters = () => go({});

  return (
    <div className="audit">
      {header}
      {allowed && <VerifyCard onShowEntry={openEntry} />}

      <div className="audit-filters-row">
        <div className="audit-filters-inline">{bar('audit-filter')}</div>
        <Button variant="secondary" className="audit-filters-toggle" onClick={() => setSheet(true)}>
          {n > 0 ? `Filters (${n})` : 'Filters'}
        </Button>
        {filter.conversation && (
          <ConversationChip
            id={filter.conversation}
            onClear={() => go(without(filter, 'conversation'))}
          />
        )}
        {n > 0 && (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>
      <FiltersSheet open={sheet} onOpenChange={setSheet}>
        {bar('audit-sheet')}
      </FiltersSheet>

      {(list.isPending || allowed === undefined) && (
        <div className="fact-table" aria-busy="true" aria-label="Loading the audit log">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      )}
      {list.isError && (
        <ErrorState
          title="Couldn't load the audit log"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {list.isSuccess && rows.length === 0 && n === 0 && (
        <EmptyState title="No entries yet">
          Decisions and changes appear here as they happen.
        </EmptyState>
      )}
      {list.isSuccess && rows.length === 0 && n > 0 && (
        <EmptyState
          title="No entries match these filters"
          action={
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      )}
      {rows.length > 0 && <AuditTable rows={rows} now={now} onOpen={openEntry} />}
      {list.hasNextPage && (
        <div className="load-more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage || undefined}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <EntryDetail
        seq={open}
        row={loaded ?? entry.data}
        state={detailState(loaded ?? entry.data, entry)}
        onClose={() => setOpen(null)}
        returnTo={opener}
      />
      {allowed && (
        <AuditExportDialog
          open={exporting}
          onOpenChange={setExporting}
          filter={filter}
          members={members}
          returnTo={exportButton}
          onToast={setToast}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

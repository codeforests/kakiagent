import {
  SHEET_FIELDS,
  type ColumnMapping,
  type ImportPreview,
  type PreviewRow,
  type SheetField,
  type SheetGst,
  type SheetLayout,
  type Source,
  type SourcePage as Page,
} from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { sgd, updatedLabel } from '../lib/facts.ts';
import { Field } from '../lib/field.tsx';
import { describedBy, useToast } from '../lib/form.ts';
import {
  busy,
  FILE_TYPE_LABEL,
  failureText,
  fileTypeOf,
  pageLabel,
  ROW_REASON_TEXT,
  SHEET_FIELD_LABEL,
  sizeLabel,
  STAGE_LABEL,
  useRetry,
  useStatusAnnouncements,
  waitingToMap,
  type SheetRowReason,
} from '../lib/sources.ts';
import { SourceProgress, SourceState, UploadAgain } from './sources.tsx';

type Draft = Record<SheetField, number | ''>;
type Errors = Partial<Record<SheetField | 'name' | 'gst', string>>;

const GST_OPTIONS: [SheetGst, string][] = [
  ['inclusive', 'Yes, prices include GST'],
  ['exclusive', 'No, GST is added on top'],
  ['unknown', 'Not sure'],
];
const ROWS_LIMIT = 2000;
const SAMPLE_CHARS = 40;

const draftOf = (columns: ColumnMapping): Draft =>
  Object.fromEntries(SHEET_FIELDS.map((f) => [f, columns[f] ?? ''])) as Draft;
const mappingOf = (draft: Draft): ColumnMapping =>
  Object.fromEntries(SHEET_FIELDS.flatMap((f) => (draft[f] === '' ? [] : [[f, draft[f]]])));
const cellsText = (cells: string[]) => cells.filter((c) => c !== '').join(' · ');
const reasonText = (reason: string | null) =>
  reason ? (ROW_REASON_TEXT[reason as SheetRowReason] ?? reason) : '';
const short = (s: string) => (s.length > SAMPLE_CHARS ? `${s.slice(0, SAMPLE_CHARS - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The browser's checks of a mapping, in the words of the ui-design (design.md §4.2). */
function validate(draft: Draft, gst: SheetGst | ''): Errors {
  const errors: Errors = {};
  if (draft.product === '' && draft.service === '')
    errors.product = 'Choose the column with the product or service names';
  if (draft.price === '') errors.price = 'Choose the column with the prices';
  const used = new Map<number, SheetField>();
  for (const f of SHEET_FIELDS) {
    const i = draft[f];
    if (i === '') continue;
    const before = used.get(i);
    if (before) errors[f] = `This column is already used for ${SHEET_FIELD_LABEL[before]}`;
    else used.set(i, f);
  }
  if (!gst) errors.gst = 'Choose whether the prices include GST';
  return errors;
}

/**
 * SCR-APP-025 Spreadsheet import (KB-03, KB-15, KB-16, UC-10; FEAT-016 ui-design): the
 * spreadsheet's state; at `map`, the column mapping, the GST choice and the preview, and
 * the confirm that imports (and approves) what the preview showed.
 */
export function SpreadsheetPage({ source, pages }: { source: Source; pages: Page[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [confirming, setConfirming] = useState(false);
  const [announced, setAnnounced] = useStatusAnnouncements([source]);
  const retry = useRetry((s) => setAnnounced(`Retrying ${s.name}.`));
  const remove = useMutation({
    mutationFn: (s: Source) => api.deleteSource(s.id, s.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      void navigate('/knowledge/sources', { state: { toast: 'Spreadsheet deleted.' } });
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['sources'] });
        void navigate('/knowledge/sources', {
          state: { toast: 'This spreadsheet was already deleted.' },
        });
      } else if (err instanceof ApiError && err.status === 409)
        await queryClient.invalidateQueries({ queryKey: ['source', source.id] });
    },
  });
  const removeError = remove.error instanceof ApiError ? remove.error : null;
  const file = source.file;
  const type = file ? fileTypeOf(source.name, file.type) : null;
  const sheet = source.sheet;

  const onRetry = () =>
    retry.mutate(source, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409)
          setToast('This spreadsheet has already changed.');
        else setToast("We couldn't retry just now. Nothing was changed.");
      },
    });

  return (
    <div className="source-page sheet-page">
      <Link className="back-link" to="/knowledge/sources">
        Sources
      </Link>
      <div className="source-page__head">
        <div>
          <h1 className="page-title">{source.name}</h1>
          {file && (
            <p className="source-page__meta">
              {[
                ...(type ? [FILE_TYPE_LABEL[type]] : []),
                sizeLabel(file.sizeBytes),
                `Uploaded ${updatedLabel(source.createdAt)}`,
              ].join(' · ')}
            </p>
          )}
          {file?.scannedAt && (
            <p className="source-page__meta source-page__clean">
              <CheckIcon /> Checked for malware: none found
            </p>
          )}
        </div>
        <SourceState source={source} />
      </div>

      {busy(source) && (
        <section className="card source-status" aria-label="Status">
          {sheet?.mapping && (source.stage === 'import' || source.stage === 'promote') && (
            <MappingSummary sheet={sheet} />
          )}
          <p className="source-status__stage">
            {source.stage ? STAGE_LABEL[source.stage] : 'Waiting'}
          </p>
          <SourceProgress source={source} />
          <p className="sheet-page__note">
            {source.stage === 'import' || source.stage === 'promote'
              ? 'This takes under a minute for most price lists.'
              : "We'll show you the columns as soon as the sheet is read."}
          </p>
        </section>
      )}

      {waitingToMap(source) && sheet && (
        <MappingForm
          source={source}
          sheet={sheet}
          onDelete={() => setConfirming(true)}
          onAnnounce={setAnnounced}
        />
      )}

      {source.status === 'ready' && sheet && (
        <Imported source={source} sheet={sheet} pages={pages} />
      )}

      {source.status === 'failed' && (
        <div className="alert alert--danger" role="alert">
          <p>{failureText(source)}</p>
          {source.retryable ? (
            <Button
              variant="secondary"
              onClick={onRetry}
              disabled={retry.isPending}
              aria-busy={retry.isPending || undefined}
            >
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          ) : (
            <UploadAgain source={source} />
          )}
        </div>
      )}

      {!waitingToMap(source) && (
        <div className="source-page__footer sheet-page__footer">
          {source.status === 'ready' && (
            <Link to={`/knowledge?sourceId=${source.id}`}>See imported facts</Link>
          )}
          <Button variant="danger-ghost" onClick={() => setConfirming(true)}>
            Delete spreadsheet…
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (open) return;
          remove.reset();
          setConfirming(false);
        }}
        title={`Delete ${source.name}?`}
        confirmLabel="Delete spreadsheet"
        confirmVariant="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(source)}
        alert={
          removeError?.code === 'invalid_state' ? (
            <div className="alert alert--warning" role="alert">
              <p>This spreadsheet is still being read. Try again when it's finished.</p>
            </div>
          ) : removeError?.code === 'version_conflict' ? (
            <div className="alert alert--warning" role="alert">
              <p>This spreadsheet changed since you opened it. Close this and try again.</p>
            </div>
          ) : remove.isError && removeError?.status !== 404 ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't delete the spreadsheet just now. Nothing was changed.</p>
            </div>
          ) : null
        }
      >
        {source.counts.facts > 0 ? (
          <p>
            Its {plural(source.counts.facts, 'fact')} will be deleted too, including any you edited,
            and your assistant stops using them straight away. The file is deleted from our storage.
            This can't be undone.
          </p>
        ) : (
          <p>Nothing has been imported from it yet. The file is deleted from our storage.</p>
        )}
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

/** The mapping and GST choice, the preview, and the confirm (the `map` state). */
function MappingForm({
  source,
  sheet,
  onDelete,
  onAnnounce,
}: {
  source: Source;
  sheet: SheetLayout;
  onDelete: () => void;
  onAnnounce: (said: string) => void;
}) {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.businessProfile(),
    retry: false,
  });
  // No profile yet counts as registered, as the server does (KB-15).
  const registered = profile.data?.profile?.gstRegistered ?? true;
  const [draft, setDraft] = useState<Draft>(() => draftOf(sheet.suggested.columns));
  const [picked, setGst] = useState<SheetGst | ''>(sheet.suggested.gst ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // A business not registered for GST shows its prices as they are: "Yes" by default.
  const gst: SheetGst | '' = picked || (profile.data && !registered ? 'inclusive' : '');

  const choice = () => ({ mapping: mappingOf(draft), gst: gst as SheetGst });
  const previewing = useMutation({
    mutationFn: () => api.previewImport(source.id, choice()),
    onSuccess: (p) => {
      setPreview(p);
      onAnnounce(`${plural(p.importable, 'row')} will be imported, ${p.rejected} can't be.`);
    },
    onError: (err) => void onConflict(err),
  });
  const importing = useMutation({
    mutationFn: () => api.confirmImport(source.id, { ...choice(), version: source.version }),
    onSuccess: async ({ source: s }) => {
      setConfirming(false);
      queryClient.setQueryData(['source', s.id], (d: { source: Source } | undefined) =>
        d ? { ...d, source: s } : d,
      );
      await queryClient.invalidateQueries({ queryKey: ['source', s.id] });
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (err) => {
      setConfirming(false);
      void onConflict(err);
    },
  });

  /** Another tab changed the import: reload it (409); else the error shows inline. */
  async function onConflict(err: unknown) {
    if (err instanceof ApiError && err.status === 409) {
      setNotice("This import changed in another tab. We've reloaded it.");
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: ['source', source.id] });
    }
  }

  const change = (f: SheetField, value: string) => {
    setDraft((d) => ({ ...d, [f]: value === '' ? '' : Number(value) }));
    setPreview(null);
    previewing.reset();
  };
  const submit = () => {
    const found = validate(draft, gst);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length) {
      setPreview(null);
      requestAnimationFrame(() => alertRef.current?.focus());
      return;
    }
    previewing.mutate();
  };
  const serverError =
    previewing.error instanceof ApiError && previewing.error.code === 'bad_mapping'
      ? previewing.error.message
      : null;
  const errorList = Object.entries(errors) as [SheetField | 'gst', string][];
  const where = sheet.name ? `from the sheet "${sheet.name}"` : 'from the file';

  return (
    <div className="sheet-map">
      {notice && (
        <div className="alert alert--info" role="status">
          <p>{notice}</p>
        </div>
      )}
      {(errorList.length > 0 || serverError) && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={alertRef}>
          {serverError ? (
            <p>{serverError}</p>
          ) : (
            <>
              <p className="alert__title">Check the mapping</p>
              <ul>
                {errorList.map(([f, message]) => (
                  <li key={f}>
                    <a href={`#map-${f}`}>{message}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <section className="card stack" aria-labelledby="map-title">
        <h2 className="subsection-title" id="map-title">
          Match your columns
        </h2>
        <p className="sheet-page__note">
          We read {plural(sheet.rows, 'row')} {where}, starting at row {sheet.headerRow + 1}. Check
          each column we matched, then preview the import.
        </p>
        {sheet.rowsSkipped > 0 && (
          <div className="alert alert--warning">
            <p>
              Only the first {ROWS_LIMIT.toLocaleString('en-SG')} rows are imported.{' '}
              {plural(sheet.rowsSkipped, 'row')} after that weren't read.
            </p>
          </div>
        )}
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {SHEET_FIELDS.map((f) => {
            const id = `map-${f}`;
            const suggested =
              sheet.suggested.columns[f] !== undefined && draft[f] === sheet.suggested.columns[f];
            const help =
              f === 'product' || f === 'service'
                ? 'Choose at least one. A row uses the product name, or the service name when it has none.'
                : f === 'stock'
                  ? "Stock is saved with today's date. Your assistant doesn't tell customers stock counts."
                  : null;
            const helpText = [suggested ? 'Suggested from your sheet.' : null, help]
              .filter(Boolean)
              .join(' ');
            return (
              <Field
                key={f}
                id={id}
                label={f === 'price' ? `${SHEET_FIELD_LABEL[f]} (required)` : SHEET_FIELD_LABEL[f]}
                error={errors[f]}
                help={helpText || undefined}
              >
                <select
                  id={id}
                  className="input"
                  value={draft[f] === '' ? '' : String(draft[f])}
                  onChange={(e) => change(f, e.target.value)}
                  aria-invalid={errors[f] ? true : undefined}
                  aria-describedby={describedBy(id, errors[f], Boolean(helpText))}
                  data-testid={`map-${f}`}
                >
                  <option value="">Not in this sheet</option>
                  {sheet.columns.map((c) => (
                    <option key={c.index} value={c.index}>
                      {c.header || `Column ${c.index + 1}`}
                      {c.samples[0] ? ` — e.g. ${short(c.samples[0])}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            );
          })}
          <fieldset
            className="radio-group"
            id="map-gst"
            aria-describedby={describedBy('map-gst', errors.gst, true)}
          >
            <legend className="field__label">Do these prices include GST?</legend>
            {GST_OPTIONS.map(([value, label]) => (
              <label className="radio" key={value}>
                <input
                  type="radio"
                  name="gst"
                  checked={gst === value}
                  onChange={() => {
                    setGst(value);
                    setPreview(null);
                    previewing.reset();
                  }}
                />
                {label}
              </label>
            ))}
            <p className="field__help" id="map-gst-help">
              {registered
                ? "If you're not sure, your assistant won't quote these prices until you set their GST treatment."
                : "Your business profile says you're not GST-registered, so customers see these prices as they are."}
            </p>
            {errors.gst && (
              <p className="field__error" id="map-gst-error">
                <span aria-hidden="true">!</span> {errors.gst}
              </p>
            )}
          </fieldset>
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={previewing.isPending}
              aria-busy={previewing.isPending || undefined}
            >
              {previewing.isPending ? 'Previewing…' : 'Preview import'}
            </Button>
          </div>
        </form>
      </section>

      {previewing.isError &&
        !serverError &&
        !(previewing.error instanceof ApiError && previewing.error.status === 409) && (
          <div className="alert alert--danger" role="alert">
            <p>We couldn't preview the import. Try again.</p>
            <Button variant="secondary" onClick={() => previewing.mutate()}>
              Try again
            </Button>
          </div>
        )}

      {preview && (
        <PreviewResult
          preview={preview}
          mapping={mappingOf(draft)}
          importing={importing.isPending}
          onImport={() => setConfirming(true)}
        />
      )}

      <div className="source-page__footer">
        <Button variant="danger-ghost" onClick={onDelete}>
          Delete spreadsheet…
        </Button>
      </div>

      {preview && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
          title={`Import ${plural(preview.importable, 'row')}?`}
          confirmLabel={`Import ${plural(preview.importable, 'row')}`}
          busy={importing.isPending}
          onConfirm={() => importing.mutate()}
          alert={
            importing.isError &&
            !(importing.error instanceof ApiError && importing.error.status === 409) ? (
              <div className="alert alert--danger" role="alert">
                <p>We couldn't import just now. Nothing was changed.</p>
              </div>
            ) : null
          }
        >
          <p>
            They're approved as you import them, so your assistant can use them straight away
            {preview.conflicts > 0
              ? `, except the ${preview.conflicts} that disagree with facts you have`
              : preview.gstReview > 0
                ? `, except ${plural(preview.gstReview, 'price')} waiting for their GST treatment`
                : ''}
            . Rows that can't be imported are listed on this page afterwards.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function PreviewResult({
  preview: p,
  mapping,
  importing,
  onImport,
}: {
  preview: ImportPreview;
  mapping: ColumnMapping;
  importing: boolean;
  onImport: () => void;
}) {
  const shown = (['unit', 'sku', 'stock'] as const).filter((f) => mapping[f] !== undefined);
  return (
    <section className="sheet-preview stack" aria-labelledby="preview-title" data-testid="preview">
      <div className="card stack">
        <h2 className="sheet-preview__title" id="preview-title">
          {plural(p.importable, 'row')} will be imported
        </h2>
        <ul className="sheet-preview__lines">
          {p.rejected > 0 && <li>{plural(p.rejected, 'row')} can't be imported (listed below)</li>}
          {(p.empty > 0 || p.duplicates > 0) && (
            <li>
              {[
                ...(p.empty ? [plural(p.empty, 'empty row')] : []),
                ...(p.duplicates ? [plural(p.duplicates, 'repeated row')] : []),
              ].join(' and ')}{' '}
              will be skipped
            </li>
          )}
          {p.existing > 0 && (
            <li>
              {plural(p.existing, 'row')} match facts you already have and won't be added again
            </li>
          )}
          {p.conflicts > 0 && (
            <li className="sheet-preview__warning">
              <span aria-hidden="true">! </span>
              {plural(p.conflicts, 'row')} disagree with facts you already have. They'll be held
              back until you resolve them in Review → Conflicts.
            </li>
          )}
          {p.gstReview > 0 && (
            <li className="sheet-preview__warning">
              <span aria-hidden="true">! </span>
              {plural(p.gstReview, 'price')} wait for their GST treatment before your assistant uses
              them.
            </li>
          )}
        </ul>
        <p>Importing approves these rows: your assistant can use them straight away.</p>
      </div>

      {p.sample.length > 0 && (
        <table className="fact-table page-table" data-testid="preview-table">
          <caption className="sheet-preview__caption">
            First {plural(p.sample.length, 'row')} to import
          </caption>
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Name</th>
              <th scope="col">Price</th>
              {shown.map((f) => (
                <th scope="col" key={f}>
                  {f === 'unit' ? 'Unit' : f === 'sku' ? 'SKU' : 'Stock'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.sample.map((r) => (
              <PreviewLine key={r.row} row={r} shown={shown} />
            ))}
          </tbody>
        </table>
      )}

      {p.rejects.length > 0 && (
        <section aria-labelledby="rejects-title">
          <h3 className="subsection-title" id="rejects-title">
            Rows we can't import ({p.rejected})
          </h3>
          <table className="fact-table page-table" data-testid="rejects-table">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Reason</th>
                <th scope="col">Row contents</th>
              </tr>
            </thead>
            <tbody>
              {p.rejects.map((r) => (
                <tr key={r.row} className="page-row" data-testid="reject-row">
                  <td>Row {r.row}</td>
                  <td>{reasonText(r.reason)}</td>
                  <td className="sheet-row__cells" title={cellsText(r.cells)}>
                    {cellsText(r.cells)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.rejected > p.rejects.length && (
            <p className="sheet-page__note">Showing the first {p.rejects.length}.</p>
          )}
        </section>
      )}

      {p.importable === 0 ? (
        <div className="alert alert--danger" role="alert">
          <p>
            None of the rows can be imported with this mapping. Check the Price and name columns.
          </p>
        </div>
      ) : null}
      <div>
        <Button
          className="sheet-preview__import"
          onClick={onImport}
          disabled={p.importable === 0 || importing}
          aria-busy={importing || undefined}
        >
          Import {plural(p.importable, 'row')}
        </Button>
      </div>
    </section>
  );
}

function PreviewLine({
  row: r,
  shown,
}: {
  row: PreviewRow;
  shown: readonly ('unit' | 'sku' | 'stock')[];
}) {
  const f = r.fact!;
  return (
    <tr className="page-row" data-testid="preview-row">
      <td>Row {r.row}</td>
      <td className="page-row__title">
        {f.name}
        {r.conflict && <span className="chip chip--warning"> Conflict</span>}
      </td>
      <td className="page-table__num">{sgd(f.price)}</td>
      {shown.map((k) => (
        <td key={k}>{f[k] ?? '—'}</td>
      ))}
    </tr>
  );
}

/** The mapping as confirmed, read-only: "Price: Price (incl. GST)". */
function MappingSummary({ sheet }: { sheet: SheetLayout }) {
  const m = sheet.mapping!;
  const header = (i: number) => sheet.columns[i]?.header || `Column ${i + 1}`;
  return (
    <dl className="sheet-mapping" data-testid="mapping-summary">
      {SHEET_FIELDS.filter((f) => m.columns[f] !== undefined).map((f) => (
        <div key={f}>
          <dt>{SHEET_FIELD_LABEL[f]}</dt>
          <dd>{header(m.columns[f]!)}</dd>
        </div>
      ))}
      <div>
        <dt>GST</dt>
        <dd>{GST_OPTIONS.find(([v]) => v === m.gst)![1]}</dd>
      </div>
    </dl>
  );
}

type RowFilter = '' | 'included' | 'failed' | 'excluded';
const ROW_FILTER: Record<RowFilter, string> = {
  '': 'All rows',
  included: 'Imported',
  failed: 'Not imported',
  excluded: 'Skipped',
};
const ROW_CHIP: Record<Exclude<RowFilter, ''>, { label: string; tone: string }> = {
  included: { label: 'Imported', tone: 'success' },
  failed: { label: 'Not imported', tone: 'danger' },
  excluded: { label: 'Skipped', tone: 'neutral' },
};

/** The done state: what was imported, and every row's result. */
function Imported({ source, sheet, pages }: { source: Source; sheet: SheetLayout; pages: Page[] }) {
  const c = source.counts;
  const [filter, setFilter] = useState<RowFilter>(() => (c.pagesFailed > 0 ? 'failed' : ''));
  const rows = pages.filter((p) => p.status !== 'skipped');
  const shown = filter ? rows.filter((p) => p.status === filter) : rows;
  // What still waits: conflicted rows (KB-06) and prices without a GST treatment (KB-15).
  const held = (q: { status?: 'conflicted'; gst?: 'unknown' }) => ({
    queryKey: ['facts', 'sheet-held', source.id, q],
    queryFn: () => api.facts({ sourceId: source.id, limit: 200, ...q }),
  });
  const conflicted = useQuery(held({ status: 'conflicted' })).data?.facts.length ?? 0;
  const gstUnknown = useQuery(held({ gst: 'unknown' })).data?.facts.length ?? 0;
  return (
    <>
      <div className="alert alert--success" role="status">
        <p className="alert__title">{plural(c.facts, 'row')} imported</p>
        <p>They're approved and your assistant can use them now.</p>
        {conflicted > 0 && (
          <p>
            {conflicted} disagree with facts you already have: resolve them in{' '}
            <Link to="/review/conflicts">Review → Conflicts</Link>.
          </p>
        )}
        {gstUnknown > 0 && (
          <p>
            <Link to="/knowledge?gst=unknown">
              {plural(gstUnknown, 'price')} wait for their GST treatment.
            </Link>
          </p>
        )}
      </div>
      <section className="card source-status" aria-label="Results">
        <dl className="source-figures">
          <div>
            <dt>Imported</dt>
            <dd>{c.pagesIncluded}</dd>
          </div>
          <div>
            <dt>Not imported</dt>
            <dd>{c.pagesFailed}</dd>
          </div>
          <div>
            <dt>Skipped</dt>
            <dd>{c.pagesExcluded + sheet.rowsSkipped}</dd>
          </div>
        </dl>
      </section>

      <section className="source-pages" aria-labelledby="rows-title">
        <div className="source-pages__head">
          <h2 className="section-title" id="rows-title">
            Rows
          </h2>
          <label className="field field--inline">
            <span className="sr-only">Show</span>
            <select
              className="input"
              value={filter}
              onChange={(e) => setFilter(e.target.value as RowFilter)}
              data-testid="row-filter"
            >
              {(Object.keys(ROW_FILTER) as RowFilter[]).map((f) => (
                <option key={f} value={f}>
                  {ROW_FILTER[f]} ({f ? rows.filter((p) => p.status === f).length : rows.length})
                </option>
              ))}
            </select>
          </label>
        </div>
        {shown.length === 0 ? (
          <EmptyState
            title="No rows match this filter."
            action={
              <Button variant="secondary" onClick={() => setFilter('')}>
                Show all rows
              </Button>
            }
          />
        ) : (
          <table className="fact-table page-table" data-testid="row-table">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Result</th>
                <th scope="col">Row contents</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const chip = ROW_CHIP[p.status as Exclude<RowFilter, ''>];
                return (
                  <tr key={p.id} className="page-row" data-testid="sheet-row">
                    <td className="page-row__title">{pageLabel(p.url) ?? p.url}</td>
                    <td className="page-row__result">
                      <span className={`chip chip--${chip.tone}`}>{chip.label}</span>
                      {p.reason && (
                        <span className="page-row__reason"> {reasonText(p.reason)}</span>
                      )}
                    </td>
                    <td className="sheet-row__cells" title={cellsText(p.cells ?? [])}>
                      {cellsText(p.cells ?? [])}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {sheet.mapping && (
        <section className="sheet-columns" aria-labelledby="columns-title">
          <h2 className="subsection-title" id="columns-title">
            Columns used
          </h2>
          <MappingSummary sheet={sheet} />
        </section>
      )}
    </>
  );
}

function CheckIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

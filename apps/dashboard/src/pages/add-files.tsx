import { FILE_EXTENSIONS, MAX_FILE_BYTES, type Source } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError, putFile } from '../lib/api.ts';
import {
  fileTypeOf,
  isImage,
  sizeLabel,
  sourceSummary,
  useSources,
  useStatusAnnouncements,
} from '../lib/sources.ts';
import { FileIcon, PictureIcon, SourceState } from './sources.tsx';

/** Files upload two at a time (FEAT-015 ui-design); the rest wait. */
const AT_ONCE = 2;

type Refusal = 'type' | 'size' | 'empty' | 'limit';
const REFUSAL_TEXT: Record<Refusal, string> = {
  type: 'Not a file type we can read',
  size: 'Over 25 MB',
  empty: 'This file is empty',
  limit: "Your plan's file limit is reached",
};
const REFUSAL_SAID: Record<Refusal, string> = {
  type: 'not a file type we can read',
  size: 'it is over 25 MB',
  empty: 'it is empty',
  limit: "your plan's file limit is reached",
};

type Row =
  | { key: number; file: File; state: 'refused'; refusal: Refusal }
  | { key: number; file: File; state: 'waiting' }
  | { key: number; file: File; state: 'uploading'; percent: number }
  | { key: number; file: File; state: 'added'; sourceId: string }
  | { key: number; file: File; state: 'failed' };

/** The browser's checks before anything is sent (the server checks again, the scan too). */
function refusalOf(file: File): Refusal | null {
  const name = file.name.toLowerCase();
  if (!FILE_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'type';
  if (file.size > MAX_FILE_BYTES) return 'size';
  if (file.size === 0) return 'empty';
  return null;
}

/**
 * SCR-APP-007's files part (KB-02, KB-11, UC-10; FEAT-015 ui-design): choose or drop
 * files; each is checked in the browser, then uploaded (presign → PUT with progress →
 * create the source) two at a time. An added file's row follows its source until it is
 * ready or failed. Leaving while files upload asks first.
 */
export function AddFilesForm() {
  const queryClient = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  /** Rows whose upload has started, so a re-run effect never starts one twice. */
  const started = useRef(new Set<number>());
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const [said, setSaid] = useState('');
  const list = useSources();
  const fileLimit = list.data?.fileLimit;
  const fileSources = list.data?.sources.filter((s) => s.kind === 'file') ?? [];
  const byId = new Map(fileSources.map((s) => [s.id, s]));
  const addedSources = rows.flatMap((r) =>
    r.state === 'added' && byId.has(r.sourceId) ? [byId.get(r.sourceId)!] : [],
  );
  const [statusSaid] = useStatusAnnouncements(addedSources.length ? addedSources : undefined);

  const update = (key: number, row: Partial<Row> & Pick<Row, 'state'>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? ({ ...r, ...row } as Row) : r)));

  const upload = useCallback(
    async (row: Row) => {
      const { key, file } = row;
      update(key, { state: 'uploading', percent: 0 });
      try {
        const ticket = await api.requestUpload({ fileName: file.name, sizeBytes: file.size });
        await putFile(ticket, file, (percent) => update(key, { state: 'uploading', percent }));
        let source: Source | null = null;
        try {
          ({ source } = await api.createSource({
            kind: 'file',
            uploadId: ticket.uploadId,
            fileName: file.name,
            sizeBytes: file.size,
          }));
        } catch (err) {
          // A double submit: the source exists, so the file is added.
          if (!(err instanceof ApiError && err.code === 'source_exists')) throw err;
          update(key, { state: 'added', sourceId: String(err.details.sourceId) });
        }
        if (source) update(key, { state: 'added', sourceId: source.id });
        setSaid(`${file.name} added. We'll check it and read it.`);
        await queryClient.invalidateQueries({ queryKey: ['sources'] });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'file_limit_reached') {
          // The limit stops the queue: nothing else waiting can be added.
          setRows((rs) =>
            rs.map((r) =>
              r.key === key || r.state === 'waiting'
                ? { key: r.key, file: r.file, state: 'refused', refusal: 'limit' }
                : r,
            ),
          );
          setSaid(`${file.name} can't be uploaded: ${REFUSAL_SAID.limit}.`);
        } else if (err instanceof ApiError && err.code === 'unsupported_type') {
          update(key, { state: 'refused', refusal: 'type' });
          setSaid(`${file.name} can't be uploaded: ${REFUSAL_SAID.type}.`);
        } else if (err instanceof ApiError && err.code === 'file_too_large') {
          update(key, { state: 'refused', refusal: 'size' });
          setSaid(`${file.name} can't be uploaded: ${REFUSAL_SAID.size}.`);
        } else {
          update(key, { state: 'failed' });
          setSaid(`${file.name}: upload failed.`);
        }
      }
    },
    [queryClient],
  );

  // Starts waiting files while fewer than two are uploading.
  useEffect(() => {
    const uploading = rows.filter(
      (r) => started.current.has(r.key) && (r.state === 'waiting' || r.state === 'uploading'),
    ).length;
    const waiting = rows
      .filter((r) => r.state === 'waiting' && !started.current.has(r.key))
      .slice(0, AT_ONCE - uploading);
    for (const r of waiting) {
      started.current.add(r.key);
      void upload(r);
    }
  }, [rows, upload]);

  // Leaving mid-upload loses the file; files already added keep going on the server.
  const inFlight = rows.some((r) => r.state === 'uploading' || r.state === 'waiting');
  useEffect(() => {
    if (!inFlight) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inFlight]);

  const choose = (files: FileList | null) => {
    if (!files?.length) return;
    let room =
      fileLimit === undefined
        ? Infinity
        : fileLimit -
          fileSources.length -
          rows.filter((r) => r.state === 'waiting' || r.state === 'uploading').length;
    const added: Row[] = [];
    const refused: string[] = [];
    for (const file of files) {
      const key = nextKey.current++;
      let refusal = refusalOf(file);
      if (!refusal && room <= 0) refusal = 'limit';
      if (refusal) {
        added.push({ key, file, state: 'refused', refusal });
        refused.push(`${file.name} can't be uploaded: ${REFUSAL_SAID[refusal]}.`);
      } else {
        room--;
        added.push({ key, file, state: 'waiting' });
      }
    }
    setRows((rs) => [...rs, ...added]);
    if (refused.length) setSaid(refused.join(' '));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files);
  };

  return (
    <div className="add-files">
      <p className="add-files__help">
        PDF, Word (.docx), PowerPoint (.pptx), text (.txt), JPG or PNG, up to 25 MB each. Scanned
        pages and photos are read with OCR, in English and Chinese. Text in pictures inside Word or
        PowerPoint files isn't read.
      </p>
      <div
        className={`card add-files__drop${dragging ? ' add-files__drop--over' : ''}`}
        data-testid="file-drop"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          id={inputId}
          className="sr-only"
          type="file"
          multiple
          accept={FILE_EXTENSIONS.join(',')}
          tabIndex={-1}
          aria-hidden="true"
          data-testid="file-input"
          onChange={(e) => {
            choose(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="secondary"
          className="add-files__choose"
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </Button>
        <span className="add-files__or">or drop them here</span>
      </div>
      {fileLimit !== undefined && (
        <p className="add-files__plan">
          Every file is checked for malware before we read it. Your plan holds up to {fileLimit}{' '}
          files; you've added {fileSources.length}.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="upload-list" aria-label="Files" data-testid="upload-list">
          {rows.map((r) => {
            const type = fileTypeOf(r.file.name);
            const source = r.state === 'added' ? byId.get(r.sourceId) : undefined;
            return (
              <li key={r.key} className="upload-row" data-testid="upload-row">
                <span className="source-row__icon" aria-hidden="true">
                  {isImage(type) ? <PictureIcon /> : <FileIcon />}
                </span>
                <div className="upload-row__text">
                  <span className="upload-row__name" title={r.file.name}>
                    {r.file.name}
                  </span>
                  <span className="upload-row__meta">{sizeLabel(r.file.size)}</span>
                  {r.state === 'refused' && (
                    <span className="upload-row__error">
                      <span aria-hidden="true">! </span>
                      {REFUSAL_TEXT[r.refusal]}
                    </span>
                  )}
                  {r.state === 'failed' && (
                    <span className="upload-row__error">
                      <span aria-hidden="true">! </span>Upload failed
                    </span>
                  )}
                  {source && source.status === 'failed' && (
                    <span className="upload-row__error">{sourceSummary(source)}</span>
                  )}
                </div>
                <div className="upload-row__state">
                  {r.state === 'waiting' && (
                    <span className="upload-row__meta">Waiting to upload</span>
                  )}
                  {r.state === 'uploading' && (
                    <div className="upload-row__progress">
                      <div
                        className="progress"
                        role="progressbar"
                        aria-label={`Uploading ${r.file.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={r.percent}
                      >
                        <div className="progress__bar" style={{ width: `${r.percent}%` }} />
                      </div>
                      <span className="upload-row__meta">Uploading {r.percent}%</span>
                    </div>
                  )}
                  {r.state === 'failed' && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="kaki-btn--sm"
                      onClick={() => {
                        started.current.delete(r.key);
                        update(r.key, { state: 'waiting' });
                      }}
                      aria-label={`Try again: ${r.file.name}`}
                    >
                      Try again
                    </Button>
                  )}
                  {r.state === 'added' && (
                    <>
                      {source && <SourceState source={source} />}
                      <Link
                        to={`/knowledge/sources/${r.sourceId}`}
                        aria-label={`View ${r.file.name}`}
                      >
                        View
                      </Link>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="sr-only" aria-live="polite">
        {said} {statusSaid}
      </div>
    </div>
  );
}

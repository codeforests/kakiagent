import { CHAT_EXTENSIONS, MAX_FILE_BYTES, type Source } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, putFile } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import {
  CHAT_REDACTION_NOTICE,
  sizeLabel,
  sourceSummary,
  useSources,
  useStatusAnnouncements,
} from '../lib/sources.ts';
import { ChatIcon, SourceState } from './sources.tsx';

const NAME_ERROR = 'Enter your name as it appears in the chat';
const NAMES_MAX = 5;
const NAME_CHARS = 100;

type Refusal = 'type' | 'size' | 'empty' | 'limit';
const REFUSAL_TEXT: Record<Refusal, string> = {
  type: 'Upload the .txt or .zip file WhatsApp exports, or the result.json file Telegram exports',
  size: 'Over 25 MB',
  empty: 'This file is empty',
  limit: "Your plan's file limit is reached",
};

type Row =
  | { key: number; file: File; state: 'refused'; refusal: Refusal }
  | { key: number; file: File; state: 'uploading'; percent: number }
  | { key: number; file: File; state: 'added'; sourceId: string }
  | { key: number; file: File; state: 'failed' };

/** "Kaki Bakery, Kaki Bakery Tampines" → the names, trimmed; null when they don't fit. */
function namesOf(input: string): string[] | null {
  const names = input
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0 || names.length > NAMES_MAX) return null;
  return names.some((n) => n.length > NAME_CHARS) ? null : names;
}

function refusalOf(file: File): Refusal | null {
  const name = file.name.toLowerCase();
  if (!CHAT_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'type';
  if (file.size > MAX_FILE_BYTES) return 'size';
  if (file.size === 0) return 'empty';
  return null;
}

/**
 * SCR-APP-007's chat history part (KB-04, UC-11; FEAT-017 ui-design): the business's name
 * as it appears in the chat, then one export at a time (presign → PUT → create the source).
 * Once added, a row shows the source's name, never the file name, which usually names the
 * customer.
 */
export function AddChatForm() {
  const queryClient = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [said, setSaid] = useState('');
  const profile = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.businessProfile(),
    retry: false,
  });
  const [typed, setTyped] = useState<string | null>(null);
  const nameInput = typed ?? profile.data?.profile?.name ?? '';
  const [touched, setTouched] = useState(false);
  const names = namesOf(nameInput);
  const nameError = touched && !names ? NAME_ERROR : undefined;

  const list = useSources();
  const fileLimit = list.data?.fileLimit;
  const fileSources =
    list.data?.sources.filter(
      (s) => s.kind === 'file' || s.kind === 'spreadsheet' || s.kind === 'chat',
    ) ?? [];
  const byId = new Map(fileSources.map((s) => [s.id, s]));
  const addedSources = rows.flatMap((r) =>
    r.state === 'added' && byId.has(r.sourceId) ? [byId.get(r.sourceId)!] : [],
  );
  const [statusSaid] = useStatusAnnouncements(addedSources.length ? addedSources : undefined);
  const uploading = rows.some((r) => r.state === 'uploading');

  const update = (key: number, row: Partial<Row> & Pick<Row, 'state'>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? ({ ...r, ...row } as Row) : r)));

  const upload = async (key: number, file: File, businessNames: string[]) => {
    update(key, { state: 'uploading', percent: 0 });
    try {
      const ticket = await api.requestUpload({ fileName: file.name, sizeBytes: file.size });
      await putFile(ticket, file, (percent) => update(key, { state: 'uploading', percent }));
      let source: Source | null = null;
      try {
        ({ source } = await api.createSource({
          kind: 'chat',
          uploadId: ticket.uploadId,
          fileName: file.name,
          sizeBytes: file.size,
          businessNames,
        }));
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'source_exists')) throw err;
        update(key, { state: 'added', sourceId: String(err.details.sourceId) });
      }
      if (source) update(key, { state: 'added', sourceId: source.id });
      setSaid("Chat export added. We'll check it and remove personal data before reading it.");
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
    } catch (err) {
      const refusal =
        err instanceof ApiError && err.code === 'file_limit_reached'
          ? 'limit'
          : err instanceof ApiError && err.code === 'unsupported_type'
            ? 'type'
            : err instanceof ApiError && err.code === 'file_too_large'
              ? 'size'
              : null;
      if (refusal) update(key, { state: 'refused', refusal });
      else update(key, { state: 'failed' });
      setSaid(refusal ? `The chat export can't be uploaded.` : 'The upload failed.');
    }
  };

  const choose = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setTouched(true);
    if (!names) return;
    const key = nextKey.current++;
    let refusal = refusalOf(file);
    if (!refusal && fileLimit !== undefined && fileSources.length >= fileLimit) refusal = 'limit';
    if (refusal) {
      setRows((rs) => [...rs, { key, file, state: 'refused', refusal }]);
      setSaid(`The chat export can't be uploaded: ${REFUSAL_TEXT[refusal]}.`);
      return;
    }
    setRows((rs) => [...rs, { key, file, state: 'uploading', percent: 0 }]);
    void upload(key, file, names);
  };

  return (
    <div className="add-chat">
      <p className="add-files__help">
        Upload a chat you exported from WhatsApp (.txt or .zip) or Telegram (result.json). We
        suggest FAQs from your replies.
      </p>
      <p className="add-chat__notice">{CHAT_REDACTION_NOTICE}</p>
      <Field
        id="chat-names"
        label="Your name in the chat (required)"
        help="As it appears in the chat, e.g. Kaki Bakery. Separate several with commas."
        error={nameError}
      >
        <input
          id="chat-names"
          className="input"
          type="text"
          autoComplete="organization"
          value={nameInput}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={describedBy('chat-names', nameError, true)}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </Field>
      <input
        ref={inputRef}
        id={inputId}
        className="sr-only"
        type="file"
        accept={CHAT_EXTENSIONS.join(',')}
        tabIndex={-1}
        aria-hidden="true"
        data-testid="chat-input"
        onChange={(e) => {
          choose(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="secondary"
        className="add-chat__choose"
        disabled={uploading}
        onClick={() => {
          setTouched(true);
          if (names) inputRef.current?.click();
        }}
      >
        Upload chat export
      </Button>
      <details className="add-chat__how">
        <summary>How do I export a chat?</summary>
        <p>
          WhatsApp: open the chat › More › Export chat › Without media.
          <br />
          Telegram Desktop: open the chat › ⋮ › Export chat history › format JSON, untick media.
        </p>
      </details>

      {rows.length > 0 && (
        <ul className="upload-list" aria-label="Chat exports" data-testid="chat-list">
          {rows.map((r) => {
            const source = r.state === 'added' ? byId.get(r.sourceId) : undefined;
            const name = source?.name ?? 'Chat export';
            return (
              <li key={r.key} className="upload-row" data-testid="chat-row">
                <span className="source-row__icon" aria-hidden="true">
                  <ChatIcon />
                </span>
                <div className="upload-row__text">
                  <span className="upload-row__name">{name}</span>
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
                  {source && (source.status === 'failed' || source.status === 'ready') && (
                    <span
                      className={
                        source.status === 'failed' ? 'upload-row__error' : 'upload-row__meta'
                      }
                    >
                      {sourceSummary(source)}
                    </span>
                  )}
                </div>
                <div className="upload-row__state">
                  {r.state === 'uploading' && (
                    <div className="upload-row__progress">
                      <div
                        className="progress"
                        role="progressbar"
                        aria-label="Uploading the chat export"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={r.percent}
                      >
                        <div className="progress__bar" style={{ width: `${r.percent}%` }} />
                      </div>
                      <span className="upload-row__meta">Uploading {r.percent}%</span>
                    </div>
                  )}
                  {r.state === 'added' && (
                    <>
                      {source && <SourceState source={source} />}
                      <Link to={`/knowledge/sources/${r.sourceId}`} aria-label={`View ${name}`}>
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

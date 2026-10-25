import { WIDGET_LOGO_MAX_BYTES, WIDGET_LOGO_TYPES, type WidgetSettings } from '@kaki/contracts';
import type { Scheme } from '@kaki/channels/theme';
import { Button, ConfirmDialog } from '@kaki/ui';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import {
  adjustedNote,
  defaultAccent,
  detecting,
  detectionCopy,
  fontOption,
  HEX_INPUT,
  hostOf,
  installChip,
  installLine,
  isPreviewReady,
  LOGO_ERROR,
  matchLabel,
  originError,
  PLATFORMS,
  PREVIEW_TARGET,
  previewMessage,
  RADIUS_OPTIONS,
  resetDraft,
  withOverride,
  type AppearanceDraft,
  type Platform,
} from '../lib/widget.ts';
import { useAddOrigin, useSetWidget, type WidgetEditor } from '../lib/widget-editor.ts';

/** Parts shared by SCR-APP-037 and SCR-APP-011 (FEAT-032 ui-design "Shared parts"). */

/** `widget-preview`: the real widget in a sandboxed frame, with a light/dark switch. */
export function WidgetPreview({ editor, idPrefix }: { editor: WidgetEditor; idPrefix: string }) {
  const { data, draft, scheme, schemeFixed, setScheme, assistant, detect } = editor;
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && isPreviewReady(e.data)) setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const message =
    data && draft ? JSON.stringify(previewMessage(data.theme, draft, scheme, assistant)) : null;
  useEffect(() => {
    if (ready && message)
      frame.current?.contentWindow?.postMessage(JSON.parse(message), PREVIEW_TARGET);
  }, [ready, message]);
  if (!data) return null;

  const caption = detectionCopy(data);
  const busy = detecting(data.detection) || detect.isPending;
  return (
    <section className="card widget-preview" aria-label="Widget preview">
      <fieldset className="segmented" role="radiogroup" aria-label="Preview in">
        {(
          [
            ['light', 'Light'],
            ['dark', 'Dark'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="segmented__option">
            <input
              type="radio"
              name={`${idPrefix}-preview-scheme`}
              value={value}
              checked={scheme === value}
              disabled={schemeFixed}
              onChange={() => setScheme(value as Scheme)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <iframe
        ref={frame}
        className="widget-preview__frame"
        title="Widget preview"
        src={data.previewUrl}
        sandbox="allow-scripts"
      />
      <div className="widget-preview__caption">
        {caption && (
          <p className="field__help" role="status">
            {busy && <span className="spinner" aria-hidden="true" />} {caption}
          </p>
        )}
        {data.siteUrl && (
          <Button
            variant="ghost"
            className="kaki-btn--sm"
            disabled={busy}
            onClick={() => detect.mutate()}
          >
            Match again
          </Button>
        )}
      </div>
    </section>
  );
}

/** A failed detection (defaults keep applying) or a refused request. */
export function DetectAlert({ editor }: { editor: WidgetEditor }) {
  const { data, detect } = editor;
  if (!data) return null;
  const refused =
    detect.error instanceof ApiError && detect.error.code !== 'detect_running'
      ? detect.error.message
      : detect.error
        ? "We couldn't start matching your website. Try again."
        : null;
  if (data.detection.status !== 'failed' && !refused) return null;
  return (
    <div className="alert alert--warning" role="alert">
      <p>{refused ?? detectionCopy(data)} Your widget uses the default look for now.</p>
      <Button variant="secondary" className="kaki-btn--sm" onClick={() => detect.mutate()}>
        Try again
      </Button>
    </div>
  );
}

/** Colour: follow the site, or a chosen colour (hex text and the native picker). */
function ColourField({
  editor,
  draft,
  idPrefix,
}: {
  editor: WidgetEditor;
  draft: AppearanceDraft;
  idPrefix: string;
}) {
  const { data, scheme, setDraft } = editor;
  const accent = draft.overrides.accent;
  const [text, setText] = useState(accent ?? '');
  const id = `${idPrefix}-accent`;
  if (!data) return null;
  const seed = data.theme.detected?.accent ?? defaultAccent(scheme);
  const shownHex = accent ?? data.theme.detected?.accent ?? defaultAccent(scheme);
  const note = adjustedNote(shownHex, scheme);
  const invalid = accent !== undefined && text !== accent && !HEX_INPUT.test(text);
  const error = invalid ? 'Enter a colour like #c2410c.' : undefined;
  const choose = (hex: string) => {
    setText(hex);
    if (HEX_INPUT.test(hex)) setDraft(withOverride(draft, 'accent', hex.toLowerCase()));
  };
  return (
    <fieldset className="radio-group">
      <legend className="field__label">Colour</legend>
      <label className="radio">
        <input
          type="radio"
          name={id}
          checked={accent === undefined}
          onChange={() => setDraft(withOverride(draft, 'accent', undefined))}
        />
        {matchLabel(data.theme, 'accent')}
        {data.theme.detected?.accent && (
          <span
            className="widget-swatch"
            style={{ background: data.theme.detected.accent }}
            aria-hidden="true"
          />
        )}
      </label>
      <label className="radio">
        <input
          type="radio"
          name={id}
          checked={accent !== undefined}
          onChange={() => choose(seed)}
        />
        Choose a colour
      </label>
      {accent !== undefined && (
        <Field id={id} label="Colour code" error={error}>
          <span className="widget-colour">
            <input
              type="color"
              className="widget-colour__picker"
              aria-label="Pick a colour"
              value={accent}
              onChange={(e) => choose(e.target.value)}
            />
            <input
              id={id}
              className="input"
              value={text}
              maxLength={7}
              spellCheck={false}
              onChange={(e) => choose(e.target.value.trim())}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy(id, error)}
            />
          </span>
        </Field>
      )}
      {note && <p className="field__help">{note}</p>}
    </fieldset>
  );
}

/** A small radio group bound to one draft value. */
function Radios<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="radio-group">
      <legend className="field__label">{legend}</legend>
      {options.map(([v, label]) => (
        <label className="radio" key={v}>
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * `AppearanceForm`: each part shows what was detected and an override; every change updates
 * the preview at once, Save persists. `compact` (the setup step) folds font, corners and logo
 * behind "More options".
 */
export function AppearanceForm({
  editor,
  idPrefix,
  compact = false,
}: {
  editor: WidgetEditor;
  idPrefix: string;
  compact?: boolean;
}) {
  const { data, draft, setDraft, changed, save } = editor;
  const [more, setMore] = useState(!compact);
  const font = draft?.overrides.font;
  const [family, setFamily] = useState(font?.kind === 'custom' ? font.family : '');
  if (!data || !draft) return null;
  const option = fontOption(draft.overrides);
  const familyError =
    option === 'custom' && !/^[\w \-,'"]{1,100}$/.test(family.trim())
      ? 'Enter the font name your website uses, like Lora.'
      : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft && !familyError) save.mutate(draft);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <ColourField editor={editor} draft={draft} idPrefix={idPrefix} />
      {more && (
        <>
          <Field
            id={`${idPrefix}-font`}
            label="Font"
            help={
              option === 'custom'
                ? 'We use fonts your site already loads. We never download fonts.'
                : undefined
            }
          >
            <select
              id={`${idPrefix}-font`}
              className="input"
              value={option}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(
                  withOverride(
                    draft,
                    'font',
                    v === 'site'
                      ? undefined
                      : v === 'system'
                        ? { kind: 'system' }
                        : { kind: 'custom', family: family.trim() || 'sans-serif' },
                  ),
                );
              }}
              aria-describedby={describedBy(`${idPrefix}-font`, undefined, option === 'custom')}
            >
              <option value="site">{matchLabel(data.theme, 'font')}</option>
              <option value="system">System font</option>
              <option value="custom">Custom…</option>
            </select>
          </Field>
          {option === 'custom' && (
            <Field
              id={`${idPrefix}-family`}
              label="Font name, as on your website"
              error={familyError}
            >
              <input
                id={`${idPrefix}-family`}
                className="input"
                value={family}
                maxLength={100}
                onChange={(e) => {
                  setFamily(e.target.value);
                  const f = e.target.value.trim();
                  if (/^[\w \-,'"]{1,100}$/.test(f))
                    setDraft(withOverride(draft, 'font', { kind: 'custom', family: f }));
                }}
                aria-invalid={familyError ? true : undefined}
                aria-describedby={describedBy(`${idPrefix}-family`, familyError)}
              />
            </Field>
          )}
          <Field id={`${idPrefix}-radius`} label="Corners">
            <select
              id={`${idPrefix}-radius`}
              className="input"
              value={draft.overrides.radius === undefined ? 'site' : String(draft.overrides.radius)}
              onChange={(e) =>
                setDraft(
                  withOverride(
                    draft,
                    'radius',
                    e.target.value === 'site' ? undefined : Number(e.target.value),
                  ),
                )
              }
            >
              <option value="site">{matchLabel(data.theme, 'radius')}</option>
              {RADIUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <Radios
        legend="Light or dark"
        name={`${idPrefix}-scheme`}
        value={draft.overrides.scheme ?? 'site'}
        options={[
          ['site', 'Follow my website'],
          ['light', 'Always light'],
          ['dark', 'Always dark'],
        ]}
        onChange={(v) => setDraft(withOverride(draft, 'scheme', v === 'site' ? undefined : v))}
      />
      <Radios
        legend="Position"
        name={`${idPrefix}-position`}
        value={draft.position}
        options={[
          ['right', 'Bottom right'],
          ['left', 'Bottom left'],
        ]}
        onChange={(v) => setDraft({ ...draft, position: v })}
      />
      {more ? (
        <LogoField settings={data} idPrefix={idPrefix} />
      ) : (
        <div>
          <Button
            type="button"
            variant="ghost"
            className="kaki-btn--sm"
            onClick={() => setMore(true)}
          >
            More options
          </Button>
        </div>
      )}
      {save.isError && (
        <div className="alert alert--danger" role="alert">
          <p>
            {save.error instanceof ApiError
              ? save.error.message
              : "We couldn't save. Check your connection and try again."}
          </p>
        </div>
      )}
      <div className="widget-form__actions">
        <Button type="submit" disabled={!changed || save.isPending || !!familyError}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={Object.keys(draft.overrides).length === 0}
          onClick={() => setDraft(resetDraft(draft))}
        >
          Reset to my website
        </Button>
      </div>
    </form>
  );
}

/** `LogoField`: uploads at once (it isn't part of Save); 413/415 inline. */
export function LogoField({ settings, idPrefix }: { settings: WidgetSettings; idPrefix: string }) {
  const setWidget = useSetWidget();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | undefined>();
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadWidgetLogo(file),
    onSuccess: (s) => {
      setError(undefined);
      setWidget(s);
    },
    onError: (err) =>
      setError(
        (err instanceof ApiError && LOGO_ERROR[err.code]) ||
          "We couldn't upload that logo. Try again.",
      ),
  });
  const remove = useMutation({ mutationFn: () => api.deleteWidgetLogo(), onSuccess: setWidget });
  const id = `${idPrefix}-logo`;
  const logo = settings.theme.logoUrl;

  function pick(file: File | undefined) {
    if (!file) return;
    if (!(WIDGET_LOGO_TYPES as readonly string[]).includes(file.type))
      return setError(LOGO_ERROR.logo_type);
    if (file.size > WIDGET_LOGO_MAX_BYTES) return setError(LOGO_ERROR.logo_too_large);
    upload.mutate(file);
  }

  return (
    <Field
      id={id}
      label="Logo"
      error={error}
      help="PNG, JPG or WebP, up to 100 KB. Shown on the chat button."
    >
      <div className="widget-logo">
        <span className="widget-logo__tile">{logo && <img src={logo} alt="Your logo" />}</span>
        <input
          ref={input}
          id={id}
          type="file"
          className="sr-only"
          accept={WIDGET_LOGO_TYPES.join(',')}
          aria-describedby={describedBy(id, error, true)}
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="secondary"
          className="kaki-btn--sm"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
        >
          {upload.isPending ? 'Uploading…' : 'Upload logo'}
        </Button>
        {logo && (
          <Button
            type="button"
            variant="ghost"
            className="kaki-btn--sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove
          </Button>
        )}
      </div>
    </Field>
  );
}

/** `snippet-box`: the line to paste, Copy, and steps per platform. */
export function SnippetBox({
  snippet,
  heading = 'Add this line to your website',
}: {
  snippet: string;
  heading?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<Platform>('wordpress');
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="stack snippet-box">
      <h3 className="subsection-title">{heading}</h3>
      <pre className="snippet-box__code">
        <code>{snippet}</code>
      </pre>
      <div>
        <Button
          variant="secondary"
          onClick={() =>
            void navigator.clipboard.writeText(snippet).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <span className="sr-only" role="status">
          {copied ? 'Copied' : ''}
        </span>
      </div>
      <Tabs.Root
        className="stack"
        value={platform}
        onValueChange={(v) => setPlatform(v as Platform)}
      >
        <Tabs.List className="tabs" aria-label="Your website builder">
          {PLATFORMS.map((p) => (
            <Tabs.Trigger key={p.id} value={p.id} className="tabs__tab">
              {p.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {PLATFORMS.map((p) => (
          <Tabs.Content key={p.id} value={p.id}>
            <ol className="snippet-box__steps">
              {p.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
}

/** `InstallCheck`: the chip, one line, and the wrong-domain alert with "Add {host}". */
export function InstallCheck({ settings }: { settings: WidgetSettings }) {
  const add = useAddOrigin();
  const chip = installChip(settings.install);
  const rejected = settings.install.rejectedOrigin;
  return (
    <div className="stack install-check">
      <p className="install-check__chip">
        <span className={`chip chip--${chip.tone}`}>
          {chip.tone === 'neutral' && <span className="spinner" aria-hidden="true" />}
          {chip.tone === 'success' && <span aria-hidden="true">✓&nbsp;</span>}
          {chip.text}
        </span>
      </p>
      {settings.install.state === 'wrong_domain' && rejected ? (
        <div className="alert alert--warning" role="alert">
          <p>
            The widget loaded on {hostOf(rejected)}, which isn't on your list of websites, so it
            showed nothing there.
          </p>
          <Button
            variant="secondary"
            className="kaki-btn--sm"
            disabled={add.isPending}
            onClick={() => add.mutate(rejected)}
          >
            Add {hostOf(rejected)}
          </Button>
          {add.error instanceof ApiError && <p>{originError(add.error.code, hostOf(rejected))}</p>}
        </div>
      ) : (
        <p className="field__help">{installLine(settings.install)}</p>
      )}
    </div>
  );
}

/** `OriginsList`: where the widget may appear; removal is confirmed. */
export function OriginsList({
  settings,
  idPrefix,
}: {
  settings: WidgetSettings;
  idPrefix: string;
}) {
  const setWidget = useSetWidget();
  const add = useAddOrigin();
  const [value, setValue] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (origin: string) => api.removeWidgetOrigin(origin),
    onSuccess: (s) => {
      setWidget(s);
      setRemoving(null);
    },
  });
  const id = `${idPrefix}-origin`;
  const typed = value.trim();
  const error =
    add.error instanceof ApiError
      ? originError(add.error.code, hostOf(/^https?:/.test(typed) ? typed : `https://${typed}`))
      : add.error
        ? originError('error', '')
        : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!typed) return;
    add.mutate(typed, { onSuccess: () => setValue('') });
  }

  return (
    <div className="stack">
      {settings.allowedOrigins.length === 0 ? (
        <p className="field__help">No websites yet. Add the website where you'll put the widget.</p>
      ) : (
        <ul className="origin-list">
          {settings.allowedOrigins.map((o) => (
            <li key={o.origin} className="origin-row">
              <span className="origin-row__host">{hostOf(o.origin)}</span>
              {o.fromWebsite && <span className="chip chip--neutral">From your website</span>}
              <button
                type="button"
                className="icon-button origin-row__remove"
                aria-label={`Remove ${hostOf(o.origin)}`}
                onClick={() => setRemoving(o.origin)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="origin-add" onSubmit={submit} noValidate>
        <Field id={id} label="Add a website" error={error}>
          <input
            id={id}
            className="input"
            placeholder="shop.example.sg"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (add.isError) add.reset();
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(id, error)}
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={add.isPending || !typed}>
          Add
        </Button>
      </form>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Stop the widget on ${hostOf(removing ?? '')}?`}
        confirmLabel="Remove"
        confirmVariant="danger"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        alert={
          remove.isError ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't remove it. Try again.</p>
            </div>
          ) : undefined
        }
      >
        The chat button disappears from {hostOf(removing ?? '')} the next time a page loads.
      </ConfirmDialog>
    </div>
  );
}

/** The unsaved-changes prompt for a blocked navigation. */
export function UnsavedPrompt({ editor }: { editor: WidgetEditor }) {
  const { blocker } = editor;
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => !open && blocker.reset?.()}
      title="Leave without saving?"
      confirmLabel="Leave"
      cancelLabel="Stay"
      onConfirm={() => blocker.proceed?.()}
    >
      Your changes to the widget's look aren't saved yet.
    </ConfirmDialog>
  );
}

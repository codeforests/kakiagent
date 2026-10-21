import {
  AssistantSettingsBody,
  type AssistantDefaults,
  type AssistantSettings,
  type Tone,
} from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy, useToast } from '../lib/form.ts';

type Lang = 'en' | 'zh';
type TextKey = 'greeting' | 'disclosureNote' | 'afterHoursMessage' | 'fallbackMessage';

interface Draft {
  botName: string;
  tone: Tone;
  emoji: boolean;
  texts: Record<TextKey, Record<Lang, string>>;
}

/** Field ids: `assistant-botName`, `assistant-greeting-en`, … (error-summary links). */
type FieldId = 'botName' | `${TextKey}-${Lang}`;

const TEXT_KEYS: TextKey[] = ['greeting', 'disclosureNote', 'afterHoursMessage', 'fallbackMessage'];
const LIMIT: Record<TextKey, number> = {
  greeting: 200,
  disclosureNote: 200,
  afterHoursMessage: 300,
  fallbackMessage: 300,
};
const LANG_LABEL: Record<Lang, string> = { en: 'English', zh: '中文' };

function fromSettings(s: AssistantSettings): Draft {
  const pair = (t: { en: string | null; zh: string | null }) => ({
    en: t.en ?? '',
    zh: t.zh ?? '',
  });
  return {
    botName: s.botName ?? '',
    tone: s.tone,
    emoji: s.emoji,
    texts: {
      greeting: pair(s.greeting),
      disclosureNote: pair(s.disclosureNote),
      afterHoursMessage: pair(s.afterHoursMessage),
      fallbackMessage: pair(s.fallbackMessage),
    },
  };
}

function bodyOf(d: Draft, version: number) {
  return {
    version,
    botName: d.botName,
    tone: d.tone,
    emoji: d.emoji,
    ...d.texts,
  };
}

/** The contract schema decides; its messages are ui-design's (FEAT-024 AC-2). */
function validate(d: Draft): Partial<Record<FieldId, string>> {
  const parsed = AssistantSettingsBody.safeParse(bodyOf(d, 0));
  const errors: Partial<Record<FieldId, string>> = {};
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const [key, lang] = issue.path as [string, string?];
    const id = (lang ? `${key}-${lang}` : key) as FieldId;
    errors[id] ??= issue.message;
  }
  return errors;
}

/** SCR-APP-041 Assistant (AGT-08, AGT-11; FEAT-024 ui-design). */
export function AssistantPage() {
  const loaded = useQuery({
    queryKey: ['assistant-settings'],
    queryFn: () => api.assistantSettings(),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });

  const head = (
    <>
      <Link className="back-link" to="/settings">
        Settings
      </Link>
      <h1 className="page-title">Assistant</h1>
      <p className="page-lede">
        How your assistant introduces itself and talks to visitors. Changes apply to the next reply.
      </p>
    </>
  );

  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    return (
      <div className="assistant-page">
        {head}
        <EmptyState title="You can't change these settings">
          Only the Owner or an Admin can change the assistant's settings.
        </EmptyState>
      </div>
    );
  if (loaded.isError)
    return (
      <div className="assistant-page">
        {head}
        <ErrorState
          title="We couldn't load your assistant settings"
          action={
            <Button variant="secondary" onClick={() => void loaded.refetch()}>
              Try again
            </Button>
          }
        >
          Nothing you saved is lost.
        </ErrorState>
      </div>
    );
  if (!loaded.data)
    return (
      <div className="assistant-page">
        {head}
        <div className="assistant-layout" aria-busy="true" aria-label="Loading assistant settings">
          <div className="card">
            <div className="skeleton-field" />
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
          <div className="card assistant-preview">
            <div className="skeleton-field" />
          </div>
        </div>
      </div>
    );
  const { settings, defaults } = loaded.data;
  return (
    <div className="assistant-page">
      {head}
      <AssistantForm key={settings.version} settings={settings} defaults={defaults} />
    </div>
  );
}

function AssistantForm({
  settings,
  defaults,
}: {
  settings: AssistantSettings;
  defaults: AssistantDefaults;
}) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const initial = fromSettings(settings);
  const [draft, setDraft] = useState<Draft>(initial);
  const [lang, setLang] = useState<Lang>('en');
  const [touched, setTouched] = useState<Partial<Record<FieldId, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const errors = validate(draft);
  const shown = (f: FieldId) => (submitted || touched[f] ? errors[f] : undefined);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () =>
      api.saveAssistantSettings(AssistantSettingsBody.parse(bodyOf(draft, settings.version))),
    onSuccess: (res) => {
      queryClient.setQueryData(['assistant-settings'], res);
      setToast('Assistant settings saved. Your assistant uses them from the next reply.');
    },
  });
  const failure =
    save.error instanceof ApiError ? save.error.code : save.error ? 'unavailable' : null;
  const readOnly = save.isPending;

  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);

  const blur = (f: FieldId) => () => setTouched((t) => ({ ...t, [f]: true }));
  const setText = (key: TextKey, l: Lang, value: string) =>
    setDraft((d) => ({ ...d, texts: { ...d.texts, [key]: { ...d.texts[key], [l]: value } } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setAttempts((n) => n + 1);
      return;
    }
    save.mutate();
  }

  const errorList = Object.entries(errors) as [FieldId, string][];
  const tabErrors = (l: Lang) => TEXT_KEYS.filter((k) => errors[`${k}-${l}`]).length;
  const followError = (f: FieldId) => {
    const l = /-(en|zh)$/.exec(f)?.[1] as Lang | undefined;
    if (l) setLang(l);
  };

  const name = draft.botName.trim();
  const core = name
    ? defaults.disclosureCore[lang].named.replace('{name}', name)
    : defaults.disclosureCore[lang].unnamed;
  const note = draft.texts.disclosureNote[lang].trim();
  const greeting = draft.texts.greeting[lang].trim() || defaults.greeting[lang];

  const textField = (key: TextKey, l: Lang, label: string, help: string, placeholder: string) => {
    const id = `assistant-${key}-${l}`;
    const f = `${key}-${l}` as FieldId;
    const value = draft.texts[key][l];
    const atLimit = value.length >= LIMIT[key];
    return (
      <Field id={id} label={label} error={shown(f)} help={help}>
        <textarea
          id={id}
          className="input input--area"
          lang={l === 'zh' ? 'zh-Hans' : undefined}
          rows={2}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setText(key, l, e.target.value)}
          onBlur={blur(f)}
          readOnly={readOnly}
          aria-invalid={shown(f) ? true : undefined}
          aria-describedby={describedBy(id, shown(f), true)}
        />
        <p className="field__counter" role={atLimit ? 'status' : undefined}>
          {value.length} / {LIMIT[key]}
        </p>
      </Field>
    );
  };

  const messages = (l: Lang) => {
    const coreFor = name
      ? defaults.disclosureCore[l].named.replace('{name}', name)
      : defaults.disclosureCore[l].unnamed;
    return (
      <>
        {textField(
          'greeting',
          l,
          'Greeting',
          'Shown before the visitor’s first message.',
          defaults.greeting[l],
        )}
        <div className="field">
          <label className="field__label" htmlFor={`assistant-core-${l}`}>
            AI disclosure (always shown)
          </label>
          <textarea
            id={`assistant-core-${l}`}
            className="input input--fixed"
            rows={2}
            lang={l === 'zh' ? 'zh-Hans' : undefined}
            value={coreFor}
            readOnly
            aria-describedby={`assistant-core-${l}-help`}
          />
          <p className="field__help" id={`assistant-core-${l}-help`}>
            This sentence is always the first thing visitors see. You can add to it, but not remove
            it.
          </p>
        </div>
        {textField(
          'disclosureNote',
          l,
          'Add to the disclosure',
          'Shown after the sentence above.',
          l === 'en'
            ? 'e.g. Our team reads every conversation.'
            : '例如：我们的团队会阅读每条对话。',
        )}
        <p className="assistant-fixed" lang={l === 'zh' ? 'zh-Hans' : undefined}>
          {defaults.afterHoursLead[l].replace(
            '{when}',
            l === 'en' ? '{return time}' : '{回来时间}',
          )}
        </p>
        {textField(
          'afterHoursMessage',
          l,
          'After-hours message',
          'Shown with the time your team is back, from your opening hours.',
          defaults.afterHoursMessage[l],
        )}
        {textField(
          'fallbackMessage',
          l,
          'Fallback message',
          'Sent when the AI is paused or unavailable.',
          defaults.fallbackMessage[l],
        )}
      </>
    );
  };

  return (
    <>
      {submitted && errorList.length > 0 && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="alert__title">Check these fields</p>
          <ul>
            {errorList.map(([f, msg]) => (
              <li key={f}>
                <a href={`#assistant-${f}`} onClick={() => followError(f)}>
                  {msg}
                  {/-(en|zh)$/.test(f) ? ` (${LANG_LABEL[f.slice(-2) as Lang]})` : ''}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {failure === 'version_conflict' && (
        <div className="alert alert--warning" role="alert">
          <p>
            Someone else saved these settings while you were editing. Reload to see their version,
            then make your change again.
          </p>
          <Button
            variant="secondary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['assistant-settings'] })}
          >
            Reload
          </Button>
        </div>
      )}
      {failure && failure !== 'version_conflict' && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save your settings just now. Nothing was changed.</p>
        </div>
      )}

      <form className="assistant-layout" onSubmit={submit} noValidate>
        <section className="card stack assistant-persona" aria-labelledby="assistant-persona">
          <h2 className="section-title" id="assistant-persona">
            Persona
          </h2>
          <Field
            id="assistant-botName"
            label="Assistant name"
            error={shown('botName')}
            help="Shown at the top of the chat. Leave empty to use “Assistant”. Letters only, up to 30 characters."
          >
            <input
              id="assistant-botName"
              className="input"
              placeholder="e.g. Kaki"
              value={draft.botName}
              onChange={(e) => setDraft((d) => ({ ...d, botName: e.target.value }))}
              onBlur={blur('botName')}
              readOnly={readOnly}
              aria-invalid={shown('botName') ? true : undefined}
              aria-describedby={describedBy('assistant-botName', shown('botName'), true)}
            />
          </Field>
          <fieldset className="radio-group" aria-describedby="assistant-tone-help">
            <legend className="field__label">Tone</legend>
            {(
              [
                ['friendly', 'Friendly — warm and casual'],
                ['professional', 'Professional — courteous and businesslike'],
              ] as const
            ).map(([value, label]) => (
              <label className="radio" key={value}>
                <input
                  type="radio"
                  name="tone"
                  checked={draft.tone === value}
                  onChange={() => setDraft((d) => ({ ...d, tone: value }))}
                  disabled={readOnly}
                />
                {label}
              </label>
            ))}
            <p className="field__help" id="assistant-tone-help">
              Your assistant still answers in the visitor's language. With Professional it doesn't
              use Singlish particles.
            </p>
          </fieldset>
          <div className="fact-form__status">
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={draft.emoji}
              aria-labelledby="assistant-emoji-label"
              disabled={readOnly}
              onClick={() => setDraft((d) => ({ ...d, emoji: !d.emoji }))}
            >
              <span className="toggle__thumb" aria-hidden="true" />
            </button>
            <span id="assistant-emoji-label">Use emoji in replies</span>
          </div>
        </section>

        <aside className="card assistant-preview" aria-labelledby="assistant-preview-title">
          <h2 className="section-title" id="assistant-preview-title">
            Preview
          </h2>
          <div className="preview-panel" lang={lang === 'zh' ? 'zh-Hans' : undefined}>
            <div className="preview-panel__header">
              <span className="preview-panel__name">{name || defaults.botName}</span>
              <span className="preview-panel__ai">
                {lang === 'zh' ? 'AI 助手' : 'AI assistant'}
              </span>
            </div>
            <p className="preview-panel__greeting">{greeting}</p>
            <p className="preview-panel__bubble">
              {core}
              {note ? ` ${note}` : ''}
            </p>
          </div>
        </aside>

        <section className="card stack assistant-messages" aria-labelledby="assistant-messages">
          <h2 className="section-title" id="assistant-messages">
            Messages
          </h2>
          <Tabs.Root className="stack" value={lang} onValueChange={(v) => setLang(v as Lang)}>
            <Tabs.List className="tabs" aria-label="Message language">
              {(['en', 'zh'] as const).map((l) => (
                <Tabs.Trigger key={l} value={l} className="tabs__tab">
                  <span lang={l === 'zh' ? 'zh-Hans' : undefined}>{LANG_LABEL[l]}</span>
                  {tabErrors(l) > 0 && (
                    <span className="tabs__error">
                      {' '}
                      ({tabErrors(l)} error{tabErrors(l) > 1 ? 's' : ''})
                    </span>
                  )}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <p className="field__help tabs__help">
              Leave a message empty to use the default shown. If you only write in English,
              Chinese-speaking visitors get the Chinese default.
            </p>
            {(['en', 'zh'] as const).map((l) => (
              <Tabs.Content key={l} value={l} className="stack" forceMount hidden={lang !== l}>
                {messages(l)}
              </Tabs.Content>
            ))}
          </Tabs.Root>
        </section>

        <div className="action-bar">
          <Button
            type="submit"
            disabled={readOnly || !changed}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={readOnly || !changed}
            onClick={() => {
              setDraft(initial);
              setTouched({});
              setSubmitted(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

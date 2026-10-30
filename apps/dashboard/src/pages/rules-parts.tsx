import {
  BOUNDARY_LIMITS,
  COMMITMENT_KEYS,
  LOCKED_COMMITMENTS,
  type BoundaryRules,
  type BoundaryRulesResponse,
  type CommitmentKey,
} from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState } from '@kaki/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from '../lib/api.ts';
import { describedBy } from '../lib/form.ts';
import { ReauthCancelled } from '../lib/reauth.ts';
import {
  COMMITMENT_LABELS,
  diffRules,
  discountError,
  RULES_KEY,
  rulesFieldErrors,
  savedCaption,
  topicError,
  useRules,
  useSaveRules,
  type RulesErrorField,
} from '../lib/rules.ts';
import { ErrorSummary } from './privacy-parts.tsx';

/**
 * The parts of SCR-APP-042 Rules and approvals and the rules block of SCR-APP-009 (APR-01,
 * AUTH-03; FEAT-054 ui-design "Shared parts").
 */

export type RulesVariant = 'settings' | 'setup';

const isLocked = (key: CommitmentKey) => (LOCKED_COMMITMENTS as readonly string[]).includes(key);

/** Loading, error and permission states around the loaded rules; Reload remounts the form. */
export function RulesBlock({
  variant,
  onToast,
}: {
  variant: RulesVariant;
  onToast: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const loaded = useRules();
  const reload = () =>
    void queryClient
      .invalidateQueries({ queryKey: RULES_KEY })
      .then(() => setGeneration((g) => g + 1));

  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    return (
      <EmptyState title="You can't change the rules">
        Only the Owner and Admins can change what your assistant may say and promise.
      </EmptyState>
    );
  if (loaded.isError)
    return (
      <ErrorState
        title="We couldn't load your rules."
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  if (!loaded.data)
    return (
      <div className="stack" aria-busy="true" aria-label="Loading rules">
        {[0, 1, 2].map((k) => (
          <div className="card" key={k}>
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
        ))}
      </div>
    );
  return (
    <RulesForm
      key={generation}
      data={loaded.data}
      variant={variant}
      onReload={reload}
      onToast={onToast}
    />
  );
}

function PrefillNotice({ source }: { source: BoundaryRulesResponse['source'] }) {
  if (source === 'saved') return null;
  return (
    <div className="alert alert--info">
      {source === 'template' ? (
        <>
          <p className="alert__title">Suggested rules for food and beverage businesses</p>
          <p>
            Check them and save. Until you save, your assistant uses the safe defaults: no
            discounts, quotes need approval, nothing promised.
          </p>
        </>
      ) : (
        <>
          <p className="alert__title">Safe defaults</p>
          <p>
            Your assistant offers no discounts, asks for approval on quotes and makes no promises.
            Save to confirm or change them.
          </p>
        </>
      )}
    </div>
  );
}

/** Input + Add, then the list with Remove (the widget's allowed-origins pattern). */
export function TopicListEditor({
  id,
  label,
  help,
  placeholder,
  items,
  onChange,
  other,
  max,
  serverError,
  disabled,
}: {
  id: string;
  label: string;
  help?: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
  other?: { items: string[]; message: string };
  max: number;
  serverError?: string | undefined;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = error ?? serverError;

  function add(e: FormEvent | KeyboardEvent) {
    e.preventDefault();
    const err = topicError(items, value, other ? { max, other } : { max });
    setError(err);
    if (err) return;
    const topic = value.trim().replace(/\s+/g, ' ');
    onChange([...items, topic]);
    setValue('');
    setAnnounce(`Added ${topic}`);
  }

  function remove(index: number) {
    const topic = items[index];
    onChange(items.filter((_, i) => i !== index));
    setAnnounce(`Removed ${topic}`);
    // Focus the next row's Remove (it takes this row's place) or, with none left, the input.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
      const next = buttons?.[Math.min(index, buttons.length - 1)];
      (next ?? inputRef.current)?.focus();
    });
  }

  return (
    <div className="field rules-topics">
      <div className="rules-topics__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <span className="field__counter">
          {items.length} of {max}
        </span>
      </div>
      {help && (
        <p className="field__help" id={`${id}-help`}>
          {help}
        </p>
      )}
      <div className="rules-add">
        <input
          id={id}
          ref={inputRef}
          className="input"
          placeholder={placeholder}
          value={value}
          maxLength={BOUNDARY_LIMITS.topicMax + 20}
          readOnly={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(e);
          }}
          aria-invalid={shown ? true : undefined}
          aria-describedby={describedBy(id, shown, Boolean(help))}
        />
        <Button type="button" variant="secondary" disabled={disabled} onClick={add}>
          Add
        </Button>
      </div>
      {shown && (
        <p className="field__error" id={`${id}-error`}>
          <span aria-hidden="true">!</span> {shown}
        </p>
      )}
      {items.length === 0 ? (
        <p className="field__help">None yet.</p>
      ) : (
        <ul className="origin-list" aria-label={label} ref={listRef}>
          {items.map((t, i) => (
            <li key={`${t}-${i}`} className="origin-row">
              <span className="origin-row__host">{t}</span>
              <button
                type="button"
                className="icon-button origin-row__remove"
                aria-label={`Remove ${t}`}
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="card stack" aria-labelledby={`${id}-title`}>
      <h2 className="section-title" id={`${id}-title`}>
        {title}
      </h2>
      {lede && <p className="privacy-lede">{lede}</p>}
      {children}
    </section>
  );
}

/** The rules form: draft, confirm with change lines, re-auth, server acknowledgement, toast. */
export function RulesForm({
  data,
  variant,
  onReload,
  onToast,
}: {
  data: BoundaryRulesResponse;
  variant: RulesVariant;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [base, setBase] = useState<BoundaryRules>(data.rules);
  const [draft, setDraft] = useState<BoundaryRules>(data.rules);
  const [discount, setDiscount] = useState(String(data.rules.maxDiscountPct));
  const [confirming, setConfirming] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<RulesErrorField, string>>>({});
  const [discountShown, setDiscountShown] = useState<string | undefined>();
  const [attempts, setAttempts] = useState(0);
  const [conflict, setConflict] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const save = useSaveRules();

  const next: BoundaryRules = { ...draft, maxDiscountPct: Number(discount.trim()) };
  const lines = diffRules(base, discountError(discount) ? draft : next);
  const dirty = lines.length > 0 || discount.trim() !== String(base.maxDiscountPct);
  const pending = save.isPending;
  const neverSaved = data.version === null;
  // Nothing to save: aria-disabled, not disabled, so focus can come back to it after a save.
  const nothingToSave = variant === 'settings' && !dirty && data.source === 'saved';

  const set = <K extends keyof BoundaryRules>(key: K, value: BoundaryRules[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (serverErrors[key as RulesErrorField]) setServerErrors((e) => ({ ...e, [key]: undefined }));
  };

  const errors: Partial<Record<RulesErrorField, string>> = {
    ...serverErrors,
    ...(discountShown ? { maxDiscountPct: discountShown } : {}),
  };

  function startSave() {
    const err = discountError(discount);
    setDiscountShown(err);
    if (err) {
      setAttempts((n) => n + 1);
      return;
    }
    save.reset();
    setConfirming(true);
  }

  function confirm() {
    save.mutate(
      { version: data.version, rules: next },
      {
        onSuccess: (res) => {
          setBase(res.rules);
          setDraft(res.rules);
          setDiscount(String(res.rules.maxDiscountPct));
          setServerErrors({});
          setConfirming(false);
          onToast('Rules saved. They apply from the next reply.');
          requestAnimationFrame(() => saveRef.current?.focus());
        },
        onError: (err) => {
          if (err instanceof ReauthCancelled) setConfirming(false);
          else if (err instanceof ApiError && err.code === 'invalid_rules') {
            setConfirming(false);
            setServerErrors(
              rulesFieldErrors((err.details.fields ?? {}) as Record<string, unknown>),
            );
            setAttempts((n) => n + 1);
          } else if (err instanceof ApiError && err.code === 'rules_stale') {
            setConfirming(false);
            setConflict(true);
          }
        },
      },
    );
  }

  const failed =
    save.isError &&
    !(save.error instanceof ReauthCancelled) &&
    !(save.error instanceof ApiError && ['invalid_rules', 'rules_stale'].includes(save.error.code));

  const toggleCommitment = (key: CommitmentKey, on: boolean) =>
    set(
      'forbiddenCommitments',
      COMMITMENT_KEYS.filter((k) => (k === key ? on : draft.forbiddenCommitments.includes(k))),
    );

  return (
    <div className="stack rules-form">
      <PrefillNotice source={data.source} />

      <Section id="rules-topics" title="Topics" lede="Help your assistant know what to talk about.">
        <TopicListEditor
          id="rules-allowedTopics"
          label="Topics your assistant helps with"
          help="A guide for your assistant. Questions about your business outside this list still get an answer if your facts cover it."
          placeholder="e.g. Wedding cakes"
          items={draft.allowedTopics}
          onChange={(items) => set('allowedTopics', items)}
          other={{
            items: draft.blockedTopics,
            message: "This topic is blocked, so it can't also be allowed",
          }}
          max={BOUNDARY_LIMITS.topics}
          serverError={serverErrors.allowedTopics}
          disabled={pending}
        />
        <TopicListEditor
          id="rules-blockedTopics"
          label="Topics your assistant won't discuss"
          help="Visitors who ask get a polite 'I can't help with that here'."
          placeholder="e.g. Competitors' prices"
          items={draft.blockedTopics}
          onChange={(items) => set('blockedTopics', items)}
          other={{
            items: draft.allowedTopics,
            message: "This topic is allowed, so it can't also be blocked",
          }}
          max={BOUNDARY_LIMITS.topics}
          serverError={serverErrors.blockedTopics}
          disabled={pending}
        />
      </Section>

      <Section id="rules-discounts" title="Discounts and quotes">
        <div className="field">
          <label className="field__label" htmlFor="rules-maxDiscountPct">
            Maximum discount<span className="sr-only"> (percent)</span>
          </label>
          <div className="input-suffix">
            <input
              id="rules-maxDiscountPct"
              className="input rules-discount"
              inputMode="numeric"
              maxLength={3}
              value={discount}
              readOnly={pending}
              onChange={(e) => {
                setDiscount(e.target.value);
                setDiscountShown(undefined);
                if (serverErrors.maxDiscountPct)
                  setServerErrors((x) => ({ ...x, maxDiscountPct: undefined }));
              }}
              aria-invalid={errors.maxDiscountPct ? true : undefined}
              aria-describedby={describedBy('rules-maxDiscountPct', errors.maxDiscountPct, true)}
            />
            <span className="input-suffix__text" aria-hidden="true">
              %
            </span>
          </div>
          <p className="field__help" id="rules-maxDiscountPct-help">
            0% means your assistant never offers a discount. Until approvals are set up, your team
            confirms every discount.
          </p>
          {errors.maxDiscountPct && (
            <p className="field__error" id="rules-maxDiscountPct-error">
              <span aria-hidden="true">!</span> {errors.maxDiscountPct}
            </p>
          )}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.quotesNeedApproval}
            disabled={pending}
            onChange={(e) => set('quotesNeedApproval', e.target.checked)}
            aria-describedby="rules-quotes-help"
          />
          <span>
            Quotes need your approval before your assistant sends them
            <span className="field__help rules-check__help" id="rules-quotes-help">
              Recommended. Your assistant tells the visitor the team will confirm.
            </span>
          </span>
        </label>
      </Section>

      <Section
        id="rules-promises"
        title="Never promise"
        lede="Your assistant won't say any of these, even if a visitor asks."
      >
        <fieldset className="rules-commitments">
          <legend className="sr-only">Never promise</legend>
          {COMMITMENT_KEYS.map((key, i) => {
            const locked = isLocked(key);
            return (
              <label className="checkbox" key={key}>
                <input
                  type="checkbox"
                  id={i === 0 ? 'rules-forbiddenCommitments' : undefined}
                  checked={locked || draft.forbiddenCommitments.includes(key)}
                  disabled={!locked && pending}
                  aria-disabled={locked || undefined}
                  aria-describedby={locked ? 'rules-locked-help' : undefined}
                  onChange={(e) => !locked && toggleCommitment(key, e.target.checked)}
                />
                <span>
                  {COMMITMENT_LABELS[key]}
                  {locked && <span className="chip chip--neutral">Always on</span>}
                </span>
              </label>
            );
          })}
          <p className="field__help" id="rules-locked-help">
            Your assistant never gives legal or medical advice.
          </p>
          {serverErrors.forbiddenCommitments && (
            <p className="field__error">
              <span aria-hidden="true">!</span> {serverErrors.forbiddenCommitments}
            </p>
          )}
        </fieldset>
        <TopicListEditor
          id="rules-customCommitments"
          label="Other things never to promise"
          placeholder="e.g. Same-day delivery"
          items={draft.customCommitments}
          onChange={(items) => set('customCommitments', items)}
          max={BOUNDARY_LIMITS.customCommitments}
          serverError={serverErrors.customCommitments}
          disabled={pending}
        />
      </Section>

      {variant === 'settings' && (
        <Section id="rules-approvals" title="Approvals">
          <p className="privacy-lede">Approval times and who can approve arrive with approvals.</p>
        </Section>
      )}

      <ErrorSummary
        errors={errors}
        prefix="rules"
        focusKey={attempts}
        title="Some rules need fixing"
      />
      {conflict && (
        <div className="alert alert--warning" role="alert">
          <p>Someone else saved the rules while you were editing.</p>
          <div className="rules-conflict__actions">
            <Button variant="secondary" onClick={onReload}>
              Reload
            </Button>
            <span className="privacy-saved">Your changes will be lost.</span>
          </div>
        </div>
      )}

      <div className="privacy-form__actions">
        <Button
          ref={saveRef}
          disabled={pending}
          aria-disabled={nothingToSave || undefined}
          aria-busy={pending || undefined}
          onClick={() => !nothingToSave && startSave()}
        >
          Save rules
        </Button>
        <p className="privacy-saved">{savedCaption(data)}</p>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title="Save these rules?"
        confirmLabel="Save rules"
        busy={pending}
        busyLabel="Saving…"
        onConfirm={confirm}
        alert={
          failed ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't save the rules. Check your connection and try again.</p>
            </div>
          ) : undefined
        }
      >
        <p>They apply from your assistant's next reply.</p>
        {lines.length > 0 ? (
          <ul className="rules-changes">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p>
            {!neverSaved
              ? "You're saving the same rules again."
              : data.source === 'template'
                ? "You're confirming the suggested rules."
                : "You're confirming the safe defaults."}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

import type { EscalationRouting, InboxMember } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import {
  ESCALATION_ROUTING_KEY,
  personInactiveText,
  routingBody,
  routingChanged,
  routingErrors,
  routingForm,
  routingSaveErrors,
  routingSummary,
  type RoutingErrors,
  type RoutingForm,
} from '../lib/escalation.ts';
import { MEMBERS_KEY } from '../lib/inbox.ts';
import { CardState } from './account-parts.tsx';
import { ErrorSummary } from './privacy-parts.tsx';

const ID = 'escalations';
const TITLE = 'Escalations';

/**
 * SCR-APP-045 Escalations card (FEAT-044 ui-design): who gets a visitor's request for a
 * person, and when to remind them. Owners and Admins edit; Agents see it as text.
 */
export function EscalationCard({
  canEdit,
  onToast,
}: {
  canEdit: boolean;
  onToast: (t: string) => void;
}) {
  const routing = useQuery({ queryKey: ESCALATION_ROUTING_KEY, queryFn: api.escalationRouting });
  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: api.inboxMembers,
    staleTime: 5 * 60_000,
  });
  if (!routing.data)
    return (
      <CardState
        id={ID}
        title={TITLE}
        what="your escalation settings"
        error={routing.isError}
        onRetry={() => void routing.refetch()}
      />
    );
  const list = members.data?.members;
  const inactive = personInactiveText(routing.data, list);
  return (
    <section className="card escalation-card" aria-labelledby={`${ID}-title`}>
      <h2 className="section-title" id={`${ID}-title`}>
        {TITLE}
      </h2>
      <p className="field__help">When a customer asks for a person, who should we alert?</p>
      {inactive && (
        <div className="alert alert--warning" data-testid="person-inactive">
          <p>{inactive}</p>
        </div>
      )}
      {canEdit ? (
        <RoutingFormView
          key={JSON.stringify(routing.data)}
          saved={routing.data}
          members={list ?? []}
          onToast={onToast}
        />
      ) : (
        <p data-testid="escalation-summary">{routingSummary(routing.data, list)}</p>
      )}
    </section>
  );
}

function RoutingFormView({
  saved,
  members,
  onToast,
}: {
  saved: EscalationRouting;
  members: InboxMember[];
  onToast: (t: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RoutingForm>(() => routingForm(saved));
  const [errors, setErrors] = useState<RoutingErrors>({});
  const [focusKey, setFocusKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const save = useMutation({
    mutationFn: () => api.saveEscalationRouting(routingBody(form)),
    onSuccess: (next) => {
      queryClient.setQueryData(ESCALATION_ROUTING_KEY, next);
      onToast('Escalation settings saved');
    },
    onError: (err) => {
      const fields = routingSaveErrors(err);
      if (fields) {
        setErrors(fields);
        setFocusKey((k) => k + 1);
      } else setFailed(true);
    },
  });
  const set = (patch: Partial<RoutingForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
    setFailed(false);
  };
  const submit = () => {
    const found = routingErrors(form);
    setErrors(found);
    setFailed(false);
    if (Object.keys(found).length) {
      setFocusKey((k) => k + 1);
      return;
    }
    save.mutate();
  };
  // A saved person who left stays chosen until changed; the select lists active members.
  const choices = members.some((m) => m.userId === form.personUserId)
    ? members
    : form.personUserId
      ? [{ userId: form.personUserId, name: 'No longer on the team' }, ...members]
      : members;

  return (
    <form
      className="escalation-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ErrorSummary errors={errors} prefix={ID} focusKey={focusKey} />
      {failed && (
        <div className="alert alert--danger" role="alert">
          <p>Couldn't save. Your changes are still here.</p>
          <Button type="button" variant="secondary" onClick={submit}>
            Try again
          </Button>
        </div>
      )}
      <fieldset className="radio-group">
        <legend className="field__label">Send escalations to</legend>
        <label className="radio">
          <input
            type="radio"
            name={`${ID}-mode`}
            checked={form.mode === 'round_robin'}
            onChange={() => set({ mode: 'round_robin' })}
          />
          <span>Take turns — everyone on the team, one after another</span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name={`${ID}-mode`}
            checked={form.mode === 'person'}
            onChange={() => set({ mode: 'person' })}
          />
          <span>Always one person</span>
        </label>
      </fieldset>
      {form.mode === 'person' && (
        <div className="field">
          <label className="field__label" htmlFor={`${ID}-personUserId`}>
            Person
          </label>
          <select
            id={`${ID}-personUserId`}
            className="input"
            required
            value={form.personUserId}
            aria-invalid={errors.personUserId ? true : undefined}
            aria-describedby={errors.personUserId ? `${ID}-personUserId-error` : undefined}
            onChange={(e) => set({ personUserId: e.target.value })}
          >
            <option value="">Choose a person</option>
            {choices.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
          {errors.personUserId && (
            <p className="field__error" id={`${ID}-personUserId-error`}>
              {errors.personUserId}
            </p>
          )}
        </div>
      )}
      <div className="field">
        <label className="field__label" htmlFor={`${ID}-reminderMinutes`}>
          Remind them after
        </label>
        <div className="input-suffix">
          <input
            id={`${ID}-reminderMinutes`}
            className="input escalation-form__minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={240}
            value={form.minutes}
            aria-invalid={errors.reminderMinutes ? true : undefined}
            aria-describedby={`${ID}-reminderMinutes-help${
              errors.reminderMinutes ? ` ${ID}-reminderMinutes-error` : ''
            }`}
            onChange={(e) => set({ minutes: e.target.value })}
          />
          <span className="input-suffix__text">minutes</span>
        </div>
        <p className="field__help" id={`${ID}-reminderMinutes-help`}>
          Counted in your opening hours. From the third reminder, owners and admins are reminded
          too.
        </p>
        {errors.reminderMinutes && (
          <p className="field__error" id={`${ID}-reminderMinutes-error`}>
            {errors.reminderMinutes}
          </p>
        )}
      </div>
      <div className="escalation-form__actions">
        <Button
          type="submit"
          disabled={!routingChanged(form, saved) || save.isPending}
          aria-busy={save.isPending || undefined}
        >
          {save.isPending && <span className="spinner" aria-hidden="true" />}
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            setForm(routingForm(saved));
            setErrors({});
            setFailed(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

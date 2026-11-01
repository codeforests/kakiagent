import type { EscalationRouting } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  personInactiveText,
  routingBody,
  routingChanged,
  routingErrors,
  routingForm,
  routingSaveErrors,
  routingSummary,
} from './escalation.ts';

const MEI = '00000000-0000-4000-8000-000000000091';
const members = [{ userId: MEI, name: 'Mei Ling' }];
const saved: EscalationRouting = {
  mode: 'round_robin',
  personUserId: null,
  reminderMinutes: 10,
  personInactive: false,
};

describe('escalation routing form (FEAT-044 SCR-APP-045)', () => {
  it('validates a person in person mode and minutes from 1 to 240', () => {
    const f = routingForm(saved);
    expect(routingErrors(f)).toEqual({});
    expect(routingErrors({ ...f, mode: 'person' })).toEqual({ personUserId: 'Choose a person' });
    for (const minutes of ['0', '241', '', '2.5', 'ten'])
      expect(routingErrors({ ...f, minutes }).reminderMinutes).toBe('Enter a number from 1 to 240');
    expect(routingErrors({ ...f, minutes: ' 240 ' })).toEqual({});
  });

  it('builds the body, dropping the person outside person mode', () => {
    expect(routingBody({ mode: 'person', personUserId: MEI, minutes: '15' })).toEqual({
      mode: 'person',
      personUserId: MEI,
      reminderMinutes: 15,
    });
    expect(routingBody({ mode: 'round_robin', personUserId: MEI, minutes: '10' })).toEqual({
      mode: 'round_robin',
      personUserId: null,
      reminderMinutes: 10,
    });
  });

  it('enables Save only after a change', () => {
    const f = routingForm(saved);
    expect(routingChanged(f, saved)).toBe(false);
    expect(routingChanged({ ...f, minutes: '12' }, saved)).toBe(true);
    expect(routingChanged({ ...f, mode: 'person' }, saved)).toBe(true);
    expect(routingChanged({ ...f, personUserId: MEI }, saved)).toBe(false);
  });

  it('describes the settings for read-only viewers and warns about an inactive person', () => {
    expect(routingSummary(saved, members)).toBe(
      'Escalations take turns across the team. Reminders after 10 minutes.',
    );
    const person = { ...saved, mode: 'person' as const, personUserId: MEI, reminderMinutes: 1 };
    expect(routingSummary(person, members)).toBe(
      'Escalations go to Mei Ling. Reminders after 1 minute.',
    );
    expect(personInactiveText(person, members)).toBeNull();
    expect(personInactiveText({ ...person, personInactive: true }, members)).toBe(
      'Mei Ling is no longer on the team, so escalations are taking turns. Choose someone else or keep taking turns.',
    );
  });

  it('maps refused saves to field errors, anything else to the retry alert', () => {
    expect(routingSaveErrors(new ApiError(422, 'person_not_member', ''))).toEqual({
      personUserId: 'That person is no longer on the team. Choose someone else.',
    });
    expect(
      routingSaveErrors(
        new ApiError(422, 'invalid_routing', '', { fields: { personUserId: 'person_required' } }),
      ),
    ).toEqual({ personUserId: 'Choose a person' });
    expect(routingSaveErrors(new ApiError(500, 'internal', ''))).toBeNull();
    expect(routingSaveErrors(new TypeError('Failed to fetch'))).toBeNull();
  });
});

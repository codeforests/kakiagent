import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';

const { assistantSettings } = schema;

/**
 * Assistant persona and messages (AGT-08, AGT-11; FEAT-024 §5.1). One row per tenant,
 * absent until the first save, so a missing row reads as the defaults (D1).
 */

export type Tone = 'friendly' | 'professional';

/** A tenant text per reply language; null = the default (D3). */
export interface LocalText {
  en: string | null;
  zh: string | null;
}

/** What the agent needs: the stored values with defaults applied. */
export interface Persona {
  botName: string | null;
  tone: Tone;
  emoji: boolean;
  greeting: LocalText;
  disclosureNote: LocalText;
  afterHoursMessage: LocalText;
  fallbackMessage: LocalText;
}

export interface AssistantPersona extends Persona {
  /** 0 = never saved. */
  version: number;
  updatedAt: Date | null;
}

const NO_TEXT: LocalText = { en: null, zh: null };

export const DEFAULT_PERSONA: AssistantPersona = {
  version: 0,
  botName: null,
  tone: 'friendly',
  emoji: false,
  greeting: NO_TEXT,
  disclosureNote: NO_TEXT,
  afterHoursMessage: NO_TEXT,
  fallbackMessage: NO_TEXT,
  updatedAt: null,
};

/** A save raced another, or used a stale version (FEAT-024 §3.3). */
export class SettingsConflictError extends Error {}

type Row = typeof assistantSettings.$inferSelect;

/** The persona from the stored columns (also the `visitor_tenant_state()` row). */
export function personaOf(r: {
  bot_name: string | null;
  tone: string | null;
  emoji: boolean | null;
  greeting_en: string | null;
  greeting_zh: string | null;
  disclosure_note_en: string | null;
  disclosure_note_zh: string | null;
  after_hours_en: string | null;
  after_hours_zh: string | null;
  fallback_en: string | null;
  fallback_zh: string | null;
}): Persona {
  return {
    botName: r.bot_name,
    // A value the checks can't produce falls back to the default, field by field.
    tone: r.tone === 'professional' ? 'professional' : 'friendly',
    emoji: r.emoji === true,
    greeting: { en: r.greeting_en, zh: r.greeting_zh },
    disclosureNote: { en: r.disclosure_note_en, zh: r.disclosure_note_zh },
    afterHoursMessage: { en: r.after_hours_en, zh: r.after_hours_zh },
    fallbackMessage: { en: r.fallback_en, zh: r.fallback_zh },
  };
}

function fromRow(r: Row): AssistantPersona {
  return {
    ...personaOf({
      bot_name: r.botName,
      tone: r.tone,
      emoji: r.emoji,
      greeting_en: r.greetingEn,
      greeting_zh: r.greetingZh,
      disclosure_note_en: r.disclosureNoteEn,
      disclosure_note_zh: r.disclosureNoteZh,
      after_hours_en: r.afterHoursEn,
      after_hours_zh: r.afterHoursZh,
      fallback_en: r.fallbackEn,
      fallback_zh: r.fallbackZh,
    }),
    version: r.version,
    updatedAt: r.updatedAt,
  };
}

function columnsOf(p: Persona) {
  return {
    botName: p.botName,
    tone: p.tone,
    emoji: p.emoji,
    greetingEn: p.greeting.en,
    greetingZh: p.greeting.zh,
    disclosureNoteEn: p.disclosureNote.en,
    disclosureNoteZh: p.disclosureNote.zh,
    afterHoursEn: p.afterHoursMessage.en,
    afterHoursZh: p.afterHoursMessage.zh,
    fallbackEn: p.fallbackMessage.en,
    fallbackZh: p.fallbackMessage.zh,
  };
}

/** The tenant's settings (dashboard zone); the defaults when never saved. */
export async function getAssistantSettings(tx: Tx, tenantId: string): Promise<AssistantPersona> {
  const [row] = await tx
    .select()
    .from(assistantSettings)
    .where(eq(assistantSettings.tenantId, tenantId));
  return row ? fromRow(row) : DEFAULT_PERSONA;
}

const FIELDS = [
  ['botName', 'bot_name'],
  ['tone', 'tone'],
  ['emoji', 'emoji'],
  ['greeting', 'greeting'],
  ['disclosureNote', 'disclosure_note'],
  ['afterHoursMessage', 'after_hours_message'],
  ['fallbackMessage', 'fallback_message'],
] as const;

/**
 * Saves the whole document if `version` is still current (D9): 0 inserts the first row,
 * n updates row version n to n + 1. Anything else raises `SettingsConflictError` and
 * changes nothing. The audit entry names the changed fields, never their text (ADR-014).
 */
export async function saveAssistantSettings(
  tx: Tx,
  input: { tenantId: string; userId: string; version: number; persona: Persona },
): Promise<AssistantPersona> {
  const { tenantId, version, persona } = input;
  const before = await getAssistantSettings(tx, tenantId);
  const cols = columnsOf(persona);
  const [row] =
    version === 0
      ? await tx
          .insert(assistantSettings)
          .values({ tenantId, ...cols })
          .onConflictDoNothing()
          .returning()
      : await tx
          .update(assistantSettings)
          .set({ ...cols, version: sql`${assistantSettings.version} + 1`, updatedAt: sql`now()` })
          .where(
            and(eq(assistantSettings.tenantId, tenantId), eq(assistantSettings.version, version)),
          )
          .returning();
  if (!row) throw new SettingsConflictError('assistant settings changed');
  const saved = fromRow(row);
  const changed = FIELDS.filter(
    ([key]) => JSON.stringify(before[key]) !== JSON.stringify(saved[key]),
  ).map(([, code]) => auditCode(code));
  await audit.append(tx, tenantId, {
    action: 'settings.assistant_updated',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'assistant_settings',
    subjectId: tenantId,
    payload: { version: saved.version, fields: changed },
  });
  return saved;
}

import type { LocalText, Persona } from '@kaki/tenancy';
import type { ReplyLanguage } from './language.js';

/**
 * System-owned texts (ADR-008 decision 6): rendered, never generated, in the reply
 * language (AGT-03, FEAT-023 D5). FEAT-024 lets the tenant word the disclosure note,
 * the after-hours message and the fallback per language (D2, D3, D7); with no persona
 * every text is FEAT-023's. FEAT-044 and FEAT-049 add their offers of a person and of
 * lead capture.
 */
export interface Texts {
  disclosure(businessName: string): string;
  fallback: string;
  escalation: string;
  outOfScope(businessName: string): string;
  unsure: string;
  afterHours(when: string | null): string;
}

/** The fixed AI disclosure core (AGT-11, FEAT-024 D2): `{name}` and `{business}` are filled. */
const DISCLOSURE_CORE: Record<ReplyLanguage, { named: string; unnamed: string }> = {
  en: {
    named: "You're chatting with {name}, an AI assistant for {business}.",
    unnamed: "You're chatting with an AI assistant for {business}.",
  },
  zh: {
    named: '您正在与 {name} 对话，这是 {business} 的 AI 助手。',
    unnamed: '您正在与 {business} 的 AI 助手聊天。',
  },
};

/** AGT-09: the system-owned return-time sentence (FEAT-023 D6, FEAT-024 D7). */
const AFTER_HOURS_LEAD: Record<ReplyLanguage, { known: string; unknown: string }> = {
  en: {
    known: "We're closed right now. The team will be back {when}.",
    unknown: "We're closed right now, and the team will get back to you as soon as they can.",
  },
  zh: {
    known: '我们现在休息中，团队将于{when}回来。',
    unknown: '我们现在休息中，团队会尽快回复您。',
  },
};

/** The defaults of the texts a tenant may word (SCR-APP-041). */
export const DEFAULT_GREETING: Record<ReplyLanguage, string> = {
  en: 'Ask us anything. We usually reply right away.',
  zh: '有什么问题都可以问我们，我们通常会马上回复。',
};
const DEFAULT_AFTER_HOURS: Record<ReplyLanguage, string> = {
  en: 'I can still answer your questions in the meantime.',
  zh: '在此期间，我仍可以为您解答问题。',
};
/** NFR-04 and the kill switch (architecture §6.5). Lead capture follows with FEAT-049. */
const DEFAULT_FALLBACK: Record<ReplyLanguage, string> = {
  en: 'Thanks for your message. Our team will get back to you soon.',
  zh: '感谢您的留言，我们的团队会尽快回复您。',
};

const FIXED: Record<ReplyLanguage, Pick<Texts, 'escalation' | 'outOfScope' | 'unsure'>> = {
  en: {
    /** UC-20 6a: a reply that failed verification twice. */
    escalation: 'Let me confirm that with the team and get back to you.',
    /** AGT-04: a question unrelated to the business (UC-20 5a). */
    outOfScope: (businessName: string) =>
      `Sorry, I can only help with questions about ${businessName}.`,
    /** AGT-04: low confidence and nothing in the KB, so no guess (UC-20 5a). */
    unsure: "I'm not sure about that, so I'll check with the team and get back to you.",
  },
  zh: {
    escalation: '我先跟团队确认一下，稍后回复您。',
    outOfScope: (businessName: string) => `抱歉，我只能回答与 ${businessName} 有关的问题。`,
    unsure: '这个问题我不太确定，我先跟团队确认，稍后回复您。',
  },
};

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** The tenant's wording in this language, never another language's (D3). */
const pick = (text: LocalText | undefined, lang: ReplyLanguage) => text?.[lang] ?? null;

/** The system texts in a reply language, worded by the tenant where it chose to (FEAT-024). */
export function textsFor(lang: ReplyLanguage, persona?: Persona): Texts {
  if (!persona) return (PLAIN[lang] ??= build(lang));
  return build(lang, persona);
}

const PLAIN: Partial<Record<ReplyLanguage, Texts>> = {};

function build(lang: ReplyLanguage, persona?: Persona): Texts {
  const note = pick(persona?.disclosureNote, lang);
  const core = DISCLOSURE_CORE[lang];
  const name = persona?.botName ?? null;
  return {
    ...FIXED[lang],
    disclosure: (businessName: string) => {
      const base = name
        ? fill(core.named, { name, business: businessName })
        : fill(core.unnamed, { business: businessName });
      return note ? `${base} ${note}` : base;
    },
    fallback: pick(persona?.fallbackMessage, lang) ?? DEFAULT_FALLBACK[lang],
    afterHours: (when: string | null) => {
      const lead = when
        ? fill(AFTER_HOURS_LEAD[lang].known, { when })
        : AFTER_HOURS_LEAD[lang].unknown;
      const message = pick(persona?.afterHoursMessage, lang) ?? DEFAULT_AFTER_HOURS[lang];
      return lang === 'en' ? `${lead} ${message}` : `${lead}${message}`;
    },
  };
}

/** The English texts with no persona. */
export const texts: Texts = textsFor('en');

type PerLang<T> = Record<ReplyLanguage, T>;

export interface AssistantDefaults {
  botName: string;
  greeting: PerLang<string>;
  afterHoursMessage: PerLang<string>;
  fallbackMessage: PerLang<string>;
  /** The core with the business name filled; `{name}` stands for the bot name. */
  disclosureCore: PerLang<{ named: string; unnamed: string }>;
  /** The return-time sentence; `{when}` stands for the next opening. */
  afterHoursLead: PerLang<string>;
}

export const DEFAULT_BOT_NAME = 'Assistant';

/** The defaults SCR-APP-041 shows, from the same templates the turn uses (FEAT-024 §5.2). */
export function assistantDefaults(businessName: string): AssistantDefaults {
  const core = (lang: ReplyLanguage) => ({
    named: fill(DISCLOSURE_CORE[lang].named, { business: businessName }),
    unnamed: fill(DISCLOSURE_CORE[lang].unnamed, { business: businessName }),
  });
  return {
    botName: DEFAULT_BOT_NAME,
    greeting: { ...DEFAULT_GREETING },
    afterHoursMessage: { ...DEFAULT_AFTER_HOURS },
    fallbackMessage: { ...DEFAULT_FALLBACK },
    disclosureCore: { en: core('en'), zh: core('zh') },
    afterHoursLead: { en: AFTER_HOURS_LEAD.en.known, zh: AFTER_HOURS_LEAD.zh.known },
  };
}

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
  /** AGT-07, UC-20 3a: an attempt to change or reveal the assistant's instructions (FEAT-025). */
  injection(businessName: string): string;
  /** AGT-16, UC-20 3d: a claim to be staff, or a request for internal data. */
  impersonation(businessName: string): string;
  /** AGT-13: medical, legal or financial advice. */
  advice(businessName: string): string;
  /** AGT-13: help with something illegal. */
  illegal(businessName: string): string;
  /** AGT-13: self-harm or danger, with SG crisis contacts (`CRISIS_CONTACTS`). */
  crisis: string;
  /** AGT-13: the first abuse turn. */
  abuseWarning(businessName: string): string;
  /** AGT-13: the abuse turn that ends the AI conversation. */
  abuseEnded: string;
  /** The notice on the AI's last message of an ended conversation. */
  chatEnded: string;
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

/**
 * Singapore crisis contacts (AGT-13; FEAT-025 §5.3, D6), reviewed 2026-10-21 against
 * MOH "Mental health services" and IMH's CHAT resources: emergency 995; Samaritans of
 * Singapore 1767 (24 hours) and its WhatsApp CareText 9151 1767; National Mindline 1771
 * (24 hours); Care Corner's Mandarin counselling line 1800 353 5800 (10 am to 10 pm).
 * Re-check yearly and before M6 (FEAT-025 §8). Fixed: a tenant can't edit them.
 */
export const CRISIS_CONTACTS = {
  emergency: '995',
  sos: '1767',
  sosWhatsApp: '9151 1767',
  mindline: '1771',
  careCornerMandarin: '1800 353 5800',
  reviewed: '2026-10-21',
} as const;
const C = CRISIS_CONTACTS;

type FixedKeys =
  | 'escalation'
  | 'outOfScope'
  | 'unsure'
  | 'injection'
  | 'impersonation'
  | 'advice'
  | 'illegal'
  | 'crisis'
  | 'abuseWarning'
  | 'abuseEnded'
  | 'chatEnded';

const FIXED: Record<ReplyLanguage, Pick<Texts, FixedKeys>> = {
  en: {
    /** UC-20 6a: a reply that failed verification twice. */
    escalation: 'Let me confirm that with the team and get back to you.',
    /** AGT-04: a question unrelated to the business (UC-20 5a). */
    outOfScope: (businessName: string) =>
      `Sorry, I can only help with questions about ${businessName}.`,
    /** AGT-04: low confidence and nothing in the KB, so no guess (UC-20 5a). */
    unsure: "I'm not sure about that, so I'll check with the team and get back to you.",
    injection: (b: string) =>
      `I can't change how I work or share my instructions, but I'm happy to help with questions about ${b}.`,
    impersonation: (b: string) =>
      `I can only share public information about ${b} here. If you're on the team, please sign in to the dashboard.`,
    advice: (b: string) =>
      `I can't give medical, legal or financial advice. Please speak to a qualified professional. I'm happy to help with questions about ${b}.`,
    illegal: (b: string) =>
      `Sorry, I can't help with that. I'm happy to help with questions about ${b}.`,
    crisis: `I'm really sorry you're going through this. You don't have to face it alone. If you're in danger right now, call ${C.emergency}. You can talk to someone any time at Samaritans of Singapore on ${C.sos} (or WhatsApp ${C.sosWhatsApp}), or the National Mindline on ${C.mindline}. I've let the team know.`,
    abuseWarning: (b: string) =>
      `I'm here to help with questions about ${b}. Please keep the conversation respectful.`,
    abuseEnded: "I'm ending this chat now. Our team can see this conversation.",
    chatEnded: 'This chat has ended.',
  },
  zh: {
    escalation: '我先跟团队确认一下，稍后回复您。',
    outOfScope: (businessName: string) => `抱歉，我只能回答与 ${businessName} 有关的问题。`,
    unsure: '这个问题我不太确定，我先跟团队确认，稍后回复您。',
    injection: (b: string) =>
      `抱歉，我无法更改我的工作方式或透露我的指令，但很乐意回答与 ${b} 有关的问题。`,
    impersonation: (b: string) =>
      `这里只能提供 ${b} 的公开信息。如果您是团队成员，请登录管理后台。`,
    advice: (b: string) =>
      `我无法提供医疗、法律或财务方面的建议，请咨询相关专业人士。很乐意回答与 ${b} 有关的问题。`,
    illegal: (b: string) => `抱歉，这个我帮不了。很乐意回答与 ${b} 有关的问题。`,
    crisis: `听到您这么难受，我真的很难过。您不需要独自面对。如果您现在有危险，请拨打 ${C.emergency}。您可以随时拨打新加坡援人协会（SOS）热线 ${C.sos}（或 WhatsApp ${C.sosWhatsApp}），或全国心理健康热线 ${C.mindline}。如需华语辅导，可拨打 Care Corner 热线 ${C.careCornerMandarin}（每天上午10点至晚上10点）。我已通知团队。`,
    abuseWarning: (b: string) => `我很乐意回答与 ${b} 有关的问题，请保持礼貌。`,
    abuseEnded: '我现在结束这次对话。我们的团队可以看到这段对话。',
    chatEnded: '本次对话已结束。',
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

/** The fixed texts a safety task ends the turn with (FEAT-025 §5.2, D7). */
export type SafetyKey = 'crisis' | 'abuse_warning' | 'abuse_ended';

/** The text a safety task ends the turn with (FEAT-025 D7). */
export function safetyText(t: Texts, key: SafetyKey, businessName: string): string {
  switch (key) {
    case 'crisis':
      return t.crisis;
    case 'abuse_warning':
      return t.abuseWarning(businessName);
    case 'abuse_ended':
      return t.abuseEnded;
  }
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

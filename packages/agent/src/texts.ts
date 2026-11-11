import type { LocalText, Persona } from '@kaki/tenancy';
import { formatNextOpen } from './hours-text.js';
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
  /** APR-01: a topic the business doesn't discuss (FEAT-054). */
  blockedTopic(businessName: string): string;
  /** AGT-13: self-harm or danger, with SG crisis contacts (`CRISIS_CONTACTS`). */
  crisis: string;
  /** AGT-13: the first abuse turn. */
  abuseWarning(businessName: string): string;
  /** AGT-13: the abuse turn that ends the AI conversation. */
  abuseEnded: string;
  /** The notice on the AI's last message of an ended conversation. */
  chatEnded: string;
  /** FEAT-049: the reply that carries the consent card when the visitor offers their details. */
  leadConsent: string;
  /** FEAT-049: the reply that carries the lead form once they agreed. */
  leadForm: string;
  /** FEAT-051: the reply that carries the withdraw confirm card. */
  withdrawConfirm(businessName: string): string;
  /** FEAT-051: the contact has already withdrawn. */
  withdrawAlready(businessName: string): string;
  /** FEAT-051: nothing is held from this visitor (D2). */
  withdrawNone(businessName: string): string;
  /** FEAT-051: a deletion request was passed to the team (until FEAT-061, D5). */
  dataRequest(businessName: string): string;
  /** FEAT-038: the reply that carries the handoff card. */
  handoffOffer: string;
  /** FEAT-038: no other channel is live. */
  handoffNone: string;
}

/**
 * The fixed AI disclosure core (AGT-11, FEAT-024 D2): `{name}` and `{business}` are filled.
 * FEAT-044 adds design.md §6's take-over sentence, now that a person can be asked for.
 */
const DISCLOSURE_CORE: Record<ReplyLanguage, { named: string; unnamed: string }> = {
  en: {
    named:
      "You're chatting with {name}, an AI assistant for {business}. A person can take over at any time.",
    unnamed:
      "You're chatting with an AI assistant for {business}. A person can take over at any time.",
  },
  zh: {
    named: '您正在与 {name} 对话，这是 {business} 的 AI 助手。您可以随时要求真人客服接手。',
    unnamed: '您正在与 {business} 的 AI 助手聊天。您可以随时要求真人客服接手。',
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
  | 'blockedTopic'
  | 'crisis'
  | 'abuseWarning'
  | 'abuseEnded'
  | 'chatEnded'
  | 'leadConsent'
  | 'leadForm'
  | 'withdrawConfirm'
  | 'withdrawAlready'
  | 'withdrawNone'
  | 'dataRequest'
  | 'handoffOffer'
  | 'handoffNone';

const FIXED: Record<ReplyLanguage, Pick<Texts, FixedKeys>> = {
  en: {
    /** UC-20 6a: a reply that failed verification twice. */
    escalation: 'Let me confirm that with the team and get back to you.',
    /** AGT-04: a question unrelated to the business (UC-20 5a). */
    outOfScope: (businessName: string) =>
      `Sorry, I can only help with questions about ${businessName}.`,
    /** AGT-04: low confidence and nothing in the KB, so no guess (UC-20 5a); FEAT-044 offers a person. */
    unsure:
      "I'm not sure about that, so I won't guess. If you'd like, ask for a person and someone from the team will help.",
    injection: (b: string) =>
      `I can't change how I work or share my instructions, but I'm happy to help with questions about ${b}.`,
    impersonation: (b: string) =>
      `I can only share public information about ${b} here. If you're on the team, please sign in to the dashboard.`,
    advice: (b: string) =>
      `I can't give medical, legal or financial advice. Please speak to a qualified professional. I'm happy to help with questions about ${b}.`,
    illegal: (b: string) =>
      `Sorry, I can't help with that. I'm happy to help with questions about ${b}.`,
    blockedTopic: (b: string) =>
      `Sorry, I can't help with that here. I'm happy to help with other questions about ${b}.`,
    crisis: `I'm really sorry you're going through this. You don't have to face it alone. If you're in danger right now, call ${C.emergency}. You can talk to someone any time at Samaritans of Singapore on ${C.sos} (or WhatsApp ${C.sosWhatsApp}), or the National Mindline on ${C.mindline}. I've let the team know.`,
    abuseWarning: (b: string) =>
      `I'm here to help with questions about ${b}. Please keep the conversation respectful.`,
    abuseEnded: "I'm ending this chat now. Our team can see this conversation.",
    chatEnded: 'This chat has ended.',
    leadConsent: 'I can pass your details to the team so they can get back to you.',
    leadForm: 'Please fill in your details below.',
    withdrawConfirm: (b: string) =>
      `Sure. Do you want ${b} to stop using your contact details? Choose below.`,
    withdrawAlready: (b: string) =>
      `You've already asked ${b} to stop using your details, and they have.`,
    withdrawNone: (b: string) =>
      `${b} doesn't have contact details from you in this chat. If you gave them another way, tell the team and they'll stop using them.`,
    dataRequest: (b: string) =>
      `I've passed your request about your personal data to the ${b} team. They'll get back to you.`,
    handoffOffer: 'Sure. Where would you like to continue?',
    handoffNone: 'For now we can only chat here.',
  },
  zh: {
    escalation: '我先跟团队确认一下，稍后回复您。',
    outOfScope: (businessName: string) => `抱歉，我只能回答与 ${businessName} 有关的问题。`,
    unsure: '这个问题我不太确定，所以不乱猜。如需要，您可以要求转人工，团队成员会来协助您。',
    injection: (b: string) =>
      `抱歉，我无法更改我的工作方式或透露我的指令，但很乐意回答与 ${b} 有关的问题。`,
    impersonation: (b: string) =>
      `这里只能提供 ${b} 的公开信息。如果您是团队成员，请登录管理后台。`,
    advice: (b: string) =>
      `我无法提供医疗、法律或财务方面的建议，请咨询相关专业人士。很乐意回答与 ${b} 有关的问题。`,
    illegal: (b: string) => `抱歉，这个我帮不了。很乐意回答与 ${b} 有关的问题。`,
    blockedTopic: (b: string) =>
      `抱歉，这个问题我无法在这里回答。关于 ${b} 的其他问题，我很乐意为您解答。`,
    crisis: `听到您这么难受，我真的很难过。您不需要独自面对。如果您现在有危险，请拨打 ${C.emergency}。您可以随时拨打新加坡援人协会（SOS）热线 ${C.sos}（或 WhatsApp ${C.sosWhatsApp}），或全国心理健康热线 ${C.mindline}。如需华语辅导，可拨打 Care Corner 热线 ${C.careCornerMandarin}（每天上午10点至晚上10点）。我已通知团队。`,
    abuseWarning: (b: string) => `我很乐意回答与 ${b} 有关的问题，请保持礼貌。`,
    abuseEnded: '我现在结束这次对话。我们的团队可以看到这段对话。',
    chatEnded: '本次对话已结束。',
    leadConsent: '我可以把您的资料转给团队，让他们联系您。',
    leadForm: '请在下方填写您的资料。',
    withdrawConfirm: (b: string) => `好的。您希望 ${b} 停止使用您的联系资料吗？请在下方选择。`,
    withdrawAlready: (b: string) => `您已要求 ${b} 停止使用您的资料，他们已照办。`,
    withdrawNone: (b: string) =>
      `${b} 在这次对话中没有您的联系资料。如果您是通过其他方式提供的，请告诉团队，他们会停止使用。`,
    dataRequest: (b: string) => `我已把您关于个人资料的请求转给 ${b} 团队，他们会尽快回复您。`,
    handoffOffer: '好的。您想在哪里继续聊？',
    handoffNone: '目前我们只能在这里聊天。',
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

/**
 * The visitor's escalation notice (INB-05, AGT-09, UC-23 2a; FEAT-044 §5.1 step 4): in hours,
 * the team is joining; after hours, when they'll reply (`formatNextOpen`, SGT). The AI keeps
 * answering meanwhile (D9). Rendered here and passed to inbox `requestEscalation`.
 */
export function escalationNotice(
  lang: ReplyLanguage,
  afterHours: boolean,
  nextOpen: Date | null,
  now: Date,
): string {
  if (!afterHours)
    return lang === 'zh'
      ? '我已请团队成员加入，很快会有人来协助您；在此之前，我可以继续回答您的问题。'
      : "I've asked the team to join. Someone will be with you shortly; I can keep answering questions until then.";
  if (lang === 'zh') {
    const when = nextOpen ? `于${formatNextOpen(nextOpen, now, 'zh')}起` : '营业后';
    return `我已通知团队。我们现在休息，团队将${when}回复您；在此之前，我可以继续回答您的问题。`;
  }
  // "from tomorrow at 8:00 am", but "on Tue 10 Nov at 8:00 am" (no "from on").
  const at = nextOpen ? formatNextOpen(nextOpen, now, 'en') : null;
  const when = at ? (at.startsWith('on ') ? at : `from ${at}`) : "when we're next open";
  return `I've let the team know. We're closed now, so they'll reply ${when}. I can keep answering questions until then.`;
}

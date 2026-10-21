import type { ReplyLanguage } from './language.js';

/**
 * System-owned texts (ADR-008 decision 6): rendered, never generated, in the reply
 * language (AGT-03, FEAT-023 D5). FEAT-024 makes the disclosure and the after-hours
 * message tenant-editable; FEAT-044 and FEAT-049 add their offers of a person and of
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

const TEXTS: Record<ReplyLanguage, Texts> = {
  en: {
    /** AGT-11. design.md §6 default, without "a person can take over" until FEAT-044. */
    disclosure: (businessName: string) =>
      `You're chatting with an AI assistant for ${businessName}.`,
    /** NFR-04 and the kill switch (architecture §6.5). Lead capture follows with FEAT-049. */
    fallback: 'Thanks for your message. Our team will get back to you soon.',
    /** UC-20 6a: a reply that failed verification twice. */
    escalation: 'Let me confirm that with the team and get back to you.',
    /** AGT-04: a question unrelated to the business (UC-20 5a). */
    outOfScope: (businessName: string) =>
      `Sorry, I can only help with questions about ${businessName}.`,
    /** AGT-04: low confidence and nothing in the KB, so no guess (UC-20 5a). */
    unsure: "I'm not sure about that, so I'll check with the team and get back to you.",
    /** AGT-09: `when` is the rendered next opening ("tomorrow at 9:00 am"), or null. */
    afterHours: (when: string | null) =>
      when
        ? `We're closed right now. The team will be back ${when}. I can still answer your questions in the meantime.`
        : "We're closed right now, and the team will get back to you as soon as they can. I can still answer your questions in the meantime.",
  },
  zh: {
    disclosure: (businessName: string) => `您正在与 ${businessName} 的 AI 助手聊天。`,
    fallback: '感谢您的留言，我们的团队会尽快回复您。',
    escalation: '我先跟团队确认一下，稍后回复您。',
    outOfScope: (businessName: string) => `抱歉，我只能回答与 ${businessName} 有关的问题。`,
    unsure: '这个问题我不太确定，我先跟团队确认，稍后回复您。',
    afterHours: (when: string | null) =>
      when
        ? `我们现在休息中，团队将于${when}回来。在此期间，我仍可以为您解答问题。`
        : '我们现在休息中，团队会尽快回复您。在此期间，我仍可以为您解答问题。',
  },
};

/** The system texts in a reply language. */
export function textsFor(lang: ReplyLanguage): Texts {
  return TEXTS[lang];
}

/** The English texts. */
export const texts: Texts = TEXTS.en;

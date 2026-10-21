import type { TurnPlan } from './plan.js';

/** The languages the agent replies in (AGT-03, NFR-10; FEAT-023 D4). */
export type ReplyLanguage = 'en' | 'zh';

export const LANGUAGE_NAMES: Record<ReplyLanguage, string> = {
  en: 'English',
  zh: 'Chinese (Simplified)',
};

const HAN = /\p{Script=Han}/u;

/**
 * The reply language: triage's `zh` or `en`; for Malay, Tamil, other and the fallback
 * plan, Chinese if the visitor wrote Han characters, else English (D4).
 */
export function replyLanguage(
  plan: Pick<TurnPlan, 'language' | 'fallback'> | null,
  visitorText: string,
): ReplyLanguage {
  if (plan && !plan.fallback) {
    if (plan.language === 'zh') return 'zh';
    if (plan.language === 'en') return 'en';
  }
  return HAN.test(visitorText) ? 'zh' : 'en';
}

/** True when the text contains Chinese characters (the widget's language-of-parts rule uses the same test). */
export function hasHan(text: string): boolean {
  return HAN.test(text);
}

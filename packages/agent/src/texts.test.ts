import type { Persona } from '@kaki/tenancy';
import { describe, expect, it } from 'vitest';
import {
  assistantDefaults,
  escalationNotice,
  CRISIS_CONTACTS,
  DEFAULT_GREETING,
  safetyText,
  texts,
  textsFor,
} from './texts.js';

const NONE = { en: null, zh: null };
const persona = (p: Partial<Persona> = {}): Persona => ({
  botName: null,
  tone: 'friendly',
  emoji: false,
  greeting: NONE,
  disclosureNote: NONE,
  afterHoursMessage: NONE,
  fallbackMessage: NONE,
  ...p,
});

describe('system texts with a persona (FEAT-024 §5.2; AC-5, AC-6, AC-7)', () => {
  it('without a persona, or with the defaults, every text is FEAT-023 byte for byte', () => {
    for (const t of [textsFor('en'), textsFor('en', persona()), texts]) {
      expect(t.disclosure('Kaki Bakery')).toBe(
        "You're chatting with an AI assistant for Kaki Bakery. A person can take over at any time.",
      );
      expect(t.fallback).toBe('Thanks for your message. Our team will get back to you soon.');
      expect(t.afterHours('tomorrow at 8:00 am')).toBe(
        "We're closed right now. The team will be back tomorrow at 8:00 am. I can still answer your questions in the meantime.",
      );
      expect(t.afterHours(null)).toBe(
        "We're closed right now, and the team will get back to you as soon as they can. I can still answer your questions in the meantime.",
      );
    }
    const zh = textsFor('zh', persona());
    expect(zh.disclosure('Kaki Bakery')).toBe(
      '您正在与 Kaki Bakery 的 AI 助手聊天。您可以随时要求真人客服接手。',
    );
    expect(zh.fallback).toBe('感谢您的留言，我们的团队会尽快回复您。');
    expect(zh.afterHours('明天上午8:00')).toBe(
      '我们现在休息中，团队将于明天上午8:00回来。在此期间，我仍可以为您解答问题。',
    );
    expect(zh.afterHours(null)).toBe(
      '我们现在休息中，团队会尽快回复您。在此期间，我仍可以为您解答问题。',
    );
  });

  it('names the bot in the core and appends the note, in both languages', () => {
    const p = persona({
      botName: 'Kaki',
      disclosureNote: { en: 'Our team reads every chat.', zh: '我们的团队会阅读每条对话。' },
    });
    expect(textsFor('en', p).disclosure('Kaki Bakery')).toBe(
      "You're chatting with Kaki, an AI assistant for Kaki Bakery. A person can take over at any time. Our team reads every chat.",
    );
    expect(textsFor('zh', p).disclosure('Kaki Bakery')).toBe(
      '您正在与 Kaki 对话，这是 Kaki Bakery 的 AI 助手。您可以随时要求真人客服接手。 我们的团队会阅读每条对话。',
    );
    expect(textsFor('en', persona({ botName: 'Mei' })).disclosure('Kaki Bakery')).toBe(
      "You're chatting with Mei, an AI assistant for Kaki Bakery. A person can take over at any time.",
    );
  });

  it("uses the tenant's fallback and after-hours message, keeping the return time", () => {
    const p = persona({
      fallbackMessage: { en: 'We reply within a day.', zh: '我们会在一天内回复。' },
      afterHoursMessage: { en: 'Leave a message and we will call you back.', zh: null },
    });
    expect(textsFor('en', p).fallback).toBe('We reply within a day.');
    expect(textsFor('zh', p).fallback).toBe('我们会在一天内回复。');
    expect(textsFor('en', p).afterHours('tomorrow at 8:00 am')).toBe(
      "We're closed right now. The team will be back tomorrow at 8:00 am. Leave a message and we will call you back.",
    );
    expect(textsFor('en', p).afterHours(null)).toMatch(
      /as soon as they can\. Leave a message and we will call you back\.$/,
    );
  });

  it('a Chinese turn never shows the English wording: it gets the Chinese default', () => {
    const p = persona({
      disclosureNote: { en: 'English only note.', zh: null },
      fallbackMessage: { en: 'English only fallback.', zh: null },
      afterHoursMessage: { en: 'English only message.', zh: null },
    });
    const zh = textsFor('zh', p);
    expect(zh.disclosure('Kaki Bakery')).toBe(
      '您正在与 Kaki Bakery 的 AI 助手聊天。您可以随时要求真人客服接手。',
    );
    expect(zh.fallback).toBe('感谢您的留言，我们的团队会尽快回复您。');
    expect(zh.afterHours('明天上午8:00')).not.toMatch(/English/);
  });

  it('assistantDefaults renders the business name into the cores and keeps the placeholders', () => {
    const d = assistantDefaults('Kaki Bakery');
    expect(d.botName).toBe('Assistant');
    expect(d.greeting).toEqual(DEFAULT_GREETING);
    expect(d.disclosureCore.en).toEqual({
      named:
        "You're chatting with {name}, an AI assistant for Kaki Bakery. A person can take over at any time.",
      unnamed:
        "You're chatting with an AI assistant for Kaki Bakery. A person can take over at any time.",
    });
    expect(d.disclosureCore.zh.named).toBe(
      '您正在与 {name} 对话，这是 Kaki Bakery 的 AI 助手。您可以随时要求真人客服接手。',
    );
    expect(d.afterHoursLead.en).toBe("We're closed right now. The team will be back {when}.");
    expect(d.fallbackMessage.en).toBe(texts.fallback);
    expect(d.afterHoursMessage.zh).toBe('在此期间，我仍可以为您解答问题。');
  });
});

describe('safety texts (FEAT-025 §5.3, D6)', () => {
  it('has every safety text in both languages, with the business name where it belongs', () => {
    for (const lang of ['en', 'zh'] as const) {
      const t = textsFor(lang, persona({ fallbackMessage: { en: 'x', zh: 'y' } }));
      for (const f of [t.injection, t.impersonation, t.advice, t.illegal, t.abuseWarning])
        expect(f('Kaki Bakery')).toContain('Kaki Bakery');
      for (const s of [t.crisis, t.abuseEnded, t.chatEnded]) expect(s.length).toBeGreaterThan(5);
    }
  });

  it('the crisis text carries the SG contacts in both languages; Chinese adds the Mandarin line', () => {
    const { emergency, sos, sosWhatsApp, mindline, careCornerMandarin } = CRISIS_CONTACTS;
    for (const lang of ['en', 'zh'] as const)
      for (const n of [emergency, sos, sosWhatsApp, mindline])
        expect(textsFor(lang).crisis).toContain(n);
    expect(textsFor('zh').crisis).toContain(careCornerMandarin);
    expect(textsFor('zh').crisis).toMatch(/\p{Script=Han}/u);
    expect(textsFor('en').crisis).not.toMatch(/\p{Script=Han}/u);
  });

  it('safetyText renders each key, and tenant wording never replaces a safety text', () => {
    const t = textsFor('en', persona({ fallbackMessage: { en: 'Custom', zh: null } }));
    expect(safetyText(t, 'crisis', 'Kaki Bakery')).toBe(textsFor('en').crisis);
    expect(safetyText(t, 'abuse_warning', 'Kaki Bakery')).toBe(
      "I'm here to help with questions about Kaki Bakery. Please keep the conversation respectful.",
    );
    expect(safetyText(textsFor('zh'), 'abuse_ended', 'Kaki Bakery')).toBe(
      '我现在结束这次对话。我们的团队可以看到这段对话。',
    );
  });
});

describe('escalation texts (FEAT-044 §5.1, §5.4; AC-1, AC-6, AC-8)', () => {
  const now = new Date('2026-11-02T13:00:00Z'); // Mon 21:00 SGT
  const next = new Date('2026-11-03T00:00:00Z'); // Tue 08:00 SGT

  it('in hours the team is joining; the AI keeps answering', () => {
    expect(escalationNotice('en', false, null, now)).toBe(
      "I've asked the team to join. Someone will be with you shortly; I can keep answering questions until then.",
    );
    expect(escalationNotice('zh', false, null, now)).toBe(
      '我已请团队成员加入，很快会有人来协助您；在此之前，我可以继续回答您的问题。',
    );
  });

  it('after hours it gives the next opening in SGT, or says when next open', () => {
    expect(escalationNotice('en', true, next, now)).toBe(
      "I've let the team know. We're closed now, so they'll reply from tomorrow at 8:00 am. I can keep answering questions until then.",
    );
    expect(escalationNotice('zh', true, next, now)).toBe(
      '我已通知团队。我们现在休息，团队将于明天上午8:00起回复您；在此之前，我可以继续回答您的问题。',
    );
    // A later day reads "on Tue 10 Nov at …", never "from on …".
    const later = new Date(next.getTime() + 3 * 86_400_000);
    expect(escalationNotice('en', true, later, now)).toMatch(
      /they'll reply on \w{3} \d{1,2} \w{3} at /,
    );
    expect(escalationNotice('en', true, null, now)).toContain(
      "they'll reply when we're next open.",
    );
    expect(escalationNotice('zh', true, null, now)).toContain('团队将营业后回复您');
  });

  it('the unsure reply offers a person and the disclosure says a person can take over (AGT-04, AGT-11)', () => {
    expect(textsFor('en').unsure).toContain('ask for a person');
    expect(textsFor('zh').unsure).toContain('转人工');
    expect(textsFor('en').disclosure('Kaki Bakery')).toBe(
      "You're chatting with an AI assistant for Kaki Bakery. A person can take over at any time.",
    );
    expect(textsFor('zh').disclosure('Kaki Bakery')).toBe(
      '您正在与 Kaki Bakery 的 AI 助手聊天。您可以随时要求真人客服接手。',
    );
  });
});

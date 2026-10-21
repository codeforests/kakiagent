import { describe, expect, it } from 'vitest';
import { replyLanguage } from './language.js';
import { FALLBACK_PLAN } from './plan.js';
import { texts, textsFor } from './texts.js';

const plan = (language: 'en' | 'zh' | 'ms' | 'ta' | 'other') => ({ language, fallback: false });

describe('replyLanguage (FEAT-023 AC-1, D4)', () => {
  it("follows triage's en and zh", () => {
    expect(replyLanguage(plan('zh'), 'hello')).toBe('zh');
    expect(replyLanguage(plan('en'), '你好')).toBe('en');
  });

  it('uses the script for ms, ta, other, the fallback plan and no plan', () => {
    for (const p of [plan('ms'), plan('ta'), plan('other'), FALLBACK_PLAN, null]) {
      expect(replyLanguage(p, '请问周末营业时间？')).toBe('zh');
      expect(replyLanguage(p, 'boleh saya tahu harga kek?')).toBe('en');
    }
  });

  it('reads a fallback plan by script even when it names a language', () => {
    expect(replyLanguage({ language: 'en', fallback: true }, '多少钱')).toBe('zh');
  });
});

describe('system texts (FEAT-023 D5)', () => {
  it('keeps the English texts and adds Chinese ones for every key', () => {
    expect(texts).toBe(textsFor('en'));
    expect(textsFor('en').fallback).toBe(
      'Thanks for your message. Our team will get back to you soon.',
    );
    const en = textsFor('en');
    const zh = textsFor('zh');
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(zh.disclosure('Kaki Bakery')).toBe('您正在与 Kaki Bakery 的 AI 助手聊天。');
    expect(zh.outOfScope('Kaki Bakery')).toContain('Kaki Bakery');
    expect(en.afterHours('tomorrow at 8:00 am')).toBe(
      "We're closed right now. The team will be back tomorrow at 8:00 am. I can still answer your questions in the meantime.",
    );
    expect(zh.afterHours('明天上午8:00')).toContain('团队将于明天上午8:00回来');
    expect(en.afterHours(null)).toContain('as soon as they can');
  });
});

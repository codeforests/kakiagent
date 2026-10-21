import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  type FakeScript,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import type { Persona } from '@kaki/tenancy';
import { describe, expect, it } from 'vitest';
import { composeReply, type ComposeInput } from './compose.js';
import { fakeVisitorResponder } from './fake-responder.js';
import { buildVisitorPrompt } from './prompt.js';
import { assignRefs } from './slots.js';
import { FUDGE } from './testing/facts.js';

/** FEAT-024 §5.3 (AC-3, AC-4): the persona in the prompt, emoji off in code, and the fake. */

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
const meta = { tenantId: '11111111-1111-4111-8111-111111111111' };
const P = assignRefs([FUDGE]).refOf.get(FUDGE.id)!;

const prompt = (
  p: Persona | undefined,
  opts: { now?: Date; language?: 'en' | 'zh'; register?: 'standard' | 'singlish' } = {},
) =>
  buildVisitorPrompt({
    businessName: 'Kaki Bakery',
    gstRegistered: true,
    facts: assignRefs([FUDGE]),
    ordered: [FUDGE],
    history: [{ role: 'user', content: 'how much is the fudge cake?' }],
    now: opts.now ?? new Date('2026-10-21T03:00:00Z'),
    meta,
    model: 'reply.simple',
    language: opts.language,
    register: opts.register,
    persona: p,
  });

describe('persona in the prompt (AC-3)', () => {
  const named = persona({ botName: 'Kaki', tone: 'professional' });

  it('puts name, tone and emoji in the cached system block, never in the tail', () => {
    const r = prompt(named);
    expect(r.system).toContain('<assistant>\nName: Kaki\n');
    expect(r.system).toMatch(/^Tone: professional\. .*no Singlish particles/m);
    expect(r.system).toContain('Emoji: never.');
    expect(r.tail).not.toMatch(/Tone:|Emoji:|Name: Kaki/);
    expect(prompt(persona({ emoji: true })).system).toMatch(/^Emoji: allowed/m);
    expect(prompt(persona()).system).toMatch(/^Tone: friendly\. /m);
    expect(prompt(persona()).system).not.toMatch(/^Name: (?!Kaki Bakery)/m);
  });

  it('is byte-identical across languages, registers and times for one persona', () => {
    const a = prompt(named, { language: 'en', register: 'singlish' });
    const b = prompt(named, {
      language: 'zh',
      register: 'standard',
      now: new Date('2026-12-31T16:30:00Z'),
    });
    expect(b.system).toBe(a.system);
  });

  it('changes after any persona change', () => {
    const base = prompt(named).system;
    for (const p of [
      { ...named, botName: 'Mei' },
      { ...named, botName: null },
      { ...named, tone: 'friendly' as const },
      { ...named, emoji: true },
    ])
      expect(prompt(p).system).not.toBe(base);
  });

  it('without a persona the prompt has no assistant block (callers before FEAT-024)', () => {
    expect(prompt(undefined).system).not.toContain('<assistant>');
  });
});

function compose(script: FakeScript, p: Persona | undefined) {
  const llm = createGateway(defaultRegistry('fake'), [createFakeProvider(script)]);
  const published: string[] = [];
  const input: ComposeInput = {
    facts: [FUDGE],
    history: [{ role: 'user', content: 'how much is the fudge cake?' }],
    businessName: 'Kaki Bakery',
    gstRegistered: true,
    meta,
    persona: p,
  };
  return composeReply(input, {
    llm,
    gateOpen: async () => true,
    publish: async (s) => {
      published.push(s.text);
    },
  }).then((result) => ({ result, published }));
}

describe('emoji off is enforced in code (AC-4, D4)', () => {
  const typed = `Sure! 😊 The [[f:${P}.name]] is [[f:${P}.price]] 🎂.`;

  it('strips model emoji before render and verify, with slot values intact', async () => {
    const { result, published } = await compose(() => typed, persona({ emoji: false }));
    expect(result.outcome).toBe('answered');
    expect(published.join(' ')).toBe('Sure! The Chocolate fudge cake is S$55.00.');
    expect(result.text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(result.emojiRemoved).toBe(true);
    expect(result.factIds).toEqual([FUDGE.id]);
  });

  it('keeps them with emoji on, and without a persona', async () => {
    for (const p of [persona({ emoji: true }), undefined]) {
      const { result } = await compose(() => typed, p);
      expect(result.text).toContain('😊');
      expect(result.emojiRemoved).toBe(false);
    }
  });

  it('an emoji-only segment is dropped, not released empty', async () => {
    const { published } = await compose(
      () => `The [[f:${P}.name]] is [[f:${P}.price]]. 👍`,
      persona({ emoji: false }),
    );
    expect(published).toEqual(['The Chocolate fudge cake is S$55.00.']);
  });
});

describe('the fake responder follows the persona (AC-4)', () => {
  const ask = (p: Persona, question: string, language: 'en' | 'zh' = 'en') => {
    const req: GenerateRequest = {
      ...prompt(p, { language }),
      messages: [{ role: 'user', content: question }],
    };
    return fakeVisitorResponder(req);
  };

  it('adds one emoji only for a friendly tone with emoji on', () => {
    expect(ask(persona({ emoji: true }), 'how much is the fudge cake?')).toMatch(/ 🙂$/);
    expect(ask(persona({ emoji: false }), 'how much is the fudge cake?')).not.toMatch(/🙂/);
    expect(
      ask(persona({ emoji: true, tone: 'professional' }), 'how much is the fudge cake?'),
    ).not.toMatch(/🙂/);
  });

  it('answers the name question with the bot name, in both languages', () => {
    expect(ask(persona({ botName: 'Kaki' }), "what's your name?")).toBe(
      "I'm Kaki, the AI assistant here. How can I help?",
    );
    expect(ask(persona({ botName: 'Kaki' }), '你叫什么名字？', 'zh')).toBe(
      '我是Kaki，这里的 AI 助手。有什么可以帮您？',
    );
    expect(ask(persona(), "what's your name?")).not.toMatch(/^I'm /);
  });
});

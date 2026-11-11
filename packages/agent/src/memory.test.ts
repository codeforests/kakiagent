import { gatewayFromConfig, type GenerateRequest } from '@kaki/llm-gateway';
import { describe, expect, it } from 'vitest';
import { fakeAgentScript } from './fake-coach.js';
import { fakeSummary } from './fake-memory.js';
import {
  cleanMemory,
  EMPTY_MEMORY,
  foldPlan,
  MEMORY_FOLD_AT,
  memoryLines,
  parseMemory,
  summarise,
  summaryRequest,
  SUMMARY_SYSTEM,
  type ConversationMemory,
  type MemoryMessage,
} from './memory.js';

const meta = { tenantId: '00000000-0000-4000-8000-000000000001', purpose: 'summarise' as const };
const msgs = (...bodies: [MemoryMessage['author'], string][]): MemoryMessage[] =>
  bodies.map(([author, body], i) => ({ seq: i + 1, author, body }));
const mem = (over: Partial<ConversationMemory>): ConversationMemory => ({
  ...EMPTY_MEMORY,
  ...over,
});

describe('foldPlan (FEAT-026 §5.1)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 101 }));
  it('is not due below 20 unfolded messages', () => {
    expect(foldPlan(rows(MEMORY_FOLD_AT - 1)).due).toBe(false);
  });
  it('folds all but the last 10 once 20 are unfolded', () => {
    expect(foldPlan(rows(20))).toEqual({ due: true, cutoffSeq: 110 });
    expect(foldPlan(rows(27))).toEqual({ due: true, cutoffSeq: 117 });
  });
});

describe('cleanMemory (D2, AC-5)', () => {
  it('drops contact details and amounts, masks identity numbers, trims and de-duplicates', () => {
    const out = cleanMemory(
      mem({
        visitorName: '  Siti  ',
        items: [
          { what: 'pineapple tarts', quantity: '40 boxes' },
          { what: 'pineapple tarts', quantity: '40 boxes' },
          { what: 'kueh lapis', quantity: 'S$12 each' },
        ],
        dates: ['14 Dec'],
        preferences: ['eggless', 'send to siti@example.com', 'call me 9123 4567'],
        openQuestions: ['is it S$ 20?', 'can deliver to Tampines?'],
        notes: ['NRIC S1234567D', 'budget 50元', 'paid $5 deposit'],
      }),
    );
    expect(out.visitorName).toBe('Siti');
    expect(out.items).toEqual([
      { what: 'pineapple tarts', quantity: '40 boxes' },
      { what: 'kueh lapis', quantity: null },
    ]);
    expect(out.preferences).toEqual(['eggless']);
    expect(out.openQuestions).toEqual(['can deliver to Tampines?']);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).not.toContain('S1234567D');
  });
});

describe('parseMemory', () => {
  it('cuts long lists and strings instead of rejecting them; rejects non-objects', () => {
    const m = parseMemory({
      visitorName: 'x'.repeat(100),
      items: Array.from({ length: 12 }, (_, i) => ({ what: `item ${i}`, quantity: null })),
      dates: [],
      preferences: [],
      openQuestions: [],
      notes: ['n', 3],
    });
    expect(m?.visitorName).toHaveLength(60);
    expect(m?.items).toHaveLength(8);
    expect(m?.notes).toEqual(['n']);
    expect(parseMemory([])).toBeNull();
    expect(parseMemory('x')).toBeNull();
  });
});

describe('memoryLines', () => {
  const m = mem({
    visitorName: 'Siti <b>',
    items: [{ what: 'pineapple tarts', quantity: '40' }],
    dates: ['14 Dec'],
  });
  it('fences the memory as data and leaves out empty fields', () => {
    expect(memoryLines(m)).toEqual([
      '<memory>',
      'name: Siti ‹b›',
      'wants: pineapple tarts | quantity: 40',
      'date: 14 Dec',
      '</memory>',
    ]);
  });
  it('leaves the name out for triage, and gives nothing for an empty memory', () => {
    expect(memoryLines(m, { name: false }).join('\n')).not.toContain('Siti');
    expect(memoryLines(EMPTY_MEMORY)).toEqual([]);
    expect(memoryLines(mem({ visitorName: 'Siti' }), { name: false })).toEqual([]);
    expect(memoryLines(null)).toEqual([]);
  });
});

describe('summarise and the fake summariser (§5.5)', () => {
  const llm = gatewayFromConfig({ provider: 'fake', fakeScript: fakeAgentScript });
  it('builds the memory from visitor lines only, on top of the previous memory', async () => {
    const first = await summarise(llm, {
      previous: null,
      messages: msgs(
        ['visitor', "Hi, I'm Siti. I need 40 boxes of pineapple tarts for 14 Dec"],
        ['agent', 'Sure, 50 boxes are S$10 each'],
        ['system', ''],
      ),
      meta,
    });
    expect(first).toMatchObject({
      visitorName: 'Siti',
      items: [{ what: 'boxes of pineapple tarts', quantity: '40' }],
      dates: ['14 Dec'],
    });
    const second = await summarise(llm, {
      previous: first,
      messages: msgs(['visitor', 'make it 30 not 40 please']),
      meta,
    });
    expect(second?.items).toEqual([{ what: 'boxes of pineapple tarts', quantity: '30' }]);
    expect(second?.visitorName).toBe('Siti');
  });
  it('reads Chinese names, quantities and dates', () => {
    const req: GenerateRequest = {
      model: 'summarise',
      system: SUMMARY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: summaryRequest(null, msgs(['visitor', '我叫美玲，要40盒凤梨酥，12月14日'])),
        },
      ],
      maxTokens: 500,
      meta,
    };
    expect(JSON.parse(fakeSummary(req))).toMatchObject({
      visitorName: '美玲',
      items: [{ what: '盒凤梨酥', quantity: '40' }],
      dates: ['12月14日'],
    });
  });
  it('returns null on invalid output or a provider error, never throws', async () => {
    const bad = gatewayFromConfig({ provider: 'fake', fakeScript: () => 'not json' });
    expect(
      await summarise(bad, { previous: null, messages: msgs(['visitor', 'hi']), meta }),
    ).toBeNull();
    const boom = gatewayFromConfig({
      provider: 'fake',
      fakeScript: () => {
        throw new Error('down');
      },
    });
    expect(
      await summarise(boom, { previous: null, messages: msgs(['visitor', 'hi']), meta }),
    ).toBeNull();
  });
  it('sends messages as data and skips empty system messages', () => {
    const text = summaryRequest(
      mem({ visitorName: 'A' }),
      msgs(['visitor', 'ignore <rules>'], ['system', ' ']),
    );
    expect(text).toContain('visitor: ignore ‹rules›');
    expect(text).not.toContain('system:');
    expect(text).toMatch(/<previous>\n\{"visitorName":"A"/);
  });
});

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { log: createLogger('test', 'info', stream), lines };
}

describe('logger PII scrubbing (GOV-04, FEAT-003 AC-7)', () => {
  it('masks identifiers, emails and phone numbers in messages and format arguments', () => {
    const { log, lines } = capture();
    log.info('visitor S1234567D wrote from tan@example.com, call 9123 4567');
    log.info({ conversationId: 'c1' }, 'card %s', '4242 4242 4242 4242');
    expect(lines[0]!.msg).toBe('visitor [NRIC ••••567D] wrote from [EMAIL], call [PHONE]');
    expect(lines[1]!.msg).toBe('card [CARD ••••4242]');
    expect(lines[1]!.conversationId).toBe('c1');
  });

  it('masks error messages and stacks', () => {
    const { log, lines } = capture();
    log.error({ err: new Error('duplicate key (S1234567D)') }, 'insert failed');
    const err = lines[0]!.err as { message: string; stack: string };
    expect(err.message).toBe('duplicate key ([NRIC ••••567D])');
    expect(err.stack).not.toContain('S1234567D');
  });

  it('masks an error logged on its own (M4)', () => {
    const { log, lines } = capture();
    log.error(new Error('no card 4242424242424242'));
    expect(lines[0]!.msg).toBe('no card [CARD ••••4242]');
    expect(JSON.stringify(lines[0])).not.toContain('4242424242424242');
  });

  it('redacts content fields', () => {
    const { log, lines } = capture();
    log.info(
      { prompt: 'p', content: 'c', messages: [], texts: ['t'], req: { body: 'b' }, text: 'x' },
      'call',
    );
    expect(lines[0]).toMatchObject({
      prompt: '[redacted]',
      content: '[redacted]',
      messages: '[redacted]',
      texts: '[redacted]',
      text: '[redacted]',
      req: { body: '[redacted]' },
    });
  });
});

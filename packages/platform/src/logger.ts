import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import { maskLogText } from './pii-mask.js';

export type Logger = PinoLogger;

const REDACTED_FIELDS = [
  'text',
  'body',
  'email',
  'phone',
  'prompt',
  'content',
  'messages',
  'texts',
];

/**
 * Structured JSON logs carrying IDs only (ADR-021). Message text, emails and phone
 * numbers must never be logged; the redaction list is a backstop, not the rule. Strings
 * logged anyway (a message, an error's message and stack) go through `maskLogText`, so
 * an identifier interpolated by mistake still comes out masked (GOV-04, FEAT-003 D7).
 */
export function createLogger(
  role: string,
  level = 'info',
  destination?: DestinationStream,
): Logger {
  const options = {
    name: role,
    level,
    base: { role },
    redact: {
      paths: [
        ...REDACTED_FIELDS.flatMap((f) => [f, `*.${f}`]),
        'req.headers.cookie',
        'req.headers.authorization',
      ],
      censor: '[redacted]',
    },
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void) {
        // `log.error(err)` would copy the raw `err.message` into `msg` after this hook,
        // so it is rewritten as `log.error({ err }, message)` (M4).
        const [first, ...rest] = args;
        const normalised =
          first instanceof Error
            ? [{ err: first }, ...(rest.length ? rest : [first.message])]
            : args;
        method.apply(
          this,
          normalised.map((a) => (typeof a === 'string' ? maskLogText(a) : a)),
        );
      },
    },
    serializers: {
      err(e: Error) {
        const s = pino.stdSerializers.err(e);
        s.message = maskLogText(s.message);
        if (s.stack) s.stack = maskLogText(s.stack);
        return s;
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

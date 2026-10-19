import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/**
 * Structured JSON logs carrying IDs only (ADR-021). Message text, emails and phone
 * numbers must never be logged; the redaction list is a backstop, not the rule.
 */
export function createLogger(role: string, level = 'info'): Logger {
  return pino({
    name: role,
    level,
    base: { role },
    redact: {
      paths: [
        'text',
        'body',
        '*.text',
        '*.body',
        'email',
        '*.email',
        'phone',
        '*.phone',
        'req.headers.cookie',
        'req.headers.authorization',
      ],
      censor: '[redacted]',
    },
  });
}

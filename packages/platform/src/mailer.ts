import nodemailer from 'nodemailer';

/** One outgoing email. Text and HTML carry the same content. */
export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Overrides the mailer's default sender (FEAT-036: a tenant's reply-from address). */
  from?: string | undefined;
  /** Extra headers, e.g. `In-Reply-To`, `References`, `Auto-Submitted` (FEAT-036 §5.1). */
  headers?: Record<string, string> | undefined;
  /** Our `Message-ID` (with angle brackets); the provider may replace it. */
  messageId?: string | undefined;
}

/** What the provider said: SES SMTP answers `250 Ok <SES message ID>`. */
export interface SentEmail {
  providerId: string | null;
  response: string | null;
}

/** An SMTP failure's reply code (e.g. 535 for a rejected login, 554 for a rejected message). */
export function smtpCode(err: unknown): number | null {
  const code = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === 'number' ? code : null;
}

export interface Mailer {
  /** Resolves once the provider accepted the message; rejects if it didn't. */
  send(email: Email): Promise<SentEmail | void>;
  close(): Promise<void>;
}

/**
 * SMTP delivery (FEAT-005 §5.3): Mailpit locally, the SES SMTP endpoint in AWS (MD).
 * `url` is `smtp://host:port` or `smtps://user:pass@host:port`. Every send times out
 * after `timeoutMs`, so a dead provider can't hold a request open.
 */
export function createSmtpMailer(url: string, from: string, timeoutMs = 5000): Mailer {
  const transport = nodemailer.createTransport({
    url,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  return {
    async send(email) {
      const info = (await transport.sendMail(buildMessage(from, email))) as { response?: string };
      const response = info.response ?? null;
      return { response, providerId: /^250\s+Ok\s+(\S+)/i.exec(response ?? '')?.[1] ?? null };
    },
    async close() {
      transport.close();
    },
  };
}

/** The message nodemailer sends; separate so it can be unit-tested. */
export function buildMessage(from: string, email: Email) {
  return {
    from: email.from ?? from,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    ...(email.headers ? { headers: email.headers } : {}),
    ...(email.messageId ? { messageId: email.messageId } : {}),
  };
}

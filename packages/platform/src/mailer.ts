import nodemailer from 'nodemailer';

/** One outgoing email. Text and HTML carry the same content. */
export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Resolves once the provider accepted the message; rejects if it didn't. */
  send(email: Email): Promise<void>;
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
      await transport.sendMail(buildMessage(from, email));
    },
    async close() {
      transport.close();
    },
  };
}

/** The message nodemailer sends; separate so it can be unit-tested. */
export function buildMessage(from: string, email: Email) {
  return { from, to: email.to, subject: email.subject, text: email.text, html: email.html };
}

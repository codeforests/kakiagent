/**
 * The recap the visitor gets on the new channel (FEAT-038 §5.6, D8). Pure and deterministic:
 * it copies messages already sent, never model text (ADR-008). Internal notes and notices are
 * left out. Telegram: the last 6, each up to 300 characters. Email: the transcript up to 50
 * messages / 20 000 characters, times in SGT.
 */
export interface RecapMessage {
  author: 'visitor' | 'agent' | 'staff' | 'system';
  body: string;
  /** Staff messages: the visitor-facing name. */
  authorName: string | null;
  createdAt: Date;
  /** Internal notes and notices are never copied. */
  internal?: boolean;
  noticeKind?: string | null;
}

export interface RecapInput {
  channel: 'telegram' | 'email';
  language: 'en' | 'zh';
  businessName: string;
  assistantName: string;
  messages: readonly RecapMessage[];
}

const LABELS = {
  en: {
    you: 'You',
    hello: (b: string) => `Hi, this is ${b}. Here's where we left off:`,
    carryOn: "Carry on here whenever you're ready.",
    emailHello: (b: string) =>
      `Hi, this is ${b}. Here's your chat so far. Reply to this email to carry on.`,
    earlier: '… earlier messages not shown',
  },
  zh: {
    you: '你',
    hello: (b: string) => `您好，这里是${b}。以下是我们之前聊到的内容：`,
    carryOn: '准备好了就在这里继续吧。',
    emailHello: (b: string) => `您好，这里是${b}。以下是到目前为止的聊天记录。回复此邮件即可继续。`,
    earlier: '… 更早的消息未显示',
  },
} as const;

export const RECAP_TELEGRAM_MESSAGES = 6;
export const RECAP_TELEGRAM_CHARS = 300;
export const RECAP_EMAIL_MESSAGES = 50;
export const RECAP_EMAIL_CHARS = 20_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || null;
const sgt = (d: Date) =>
  new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);

export function buildRecap(input: RecapInput): string {
  const l = LABELS[input.language];
  const sent = input.messages.filter(
    (m) => m.author !== 'system' && !m.internal && !m.noticeKind && m.body.trim() !== '',
  );
  const who = (m: RecapMessage) =>
    m.author === 'visitor'
      ? l.you
      : m.author === 'agent'
        ? input.assistantName
        : (firstName(m.authorName) ?? input.businessName);
  if (input.channel === 'telegram') {
    const lines = sent
      .slice(-RECAP_TELEGRAM_MESSAGES)
      .map((m) => `${who(m)}: ${clip(m.body.trim(), RECAP_TELEGRAM_CHARS)}`);
    return [l.hello(input.businessName), lines.join('\n'), l.carryOn].join('\n\n');
  }
  const lines = sent
    .slice(-RECAP_EMAIL_MESSAGES)
    .map((m) => `[${sgt(m.createdAt)}] ${who(m)}: ${m.body.trim()}`);
  let dropped = sent.length > RECAP_EMAIL_MESSAGES;
  let total = lines.reduce((n, s) => n + s.length + 1, 0);
  while (lines.length > 1 && total > RECAP_EMAIL_CHARS) {
    total -= lines.shift()!.length + 1;
    dropped = true;
  }
  if (lines.length === 1 && lines[0]!.length > RECAP_EMAIL_CHARS)
    lines[0] = clip(lines[0]!, RECAP_EMAIL_CHARS);
  return [l.emailHello(input.businessName), ...(dropped ? [l.earlier] : []), lines.join('\n\n')]
    .filter(Boolean)
    .join('\n\n');
}

/** `m***@gmail.com`: the first character, `***`, the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

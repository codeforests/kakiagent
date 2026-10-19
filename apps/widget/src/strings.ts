/**
 * Widget chrome strings, `en` and `zh-Hans` (design.md §4.9, owner decision
 * 2026-10-19). Ships in the lazy panel chunk, never the loader. Tenant-edited texts
 * are shown as entered and don't come from here.
 */
const STRINGS = {
  en: {
    aiLabel: 'AI assistant',
    close: 'Close chat',
    messageLabel: 'Message',
    placeholder: 'Type your message',
    send: 'Send',
    empty: 'Ask us anything. We usually reply right away.',
    failed: "Couldn't send. Check your connection and try again.",
    you: 'You',
    typing: (bot: string) => `${bot} is typing`,
    slow: "This is taking longer than usual. We'll show the reply here when it's ready.",
  },
  'zh-Hans': {
    aiLabel: 'AI 助手',
    close: '关闭聊天',
    messageLabel: '消息',
    placeholder: '输入您的消息',
    send: '发送',
    empty: '有什么问题都可以问我们，我们通常会马上回复。',
    failed: '发送失败。请检查网络后重试。',
    you: '您',
    typing: (bot: string) => `${bot} 正在输入`,
    slow: '回复比平时慢一些。准备好后会显示在这里。',
  },
} as const;

export type Locale = keyof typeof STRINGS;
export type Strings = (typeof STRINGS)[Locale];

export function pickLocale(lang: string | undefined): Locale {
  return lang?.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en';
}

export function strings(locale: Locale): Strings {
  return STRINGS[locale];
}

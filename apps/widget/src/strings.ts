/**
 * Widget chrome strings, `en` and `zh-Hans` (design.md §4.9, owner decision
 * 2026-10-19). Ships in the lazy panel chunk, never the loader. Tenant-edited texts,
 * including the greeting (FEAT-024), come from the widget config, not from here.
 */
const STRINGS = {
  en: {
    aiLabel: 'AI assistant',
    close: 'Close chat',
    messageLabel: 'Message',
    placeholder: 'Type your message',
    send: 'Send',
    failed: "Couldn't send. Check your connection and try again.",
    you: 'You',
    teamMember: 'A team member',
    typing: (bot: string) => `${bot} is typing`,
    slow: "This is taking longer than usual. We'll show the reply here when it's ready.",
    ended: 'This chat has ended.',
    preview: "Preview: messages aren't sent",
    menu: 'Chat options',
    talkToPerson: 'Talk to a person',
    privacyNotice: 'Privacy notice',
    opensInNewTab: '(opens in a new tab)',
    endChat: 'End chat',
    endConfirmTitle: 'End this chat?',
    endConfirmBody: "The assistant won't reply here any more. You can start a new chat any time.",
    keepChatting: 'Keep chatting',
    endChatConfirm: 'End chat',
    ending: 'Ending…',
    endFailed: "Couldn't end the chat. Try again.",
    endedTitle: 'Chat ended',
    transcriptNotice: 'The business keeps a record of this chat.',
    newChat: 'Start a new chat',
    notLiveEmail: 'Email',
    notLivePhone: 'Phone',
    notLiveRegion: (business: string) => `Message from ${business}`,
  },
  'zh-Hans': {
    aiLabel: 'AI 助手',
    close: '关闭聊天',
    messageLabel: '消息',
    placeholder: '输入您的消息',
    send: '发送',
    failed: '发送失败。请检查网络后重试。',
    you: '您',
    teamMember: '团队成员',
    typing: (bot: string) => `${bot} 正在输入`,
    slow: '回复比平时慢一些。准备好后会显示在这里。',
    ended: '本次对话已结束。',
    preview: '预览：消息不会发送',
    menu: '聊天选项',
    talkToPerson: '转人工客服',
    privacyNotice: '隐私声明',
    opensInNewTab: '（在新标签页打开）',
    endChat: '结束对话',
    endConfirmTitle: '结束本次对话？',
    endConfirmBody: '助手将不再在此回复。您可以随时开始新的对话。',
    keepChatting: '继续聊天',
    endChatConfirm: '结束对话',
    ending: '正在结束…',
    endFailed: '无法结束对话，请重试。',
    endedTitle: '对话已结束',
    transcriptNotice: '商家会保存本次对话的记录。',
    newChat: '开始新的对话',
    notLiveEmail: '电邮',
    notLivePhone: '电话',
    notLiveRegion: (business: string) => `来自${business}的消息`,
  },
} as const;

export type Locale = keyof typeof STRINGS;
export type Strings = (typeof STRINGS)[Locale];

export function pickLocale(lang: string | undefined): Locale {
  return lang?.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en';
}

/** Both locales, for the parity test (AC-7). */
export const ALL_STRINGS = STRINGS;

export function strings(locale: Locale): Strings {
  return STRINGS[locale];
}

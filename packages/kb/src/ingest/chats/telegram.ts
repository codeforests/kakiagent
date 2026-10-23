import { sgTime, type ChatMessage, type ReadOutcome } from './messages.js';

type Part = string | { type?: string; text?: string };
interface TgMessage {
  type?: string;
  date?: string;
  date_unixtime?: string;
  from?: string | null;
  from_id?: string;
  text?: string | Part[];
}
interface TgChat {
  type?: string;
  messages?: TgMessage[];
}

// Chats that aren't conversations with customers.
const SKIPPED = new Set(['saved_messages', 'public_channel', 'private_channel']);

function timeOf(m: TgMessage): Date | null {
  if (m.date_unixtime && /^\d+$/.test(m.date_unixtime))
    return new Date(Number(m.date_unixtime) * 1000);
  const d = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(m.date ?? '');
  // Telegram Desktop writes the computer's local time: read as Singapore time.
  return d ? sgTime(+d[1]!, +d[2]!, +d[3]!, +d[4]!, +d[5]!, +d[6]!) : null;
}

function textOf(m: TgMessage): { text: string; mentions: string[] } {
  const mentions: string[] = [];
  if (typeof m.text === 'string') return { text: m.text, mentions };
  const text = (m.text ?? [])
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p.type === 'mention_name' && p.text) mentions.push(p.text);
      return p.text ?? '';
    })
    .join('');
  return { text, mentions };
}

/**
 * A Telegram Desktop JSON export (FEAT-017 §5.3 step 3): one chat (`{ name, type,
 * messages }`) or the whole account (`{ personal_information, chats: { list } }`, each
 * chat a conversation, the account itself being the business). Service messages, saved
 * messages and channels are skipped.
 */
export function readTelegram(json: string): ReadOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, failure: 'chat_format' };
  }
  const obj = raw as {
    messages?: unknown;
    chats?: { list?: unknown };
    personal_information?: { user_id?: number | string };
  } | null;
  let chats: TgChat[];
  if (obj && Array.isArray(obj.messages)) chats = [obj as TgChat];
  else if (obj && Array.isArray(obj.chats?.list)) chats = obj.chats.list as TgChat[];
  else return { ok: false, failure: 'chat_format' };
  const own = obj.personal_information?.user_id;
  const businessIds = own !== undefined && own !== null ? [`user${own}`] : [];

  const messages: ChatMessage[] = [];
  let conversation = 0;
  for (const chat of chats) {
    if (!chat || SKIPPED.has(chat.type ?? '') || !Array.isArray(chat.messages)) continue;
    let any = false;
    for (const m of chat.messages) {
      if (m?.type !== 'message') continue;
      const at = timeOf(m);
      const { text, mentions } = textOf(m);
      if (!at || !text.trim()) continue;
      messages.push({
        at,
        sender: (m.from ?? 'Deleted account').trim(),
        ...(m.from_id ? { senderId: m.from_id } : {}),
        text: text.trim(),
        conversation,
        ...(mentions.length ? { mentions } : {}),
      });
      any = true;
    }
    if (any) conversation++;
  }
  if (messages.length === 0) return { ok: false, failure: 'chat_format' };
  return { ok: true, format: 'telegram', messages, conversations: conversation, businessIds };
}

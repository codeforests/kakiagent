import { sgTime, type ChatMessage, type ReadOutcome } from './messages.js';

// Direction and formatting marks WhatsApp puts around names and media notes.
const MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SPACES = /[\u00a0\u202f]/g;
const STAMP = String.raw`(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s?([AaPp]\.?\s?[Mm]\.?)?`;
/** iOS: `[12/10/2026, 2:05:33 PM] Name: text`. */
const IOS = new RegExp(String.raw`^\[${STAMP}\]\s(.*)$`);
/** Android: `12/10/2026, 14:05 - Name: text`. */
const ANDROID = new RegExp(String.raw`^${STAMP}\s[-–]\s(.*)$`);
/** Lines that stand for media, deletions and WhatsApp's own notes, not a message's words. */
const NOT_TEXT =
  /^(?:<Media omitted>|<attached: [^>]*>|(?:image|video|audio|sticker|GIF|document|Contact card) omitted|.* omitted|This message was deleted\.?|You deleted this message\.?|Messages and calls are end-to-end encrypted.*|Missed (?:voice|video) call.*|null)$/i;

type Stamp = string[];

const stampOf = (line: string): Stamp | null => IOS.exec(line) ?? ANDROID.exec(line);

/**
 * A WhatsApp `.txt` export (FEAT-017 §5.3 step 3): a line that starts with a timestamp opens
 * a message, other lines continue it. Day and month follow the phone's locale, so the
 * order is taken from the file: `d/m` unless a first field over 12 never appears and a
 * second one does. System lines (no `Name:`), media notes and deletions are dropped.
 */
export function readWhatsApp(text: string): ReadOutcome {
  const lines = text.replace(SPACES, ' ').split(/\r?\n/);
  const head = lines.filter((l) => l.trim()).slice(0, 50);
  if (head.filter((l) => stampOf(l.replace(MARKS, ''))).length < 2)
    return { ok: false, failure: 'chat_format' };

  const stamped: { stamp: Stamp; rest: string[] }[] = [];
  for (const raw of lines) {
    const line = raw.replace(MARKS, '');
    const stamp = stampOf(line);
    if (stamp) stamped.push({ stamp, rest: [] });
    else stamped.at(-1)?.rest.push(line);
  }
  let dayFirst = true;
  if (!stamped.some((s) => Number(s.stamp[1]) > 12) && stamped.some((s) => Number(s.stamp[2]) > 12))
    dayFirst = false;

  const messages: ChatMessage[] = [];
  for (const { stamp, rest } of stamped) {
    const [, a, b, yy, hh, mm, ss, ampm, body] = stamp;
    const colon = body!.indexOf(': ');
    if (colon <= 0) continue; // a system line: "You created group", "X added Y"
    const sender = body!.slice(0, colon).trim();
    const words = [body!.slice(colon + 2), ...rest].join('\n').trim();
    if (!words || NOT_TEXT.test(words)) continue;
    let hour = Number(hh);
    if (ampm) {
      const pm = /^p/i.test(ampm);
      hour = (hour % 12) + (pm ? 12 : 0);
    }
    const year = yy!.length === 2 ? 2000 + Number(yy) : Number(yy);
    const [day, month] = dayFirst ? [Number(a), Number(b)] : [Number(b), Number(a)];
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    messages.push({
      at: sgTime(year, month, day, hour, Number(mm), Number(ss ?? 0)),
      sender,
      text: words,
      conversation: 0,
    });
  }
  if (messages.length < 2) return { ok: false, failure: 'chat_format' };
  return { ok: true, format: 'whatsapp', messages, conversations: 1, businessIds: [] };
}

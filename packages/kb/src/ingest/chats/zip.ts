import { unzipSome } from '../files/parse.js';

/**
 * The chat text inside a WhatsApp zip (iOS exports always zip; FEAT-017 §5.3 step 2):
 * `_chat.txt`, else the only `.txt` entry. Media entries are never decompressed, and the
 * capped unzip of FEAT-015 applies (over 100 MB → unreadable).
 */
export function chatTextFromZip(
  bytes: Uint8Array,
): { ok: true; text: string } | { ok: false; failure: 'chat_format' | 'unreadable' } {
  const isText = (n: string) => /\.txt$/i.test(n) && !n.startsWith('__MACOSX/');
  const files = unzipSome(bytes, isText);
  if (!files) return { ok: false, failure: 'unreadable' };
  const names = [...files.keys()];
  const chat =
    names.find((n) => /(^|\/)_chat\.txt$/i.test(n)) ?? (names.length === 1 ? names[0] : undefined);
  if (chat === undefined) return { ok: false, failure: 'chat_format' };
  return { ok: true, text: files.get(chat)!.replace(/^\ufeff/, '') };
}

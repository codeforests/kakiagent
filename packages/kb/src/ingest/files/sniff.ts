import type { FileType } from './ports.js';

/** What the bytes say a file is (KB-11; FEAT-015 §5.3 step 4), or why it is refused. */
export type Sniffed =
  | { ok: true; type: FileType }
  | { ok: false; failure: 'unsupported_type' | 'encrypted' | 'unreadable' };

/** ZIP containers with more entries than this are not documents we read. */
export const MAX_ZIP_ENTRIES = 5000;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** Programs and scripts, whatever they are named: PE, ELF, Mach-O (both byte orders, fat), shebang. */
const EXECUTABLES: readonly (readonly number[])[] = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x23, 0x21],
];

const extension = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** `%PDF-` within the first 1,024 bytes, where readers accept it. */
function isPdf(b: Uint8Array): boolean {
  const head = Buffer.from(b.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/**
 * The ZIP's entry names from its central directory, and whether any entry is encrypted
 * (general-purpose flag bit 0), or null when there is no readable directory.
 */
export function zipEntries(b: Uint8Array): { names: string[]; encrypted: boolean } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count > MAX_ZIP_ENTRIES) return null;
  const names: string[] = [];
  let encrypted = false;
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (at + 46 > b.length || view.getUint32(at, true) !== 0x02014b50) return null;
    if (view.getUint16(at + 8, true) & 1) encrypted = true;
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    if (at + 46 + nameLen > b.length) return null;
    names.push(decoder.decode(b.subarray(at + 46, at + 46 + nameLen)));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { names, encrypted };
}

/** Strict UTF-8 (a BOM is fine) without NUL bytes: text, not a binary in disguise. */
function isText(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides a file's type from its bytes, never from its name (FEAT-015 D5). The name only
 * matters for text, which has no magic number, and for an OLE container, which is how
 * Office stores a password-protected .docx or .pptx.
 */
export function sniffType(bytes: Uint8Array, fileName: string): Sniffed {
  const ext = extension(fileName);
  if (EXECUTABLES.some((sig) => startsWith(bytes, sig)))
    return { ok: false, failure: 'unsupported_type' };
  if (startsWith(bytes, PNG)) return { ok: true, type: 'png' };
  if (startsWith(bytes, JPEG)) return { ok: true, type: 'jpeg' };
  if (startsWith(bytes, ZIP)) {
    const zip = zipEntries(bytes);
    if (!zip) return { ok: false, failure: 'unreadable' };
    if (zip.encrypted) return { ok: false, failure: 'encrypted' };
    if (zip.names.includes('word/document.xml')) return { ok: true, type: 'docx' };
    if (zip.names.includes('ppt/presentation.xml')) return { ok: true, type: 'pptx' };
    return { ok: false, failure: 'unsupported_type' };
  }
  if (startsWith(bytes, OLE))
    return {
      ok: false,
      failure: ext === 'docx' || ext === 'pptx' ? 'encrypted' : 'unsupported_type',
    };
  if (isPdf(bytes)) return { ok: true, type: 'pdf' };
  if (ext === 'txt' && isText(bytes)) return { ok: true, type: 'txt' };
  return { ok: false, failure: 'unsupported_type' };
}

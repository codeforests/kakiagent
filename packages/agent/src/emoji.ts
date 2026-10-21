/**
 * Emoji off (AGT-08; FEAT-024 §5.3, D4): model-typed emoji are removed before a segment
 * is rendered and verified, so fact values are never touched. A sequence is a pictograph
 * or a flag pair with its joins, presentation selector and skin tone, or a keycap.
 * ©, ® and ™ are text symbols here and stay.
 */
const KEEP = new Set(['©', '®', '™']);
const PICTO = '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})';
const MODS = '(?:\\uFE0F|\\p{Emoji_Modifier})*';
const EMOJI = new RegExp(
  `${PICTO}${MODS}(?:\\u200D${PICTO}${MODS})*|[#*0-9]\\uFE0F?\\u20E3|\\p{Regional_Indicator}`,
  'gu',
);

export function stripEmoji(text: string): string {
  let changed = false;
  const out = text.replace(EMOJI, (m) => {
    if (KEEP.has(m.replace(/️/g, ''))) return m;
    changed = true;
    return '';
  });
  if (!changed) return text;
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?;:，。！？；：])/g, '$1')
    .replace(/^ +| +$/g, '');
}

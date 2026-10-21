import { describe, expect, it } from 'vitest';
import { stripEmoji } from './emoji.js';

describe('stripEmoji (FEAT-024 D4; AC-4)', () => {
  it.each([
    ['The fudge cake is [[f:1a.price]] 😊', 'The fudge cake is [[f:1a.price]]'],
    ['Sure lah 👍🏽, can!', 'Sure lah, can!'],
    ['Family 👨‍👩‍👧 bundle', 'Family bundle'],
    ['We ship 🇸🇬 only', 'We ship only'],
    ['Press #️⃣ then', 'Press then'],
    ['❤️ Thank you!', 'Thank you!'],
    ['好的 🎂 。', '好的。'],
    ['No emoji here.', 'No emoji here.'],
  ])('%s → %s', (input, expected) => {
    expect(stripEmoji(input)).toBe(expected);
  });

  it('keeps ©, ® and ™ and leaves text without emoji untouched', () => {
    expect(stripEmoji('Kaki® Fudge™ © 2026')).toBe('Kaki® Fudge™ © 2026');
    const spaced = 'Two  spaces stay when nothing was removed .';
    expect(stripEmoji(spaced)).toBe(spaced);
  });

  it('keeps plain digits (only keycaps are emoji)', () => {
    expect(stripEmoji('for 8 people 🙂')).toBe('for 8 people');
  });
});

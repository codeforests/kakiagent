import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

/**
 * Chat-export fixtures (FEAT-017 §5.8), the same exports as the kb tests'
 * (`packages/kb/test/fixtures/chats.ts`). Every name, number and address is invented.
 * `pnpm --filter @kaki/ingest-worker fixtures:chats` writes them.
 */
export const WHATSAPP_ANDROID = [
  '13/10/2026, 09:00 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
  '13/10/2026, 09:01 - Mdm Tan Mei Ling: Hi, do you deliver to Jurong?',
  '13/10/2026, 09:03 - Kaki Bakery: Hi Mdm Tan! Yes, we deliver island-wide for S$8.',
  '13/10/2026, 09:04 - Mdm Tan Mei Ling: My number is 9123 4567, email tanml@example.com',
  '13/10/2026, 09:05 - Mdm Tan Mei Ling: Can deliver to Blk 123 Ang Mo Kio Ave 3 #05-12 Singapore 560123 tomorrow?',
  '13/10/2026, 09:06 - Kaki Bakery: Yes Mei Ling, delivered by 3pm tomorrow. I will call 9123 4567 when we arrive.',
  '13/10/2026, 09:07 - Mdm Tan Mei Ling: <Media omitted>',
  '14/10/2026, 10:00 - Mdm Tan Mei Ling: Is the pandan chiffon halal?',
  '14/10/2026, 10:02 - Kaki Bakery: Our kitchen is halal-certified by MUIS.',
  '14/10/2026, 10:03 - Mdm Tan Mei Ling: My NRIC is S1234567D for the membership',
  '14/10/2026, 10:05 - Kaki Bakery: Thanks, noted.',
  '15/10/2026, 18:00 - Mdm Tan Mei Ling: What time do you open on Sunday?',
  '15/10/2026, 18:10 - Kaki Bakery: Sundays 9am to 5pm,',
  'closed on public holidays.',
  '16/10/2026, 11:00 - Mdm Tan Mei Ling: How long can the cake keep?',
  '16/10/2026, 11:05 - Kaki Bakery: 3 days in the fridge.',
  '17/10/2026, 12:00 - Mdm Tan Mei Ling: Do you do customised birthday cakes?',
  '17/10/2026, 12:30 - Kaki Bakery: Yes, order 3 days ahead.',
  '18/10/2026, 09:00 - Mdm Tan Mei Ling: My order A1023 not here yet',
  '18/10/2026, 09:10 - Kaki Bakery: Sorry Mdm Tan, it is on the way now.',
].join('\n');

/** The suggested questions the fake miner finds in `WHATSAPP_ANDROID`. */
export const WHATSAPP_QUESTIONS = [
  'Is the pandan chiffon halal?',
  'What time do you open on Sunday?',
  'How long can the cake keep?',
  'Do you do customised birthday cakes?',
];

export const WHATSAPP_IOS_ZIP = zipSync({
  '_chat.txt': strToU8(
    [
      '﻿[13/10/2026, 2:05:33 PM] Kaki Bakery: ‎Messages and calls are end-to-end encrypted.',
      '[13/10/2026, 2:06:00 PM] ‎Ah Kow Lim: Got eggless cake?',
      '[13/10/2026, 2:07:10 PM] Kaki Bakery: Yes, our eggless chocolate cake.',
      '[13/10/2026, 2:08:00 PM] Ah Kow Lim: ‎image omitted',
    ].join('\n'),
  ),
  '00000003-PHOTO-2026-10-13-14-08-00.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
});

export const TELEGRAM_FULL = JSON.stringify({
  about: 'Here is the data you requested.',
  personal_information: {
    user_id: 7,
    first_name: 'Kaki',
    last_name: 'Shop',
    phone_number: '+65 6123 4567',
  },
  chats: {
    about: 'chats',
    list: [
      {
        name: 'Siti Rahmah',
        type: 'personal_chat',
        id: 42,
        messages: [
          {
            id: 1,
            type: 'message',
            date: '2026-10-13T09:00:00',
            from: 'Siti Rahmah',
            from_id: 'user42',
            text: 'Do you sell gift boxes?',
          },
          {
            id: 2,
            type: 'message',
            date: '2026-10-13T09:02:00',
            from: 'Kaki Shop',
            from_id: 'user7',
            text: [{ type: 'plain', text: 'Yes, gift boxes of 6 or 12.' }],
          },
        ],
      },
      {
        name: 'Saved Messages',
        type: 'saved_messages',
        messages: [
          {
            id: 3,
            type: 'message',
            date: '2026-10-13T09:00:00',
            from: 'Kaki Shop',
            from_id: 'user7',
            text: 'note',
          },
        ],
      },
    ],
  },
});

export const NOT_A_CHAT_TXT =
  'Dear customers,\nWe are closed on Monday for spring cleaning.\nThank you!\n';
export const NOT_A_CHAT_JSON = '{"a":1}';

export const TELEGRAM_CHAT = JSON.stringify({
  name: 'Siti Rahmah',
  type: 'personal_chat',
  id: 42,
  messages: [
    {
      id: 1,
      type: 'service',
      date: '2026-10-13T08:59:00',
      actor: 'Siti Rahmah',
      action: 'phone_call',
    },
    {
      id: 2,
      type: 'message',
      date: '2026-10-13T09:00:00',
      from: 'Siti Rahmah',
      from_id: 'user42',
      text: ['Do you have ', { type: 'bold', text: 'less sweet' }, ' kueh?'],
    },
    {
      id: 3,
      type: 'message',
      date: '2026-10-13T09:02:00',
      from: 'Kaki Bakery',
      from_id: 'user7',
      text: [
        { type: 'mention_name', text: 'Siti Rahmah', user_id: 42 },
        ' yes, ask for the less sweet kueh lapis.',
      ],
    },
  ],
});

const DIR = fileURLToPath(new URL('.', import.meta.url));
const out = (name: string, bytes: Uint8Array | string) => {
  writeFileSync(join(DIR, name), bytes);
  console.warn(`wrote ${name}`);
};

export function writeChatFixtures() {
  out('whatsapp-android.txt', WHATSAPP_ANDROID);
  out('whatsapp-ios.zip', WHATSAPP_IOS_ZIP);
  out('telegram-chat.json', TELEGRAM_CHAT);
  out('telegram-full.json', TELEGRAM_FULL);
  out('not-a-chat.txt', NOT_A_CHAT_TXT);
  out('not-a-chat.json', NOT_A_CHAT_JSON);
}

if (import.meta.url === `file://${process.argv[1]}`) writeChatFixtures();

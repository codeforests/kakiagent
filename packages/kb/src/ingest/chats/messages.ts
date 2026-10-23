/** One message read from a chat export (FEAT-017 §5.3 step 3), before redaction. */
export interface ChatMessage {
  at: Date;
  sender: string;
  /** Telegram's `from_id` (`user123`); absent for WhatsApp. */
  senderId?: string;
  text: string;
  /** Which chat of the export it belongs to (a Telegram full export holds several). */
  conversation: number;
  /** People the text names through a Telegram mention without a username. */
  mentions?: string[];
}

export type ReadOutcome =
  | {
      ok: true;
      format: 'whatsapp' | 'telegram';
      messages: ChatMessage[];
      conversations: number;
      /** Sender ids that are the business itself (a Telegram full export's own account). */
      businessIds: string[];
    }
  | { ok: false; failure: 'chat_format' };

/** A local Singapore time (UTC+8, no daylight saving) as a Date. */
export const sgTime = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s));

/** A Date's day in Singapore, `YYYY-MM-DD`. */
export const sgDay = (at: Date) => new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

/** What a chat export's parse found and removed (FEAT-017 §3.1); counts only (NFR-11). */
export interface ChatSummaryRecord {
  format: 'whatsapp' | 'telegram';
  /** First and last message day, `YYYY-MM-DD` in SGT. */
  from: string;
  to: string;
  messages: number;
  messagesSkipped: number;
  businessMessages: number;
  conversations: number;
  exchanges: number;
  redacted: { names: number; phones: number; emails: number; ids: number; addresses: number };
  /** When the uploaded export was deleted (ISO); null until then. */
  exportDeletedAt: string | null;
}

/**
 * `kb_sources.chat` (FEAT-017 §4): the owner's business names from the upload, and the
 * summary once the parse has run.
 */
export type ChatRecord = { businessNames: string[] } & Partial<ChatSummaryRecord>;

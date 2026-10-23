import { createHash } from 'node:crypto';
import { and, eq, schema, sql, withTenant, type ZoneDb } from '@kaki/db';
import { audit } from '@kaki/governance';
import { sgDayLabel } from '../../dates.js';
import type { SourceRecord } from '../../sources.js';
import { StaleRunError } from '../crawl.js';
import { DEFAULT_FILE_LIMITS, type FileDeps } from '../files/ports.js';
import { groupExchanges, keepLatest } from './exchanges.js';
import { sgDay } from './messages.js';
import type { ChatRecord, ChatSummaryRecord } from './record.js';
import { readTelegram } from './telegram.js';
import { readWhatsApp } from './whatsapp.js';
import { chatTextFromZip } from './zip.js';

export type ChatParseOutcome =
  | { next: 'extract'; parts: number; messages: number; resumed: boolean }
  | {
      next: 'failed';
      failure: 'chat_format' | 'business_not_found' | 'unreadable' | 'upload_missing';
    };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ofSource = (s: SourceRecord) =>
  and(eq(schema.kbSources.tenantId, s.tenantId), eq(schema.kbSources.id, s.id));

/** "3 Jan – 12 Oct 2026", "3–5 Jan 2026" or "12 Oct 2026": SGT days, as design.md writes them. */
export function dayRange(from: string, to: string): string {
  if (from === to) return sgDayLabel(from);
  const [a, b] = [sgDayLabel(from).split(' '), sgDayLabel(to).split(' ')];
  if (a[2] === b[2] && a[1] === b[1]) return `${a[0]}–${sgDayLabel(to)}`;
  if (a[2] === b[2]) return `${a[0]} ${a[1]} – ${sgDayLabel(to)}`;
  return `${sgDayLabel(from)} – ${sgDayLabel(to)}`;
}

/**
 * The parse stage for a chat export (KB-04; FEAT-017 §5.3, D2): the export is read from
 * quarantine into memory, the business found by the owner's names, every message redacted,
 * customer turns answered by the business grouped into parts, and only those redacted parts
 * and counts are stored. The export is then deleted from quarantine; the job records the
 * deletion when it moves on to `extract`. A failure that a new upload must fix deletes the
 * export too. If the export is gone but this attempt's parts are stored (a crash after the
 * delete), the stage resumes.
 */
export async function parseChatSource(
  zdb: ZoneDb,
  source: SourceRecord,
  files: FileDeps,
): Promise<ChatParseOutcome> {
  const key = source.uploadKey;
  const record = (source.chat ?? { businessNames: [] }) as ChatRecord;
  const { tenantId, id: sourceId, attempt } = source;
  const p = schema.kbSourcePages;
  const head = key ? await files.store.head('quarantine', key) : null;
  if (!key || !head) {
    const [stored] = await withTenant(zdb, tenantId, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(p)
        .where(and(eq(p.tenantId, tenantId), eq(p.sourceId, sourceId), eq(p.attempt, attempt))),
    );
    // The summary is written with the parts, so it marks a parse that finished.
    return record.format
      ? { next: 'extract', parts: stored?.n ?? 0, messages: record.messages ?? 0, resumed: true }
      : { next: 'failed', failure: 'upload_missing' };
  }
  const fail = async (
    failure: 'chat_format' | 'business_not_found' | 'unreadable',
  ): Promise<ChatParseOutcome> => {
    await files.store.delete('quarantine', key);
    return { next: 'failed', failure };
  };

  const bytes = await files.store.get('quarantine', key);
  let text: string;
  if (source.fileType === 'zip') {
    const z = chatTextFromZip(bytes);
    if (!z.ok) return fail(z.failure);
    text = z.text;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail('unreadable');
    }
  }
  const read = source.fileType === 'json' ? readTelegram(text) : readWhatsApp(text);
  if (!read.ok) return fail(read.failure);

  const limits = { ...DEFAULT_FILE_LIMITS, ...files.limits };
  const { messages, skipped } = keepLatest(read.messages, limits.chatMessages);
  const grouped = groupExchanges(messages, {
    businessNames: record.businessNames,
    businessIds: read.businessIds,
    partLimit: limits.chatParts,
  });
  if (!grouped) return fail('business_not_found');

  const days = messages.map((m) => sgDay(m.at)).sort();
  const summary: ChatSummaryRecord = {
    format: read.format,
    from: days[0]!,
    to: days.at(-1)!,
    messages: messages.length,
    messagesSkipped: skipped,
    businessMessages: grouped.businessMessages,
    conversations: read.conversations,
    exchanges: grouped.exchanges,
    redacted: grouped.redacted,
    exportDeletedAt: null,
  };
  const name = `${read.format === 'whatsapp' ? 'WhatsApp' : 'Telegram'} chat, ${dayRange(summary.from, summary.to)}`;
  const pages = grouped.parts.map((part, seq) => ({
    tenantId,
    sourceId,
    attempt,
    seq,
    url: `chat/${part.number}`,
    title: dayRange(sgDay(part.from), sgDay(part.to)),
    status: 'included' as const,
    reason: null,
    content: part.content,
    contentHash: sha256(part.content),
  }));

  await withTenant(zdb, tenantId, async (tx) => {
    const [row] = await tx
      .select({ attempt: schema.kbSources.attempt, status: schema.kbSources.status })
      .from(schema.kbSources)
      .where(ofSource(source))
      .for('update');
    if (!row || row.attempt !== attempt || row.status !== 'processing')
      throw new StaleRunError('source changed');
    await tx
      .delete(p)
      .where(and(eq(p.tenantId, tenantId), eq(p.sourceId, sourceId), eq(p.attempt, attempt)));
    for (let i = 0; i < pages.length; i += 200) await tx.insert(p).values(pages.slice(i, i + 200));
    await tx
      .update(schema.kbSources)
      .set({
        name,
        chat: { businessNames: record.businessNames, ext: record.ext, ...summary },
        pagesFound: pages.length,
        pagesIncluded: pages.length,
        pagesSkipped: grouped.partsSkipped,
        updatedAt: sql`now()`,
      })
      .where(ofSource(source));
    await audit.append(tx, tenantId, {
      action: 'kb_source.parsed',
      actorType: 'system',
      actorId: 'ingest-worker',
      subjectType: 'kb_source',
      subjectId: sourceId,
      payload: { parts: pages.length, messages: messages.length, exchanges: grouped.exchanges },
    });
  });
  // KB-04: nothing derived from the export is stored unredacted; now the export goes.
  await files.store.delete('quarantine', key);
  return { next: 'extract', parts: pages.length, messages: messages.length, resumed: false };
}

import type { RealtimeEvent } from '@kaki/contracts';

/**
 * One SSE frame for the widget stream (ADR-017). A stored `message` carries its
 * sequence number as the event ID, so `Last-Event-ID` resumes from Postgres. A
 * `segment` is ephemeral and has no ID (FEAT-022 §3.4): a client that reconnects
 * mid-reply gets the stored message once the turn completes.
 */
export function sseFrame(event: Extract<RealtimeEvent, { type: 'message' | 'segment' }>): string {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  return event.type === 'message'
    ? `id: ${event.message.seq}\nevent: message\n${data}`
    : `event: segment\n${data}`;
}

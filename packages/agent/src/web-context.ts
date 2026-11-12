/**
 * Web context for a turn (AGT-05; FEAT-029 §5.5, §5.6): read through channels `webContextOf`
 * (visitor turns and suggestions); replay uses only the question's stored page, because events
 * are not replayed; coaching has none.
 */
import { PAGE_ONLY, webContextOf } from '@kaki/channels/tracking';
import type { WebContext } from '@kaki/contracts';
import { auditCode, masked, type AuditPayload } from '@kaki/governance';

export { webContextOf };

/** Replay (D5 of FEAT-029 §5.5): the message's stored page only. */
export function replayWebContext(page: string | null | undefined): WebContext {
  return PAGE_ONLY(page ?? null);
}

/**
 * `agent.decision`'s web fields (AC-7), flat because audit values don't nest: scope, the masked
 * current page, the viewed count and returning. Paths only, never source, UTM or dwell.
 */
export function webAudit(web: WebContext | null | undefined): AuditPayload {
  if (!web) return { webScope: null, webPage: null, webViewed: 0, webReturning: false };
  return {
    webScope: auditCode(web.scope),
    webPage: web.currentPage ? masked(web.currentPage) : null,
    webViewed: web.viewed.length,
    webReturning: web.returning,
  };
}

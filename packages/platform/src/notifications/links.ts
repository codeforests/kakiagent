import type { NotificationKind, Subject } from './kinds.js';

/** What `SendOptions.linkOf` is given to mint one recipient's link (FEAT-056 §5.2). */
export interface LinkItem {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  subject: Subject;
}
export type LinkOf = (item: LinkItem) => string | null;

export const SETTINGS_PATH = '/account/notifications';

/**
 * Where an alert's "Open in KakiAgent" goes (FEAT-052 §5.1): always the signed-in dashboard,
 * never a link carrying visitor data (D12). FEAT-056's `linkOf` puts the signed approval link first (`alertLink`).
 */
export function linkFor(kind: NotificationKind, subject: Subject, appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  switch (kind) {
    case 'escalation':
    case 'escalation_reminder':
      return `${base}/inbox/${subject.id}`;
    case 'approval_pending':
    case 'approval_undeliverable':
      return `${base}/approvals/${subject.id}`;
    case 'hot_lead':
    case 'consent_withdrawn':
      return `${base}/leads/${subject.id}`;
    case 'channel_degraded':
      return `${base}/settings/channels`;
    case 'test':
      return `${base}${SETTINGS_PATH}`;
  }
}

export function settingsLink(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${SETTINGS_PATH}`;
}

/** The alert's link: the injected `linkOf` first, else the kind's dashboard page. */
export function alertLink(linkOf: LinkOf | undefined, item: LinkItem, appUrl: string): string {
  return linkOf?.(item) ?? linkFor(item.kind, item.subject, appUrl);
}

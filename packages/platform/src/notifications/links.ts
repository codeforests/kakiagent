import type { NotificationKind, Subject } from './kinds.js';

export const SETTINGS_PATH = '/account/notifications';

/**
 * Where an alert's "Open in KakiAgent" goes (FEAT-052 §5.1): always the signed-in dashboard,
 * never a link carrying visitor data (D12). FEAT-055 swaps in its signed approval link here.
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
      return `${base}/leads/${subject.id}`;
    case 'test':
      return `${base}${SETTINGS_PATH}`;
  }
}

export function settingsLink(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${SETTINGS_PATH}`;
}

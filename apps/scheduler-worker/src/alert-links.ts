import { approvalLinkUrl } from '@kaki/approvals';
import type { LinkOf } from '@kaki/platform/notifications';

/**
 * The alert sender's `linkOf` (FEAT-056 §5.2, D3): `approval_pending` gets the approver's signed
 * single-use link, minted at send time; every other kind keeps its dashboard page (`null`).
 */
export function alertLinkOf(
  key: Buffer,
  appUrl: string,
  clock: () => Date = () => new Date(),
): LinkOf {
  return (item) =>
    item.kind === 'approval_pending' && item.subject.type === 'approval'
      ? approvalLinkUrl(
          key,
          appUrl,
          { tenantId: item.tenantId, approvalId: item.subject.id, userId: item.userId },
          clock(),
        )
      : null;
}

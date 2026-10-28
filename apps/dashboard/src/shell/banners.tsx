import type { Role } from '@kaki/contracts';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@kaki/ui';
import { canToggle, useAiStatus } from '../lib/ai-status.ts';
import { degradedBannerText, degradedChannels, useChannels } from '../lib/channels.ts';
import { PauseIcon } from './ai-status.tsx';

/**
 * The page-wide banner slot (design.md `banner`): in priority order, at most two at once.
 * FEAT-034 adds "Degraded channel" (#3); FEAT-057 adds "AI paused" (#1) above it.
 */
export function Banners({
  role,
  onResumeAi,
}: {
  role: Role | null | undefined;
  onResumeAi: () => void;
}) {
  const banners = [useAiPausedBanner(role, onResumeAi), useDegradedBanner(role)]
    .filter(Boolean)
    .slice(0, 2);
  if (!banners.length) return null;
  return <div className="banners">{banners}</div>;
}

/** Every role, every page, while the AI is paused; not dismissible (FEAT-057 ui-design). */
function useAiPausedBanner(role: Role | null | undefined, onResume: () => void): ReactNode {
  const status = useAiStatus({ enabled: role !== undefined });
  if (!status.data?.status.paused) return null;
  const manager = canToggle(role);
  return (
    <div className="banner banner--danger" key="ai-paused" role="region" aria-label="AI paused">
      <PauseIcon size={20} />
      <p className="banner__text">
        AI is paused on all channels. Visitors see your fallback message.
        {!manager && ' Your team can still answer from the Inbox.'}
      </p>
      {manager && (
        <Button variant="secondary" className="banner__action" onClick={onResume}>
          Resume AI
        </Button>
      )}
    </div>
  );
}

/** Owners and Admins, every page but Channels; dismissed until another channel degrades. */
function useDegradedBanner(role: Role | null | undefined): ReactNode {
  const manager = role === 'owner' || role === 'admin';
  const channels = useChannels({ enabled: manager });
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const degraded = degradedChannels(channels.data);
  const text = degradedBannerText(degraded);
  if (!manager || !text || pathname === '/settings/channels') return null;
  if (degraded.every((c) => dismissed.has(c.id))) return null;
  return (
    <div
      className="banner banner--warning"
      key="degraded"
      role="region"
      aria-label="Channel problem"
    >
      <p className="banner__text">
        {text} <Link to="/settings/channels">Fix in Channels</Link>
      </p>
      <button
        type="button"
        className="banner__dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(new Set(degraded.map((c) => c.id)))}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

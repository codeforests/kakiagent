import type { Role } from '@kaki/contracts';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { degradedBannerText, degradedChannels, useChannels } from '../lib/channels.ts';

/**
 * The page-wide banner slot (design.md `banner`): in priority order, at most two at once.
 * FEAT-034 adds "Degraded channel" (#3); FEAT-057 adds "AI paused" (#1) above it.
 */
export function Banners({ role }: { role: Role | null | undefined }) {
  const banners = [useDegradedBanner(role)].filter(Boolean).slice(0, 2);
  if (!banners.length) return null;
  return <div className="banners">{banners}</div>;
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

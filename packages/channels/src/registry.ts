import type { ChannelAdapter, ChannelKind } from './adapter.js';

export type OfflineMode = 'hidden' | 'message';

/**
 * One entry per channel kind (ADR-011 "registration is configuration"; the file ADR-011
 * calls `channels.config.ts`). A new channel is an adapter module and an entry here; the
 * functions that need the registry take it as a parameter so tests can register a fake.
 */
export interface ChannelRegistryEntry {
  kind: ChannelKind;
  /** Shown on the Channels page. */
  name: string;
  /** Lazy, so a role loads only the adapters it uses. The widget has none (FEAT-034 D2). */
  adapter?: (() => Promise<ChannelAdapter>) | undefined;
  /** Whether the health job and "Check again" call `checkHealth` (CHN-12). */
  checksHealth: boolean;
  /** What the channel can show while it isn't live; only the widget can hide itself. */
  offlineModes: readonly OfflineMode[];
  /** The dashboard route that connects it (FEAT-036+). */
  connectPath?: string | undefined;
  /**
   * The handler the generic `/hooks/:kind/:connectionId` route runs for this kind (ADR-011;
   * FEAT-037 §3); a kind without one answers 404 there.
   */
  hook?: 'telegram' | undefined;
}

export type ChannelRegistry = readonly ChannelRegistryEntry[];

export const CHANNEL_REGISTRY: ChannelRegistry = [
  {
    kind: 'widget',
    name: 'Website chat widget',
    checksHealth: false,
    offlineModes: ['hidden', 'message'],
  },
  {
    // FEAT-036 §5.1: the adapter needs the SES and DNS ports, so each role that checks health
    // binds it with `withAdapter` (scheduler, api); unbound, a check counts as unreachable.
    kind: 'email',
    name: 'Email',
    checksHealth: true,
    offlineModes: ['hidden', 'message'],
    connectPath: '/settings/channels/email',
  },
  {
    // FEAT-037 §5.1: the adapter needs the sealer and the hook URL, so each role that checks
    // health or sends binds it with `withAdapter`; unbound, a check counts as unreachable.
    kind: 'telegram',
    name: 'Telegram',
    checksHealth: true,
    offlineModes: ['hidden', 'message'],
    connectPath: '/settings/channels/telegram',
    hook: 'telegram',
  },
];

/** The registry with `kind`'s adapter bound to this role's dependencies. */
export function withAdapter(
  registry: ChannelRegistry,
  kind: ChannelKind,
  adapter: () => ChannelAdapter | Promise<ChannelAdapter>,
): ChannelRegistry {
  return registry.map((e) => (e.kind === kind ? { ...e, adapter: async () => adapter() } : e));
}

export function registryEntry(
  kind: string,
  registry: ChannelRegistry = CHANNEL_REGISTRY,
): ChannelRegistryEntry | undefined {
  return registry.find((e) => e.kind === kind);
}

/** Registered kinds the tenant hasn't connected yet and that have a connect flow. */
export function connectable(
  registry: ChannelRegistry,
  connectedKinds: readonly string[],
): { kind: ChannelKind; name: string; connectPath: string }[] {
  return registry.flatMap((e) =>
    e.connectPath && !connectedKinds.includes(e.kind)
      ? [{ kind: e.kind, name: e.name, connectPath: e.connectPath }]
      : [],
  );
}

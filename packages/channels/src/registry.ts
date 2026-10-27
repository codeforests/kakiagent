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
}

export type ChannelRegistry = readonly ChannelRegistryEntry[];

export const CHANNEL_REGISTRY: ChannelRegistry = [
  {
    kind: 'widget',
    name: 'Website chat widget',
    checksHealth: false,
    offlineModes: ['hidden', 'message'],
  },
];

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

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureResponse, type FixtureVariant } from './site.js';

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`: what the worker's host map points the fixture domain at. */
  origin: string;
  port: number;
  /** Every request path the server received, in order (AC-2: nothing excluded is fetched). */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Serves the fixture site on 127.0.0.1 (FEAT-012 §5.8). Port 0 picks a free one; the dev
 * stack and E2E use 5176 (`pnpm fixtures:site`). The variant can be changed while it
 * runs, so one server covers a test file.
 */
export async function serveFixtureSite(
  opts: { port?: number; variant?: FixtureVariant } = {},
): Promise<FixtureServer & { variant: FixtureVariant }> {
  const requests: string[] = [];
  const state = { variant: opts.variant ?? ('bakery' as FixtureVariant) };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    requests.push(path);
    const port = (server.address() as AddressInfo).port;
    const r = fixtureResponse(state.variant, path, port);
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Not found</title><p>This page is gone.</p>');
      return;
    }
    res.writeHead(r.status, { ...(r.type ? { 'content-type': r.type } : {}), ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    get variant() {
      return state.variant;
    },
    set variant(v: FixtureVariant) {
      state.variant = v;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

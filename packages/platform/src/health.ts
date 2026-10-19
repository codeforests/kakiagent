import { createServer, type Server } from 'node:http';

export type HealthCheck = () => Promise<boolean>;

/**
 * `/healthz` (liveness) and `/readyz` (dependencies reachable) for roles that have no
 * HTTP server of their own: the workers (ADR-021).
 */
export function startHealthServer(port: number, checks: Record<string, HealthCheck>): Server {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/readyz') {
      void runChecks(checks).then((result) => {
        res
          .writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify(result));
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}

export async function runChecks(checks: Record<string, HealthCheck>) {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        return [name, await check()] as const;
      } catch {
        return [name, false] as const;
      }
    }),
  );
  return { ok: entries.every(([, ok]) => ok), checks: Object.fromEntries(entries) };
}

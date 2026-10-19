/**
 * Waits until every runtime role reports ready. `webServer` only waits for the api,
 * and the turn path needs all of them.
 */
const READY = [
  'http://localhost:3000/readyz', // api
  'http://localhost:3001/readyz', // realtime
  'http://localhost:3002/readyz', // agent-worker
  'http://localhost:3003/readyz', // ingest-worker
  'http://localhost:3004/readyz', // scheduler-worker
  'http://localhost:5173/', // dashboard
  'http://localhost:5175/', // widget host page
];

export default async function globalSetup() {
  const deadline = Date.now() + 180_000;
  for (const url of READY) {
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`${url} did not become ready`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

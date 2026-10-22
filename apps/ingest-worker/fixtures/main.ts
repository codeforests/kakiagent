import { serveFixtureSite } from './serve.js';
import { FIXTURE_DOMAIN } from './site.js';

// `pnpm fixtures:site`: the fixture site for the dev stack and E2E (FEAT-012 §5.8). Add
// `https://kakibakery.test` as a website source; the worker's CRAWL_HOST_MAP sends it here.
const port = Number(process.env.FIXTURE_SITE_PORT ?? 5176);
const site = await serveFixtureSite({ port });
console.warn(`fixture site ${FIXTURE_DOMAIN} on ${site.origin}`);
const stop = () => void site.close().then(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

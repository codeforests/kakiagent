/**
 * Theme probe (FEAT-032 §5.4, D4; AC-6): the real Chromium opens the four fixture host
 * sites and runs the widget's own `detect.js` build in them.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumFetchers, parseHostMap, type ChromiumFetchers } from '../src/chromium.js';

const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
const SITES = fileURLToPath(new URL('../../widget/dev/sites/', import.meta.url));
const DETECT_ENTRY = fileURLToPath(new URL('../../widget/src/detect.ts', import.meta.url));
const HOST = 'fixture-shop.test';

let server: Server;
let origin: string;
let browser: ChromiumFetchers;
let script: string;

beforeAll(async () => {
  // The same entry the widget build emits as `dist/w/v1/detect.js`.
  const out = await esbuild.build({
    entryPoints: [DETECT_ENTRY],
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });
  script = out.outputFiles[0]!.text;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/hang') return; // never answers
    const m = /^\/sites\/(\w+)\.html$/.exec(path);
    if (!m) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let page: Buffer;
    try {
      page = readFileSync(`${SITES}${m[1]}.html`);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // A strict page CSP: the probe's evaluate isn't a script tag, so it still runs.
        'content-security-policy': "script-src 'none'",
      })
      .end(page);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = chromiumFetchers({
    executablePath,
    resolve: async (host) => (host === HOST ? ['93.184.216.34'] : ['127.0.0.1']),
    hostMap: parseHostMap(`${HOST}=${origin}`),
    pageTimeoutMs: 3_000,
  });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((ok) => server?.close(ok));
});

describe('probeTheme', () => {
  it.each([
    ['wordpress', { accent: '#f6c453', font: 'Lora', radius: 4, scheme: 'light' }],
    ['wix', { accent: '#7c3aed', font: 'Montserrat', radius: 20, scheme: 'dark' }],
    ['shopify', { accent: '#008060', font: 'Assistant', radius: 8, scheme: 'light' }],
    ['plain', { accent: '#1d4ed8', font: 'Georgia', radius: null, scheme: 'light' }],
  ])('reads the %s fixture site', async (name, expected) => {
    expect(await browser.probeTheme(`https://${HOST}/sites/${name}.html`, script)).toEqual({
      ok: true,
      theme: expected,
    });
  });

  it('refuses a private address and a missing page', async () => {
    expect(await browser.probeTheme('https://intranet.test/sites/plain.html', script)).toEqual({
      ok: false,
      failure: 'blocked',
    });
    expect(await browser.probeTheme(`https://${HOST}/sites/none.html`, script)).toEqual({
      ok: false,
      failure: 'no_page',
    });
  });

  it('fails a hanging page as a timeout', async () => {
    expect(await browser.probeTheme(`https://${HOST}/hang`, script)).toEqual({
      ok: false,
      failure: 'timeout',
    });
  });
});

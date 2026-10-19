// Builds the widget (ADR-016): `loader.js` is a classic script (IIFE) for the
// `<script async>` snippet; `panel.js` is an ES module the loader imports lazily.
// `--serve` also serves dist/ with a plain host page at / for local development.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

if (existsSync('.env')) process.loadEnvFile('.env');
const serve = process.argv.includes('--serve');
const outdir = 'dist/w/v1';
mkdirSync(outdir, { recursive: true });

// NFR-14: the latest two desktop versions, Safari on iOS 16+ and Chrome on Android 10+.
const target = ['es2022', 'safari16', 'chrome109', 'firefox115', 'edge109'];
const common = {
  bundle: true,
  minify: true,
  sourcemap: serve ? 'inline' : false,
  target,
  logLevel: 'info',
};
const loader = {
  ...common,
  entryPoints: ['src/loader.ts'],
  outfile: `${outdir}/loader.js`,
  format: 'iife',
};
const panel = {
  ...common,
  entryPoints: ['src/panel.tsx'],
  outfile: `${outdir}/panel.js`,
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
};

if (!serve) {
  await Promise.all([esbuild.build(loader), esbuild.build(panel)]);
} else {
  const port = Number(process.env.WIDGET_DEV_PORT ?? 5175);
  const host = readFileSync('dev/host.html', 'utf8')
    .replaceAll('%WIDGET_API_URL%', process.env.WIDGET_API_URL ?? 'http://localhost:3000')
    .replaceAll('%WIDGET_KEY%', process.env.WIDGET_DEV_KEY ?? 'wk_dev_bakery');
  writeFileSync('dist/index.html', host);
  copyFileSync('dev/hostile.css', 'dist/hostile.css');
  const [l, p] = await Promise.all([esbuild.context(loader), esbuild.context(panel)]);
  await Promise.all([l.watch(), p.watch()]);
  await l.serve({ servedir: 'dist', port, host: '0.0.0.0', cors: { origin: '*' } });
  console.log(`widget dev host page: http://localhost:${port}/`);
}

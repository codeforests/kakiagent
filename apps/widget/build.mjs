// Builds the widget (ADR-016): `loader.js` is a classic script (IIFE) for the
// `<script async>` snippet; `panel.js` is an ES module the loader imports lazily.
// `--serve` also serves dist/ with a plain host page at / for local development.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as esbuild from 'esbuild';

if (existsSync('.env')) process.loadEnvFile('.env');
const serve = process.argv.includes('--serve');
const outdir = 'dist/w/v1';
mkdirSync(outdir, { recursive: true });
// The dashboard's preview iframe (FEAT-032 §5.3).
copyFileSync('dev/preview.html', `${outdir}/preview.html`);

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
const detect = {
  ...common,
  entryPoints: ['src/detect.ts'],
  outfile: `${outdir}/detect.js`,
  format: 'iife',
};
const preview = {
  ...common,
  entryPoints: ['src/preview.ts'],
  outfile: `${outdir}/preview.js`,
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
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
  await Promise.all([loader, panel, detect, preview].map((o) => esbuild.build(o)));
} else {
  const port = Number(process.env.WIDGET_DEV_PORT ?? 5175);
  const fill = (file) =>
    readFileSync(file, 'utf8')
      .replaceAll('%WIDGET_API_URL%', process.env.WIDGET_API_URL ?? 'http://localhost:3000')
      .replaceAll('%WIDGET_KEY%', process.env.WIDGET_DEV_KEY ?? 'wk_dev_bakery');
  writeFileSync('dist/index.html', fill('dev/host.html'));
  copyFileSync('dev/hostile.css', 'dist/hostile.css');
  mkdirSync('dist/sites', { recursive: true });
  for (const f of readdirSync('dev/sites'))
    writeFileSync(`dist/sites/${f}`, fill(`dev/sites/${f}`));
  const contexts = await Promise.all(
    [loader, panel, detect, preview].map((o) => esbuild.context(o)),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  const [l] = contexts;
  await l.serve({ servedir: 'dist', port, host: '0.0.0.0', cors: { origin: '*' } });
  console.log(`widget dev host page: http://localhost:${port}/`);
}

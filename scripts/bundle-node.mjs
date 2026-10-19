// Bundles a Node runtime role (apps/<role>/src/main.ts) into dist/main.js with esbuild.
// Workspace packages (@kaki/*) are TypeScript source and are bundled in; npm
// dependencies stay external and are installed in the image by `pnpm deploy --prod`.
// KAKI_BUILD=production is defined at build time so dev-only code (the skeleton's
// dev sign-in) is dead code and dropped from the bundle (plan §2).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minifySyntax: true,
  define: { 'process.env.KAKI_BUILD': '"production"' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  plugins: [
    {
      name: 'externalize-npm',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@kaki/') || args.path.startsWith('node:')
            ? undefined
            : { path: args.path, external: true },
        );
      },
    },
  ],
  logLevel: 'info',
});

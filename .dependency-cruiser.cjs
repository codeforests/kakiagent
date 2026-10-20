/**
 * Module boundaries (ADR-001): each module exposes a public `index.ts`; importing
 * another module's internals fails the build. Also enforced: no provider SDK outside
 * llm-gateway (ADR-007), packages never import apps, no cycles.
 * Run: `pnpm boundaries` (part of `pnpm lint`).
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-module-internals',
      comment:
        'Import another module through its package name (its public index.ts), never its internals (ADR-001).',
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/' },
      to: {
        path: '^packages/([^/]+)/src/',
        pathNot: [
          '^packages/$2/',
          '^packages/[^/]+/src/index\\.tsx?$',
          // Declared secondary entry points (package.json "exports").
          '^packages/platform/src/(outbox|pii-mask)\\.ts$',
          '^packages/db/src/(setup|testing)\\.ts$',
          '^packages/identity/src/testing\\.ts$',
          '^packages/ui/src/styles\\.css$',
        ],
      },
    },
    {
      name: 'no-provider-sdk-outside-llm-gateway',
      comment: 'Models are reached only through llm-gateway (ADR-007 decision 5).',
      severity: 'error',
      from: { pathNot: '^packages/llm-gateway/' },
      to: { path: 'node_modules/(@anthropic-ai/(sdk|bedrock-sdk)|@aws-sdk/client-bedrock[^/]*)/' },
    },
    {
      name: 'no-packages-to-apps',
      comment: 'Shared packages must not depend on a runtime role or front end.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'testing-helpers-only-in-tests',
      comment: 'Testcontainers helpers never ship in a runtime role.',
      severity: 'error',
      from: { pathNot: '(^|/)(test|e2e)/|\\.test\\.ts$' },
      to: { path: '^packages/(db|identity)/src/testing\\.ts$' },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        "An import that does not resolve, such as a deep import that the package's exports field blocks.",
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-non-package-json',
      comment: "Depend only on packages declared in the importing unit's package.json.",
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
    },
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};

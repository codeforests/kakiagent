// Root ESLint config for the Node roles and packages. The Vite apps (dashboard,
// operator) keep the config their generator wrote. Module boundaries are enforced by
// dependency-cruiser (.dependency-cruiser.cjs, ADR-001), not here.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    '**/dist',
    '**/coverage',
    '**/node_modules',
    'apps/dashboard',
    'apps/operator',
    'docs',
    'infra',
  ]),
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/widget/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/scripts/**', 'apps/widget/build.mjs', 'e2e/**', 'evals/**'],
    rules: { 'no-console': 'off' },
  },
]);

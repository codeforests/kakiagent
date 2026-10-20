import { envSchemas, loadConfig } from '@kaki/platform';
import { z } from 'zod';

export const schema = envSchemas.base.extend(envSchemas.valkey.shape).extend({
  PORT: envSchemas.port.default(3000),
  HOST: z.string().default('0.0.0.0'),
  DASHBOARD_DATABASE_URL: z.string().startsWith('postgres'),
  VISITOR_DATABASE_URL: z.string().startsWith('postgres'),
  /** Public URLs handed to the widget in its config response. */
  PUBLIC_REALTIME_URL: envSchemas.url,
  PUBLIC_WIDGET_PANEL_URL: envSchemas.url,
  VISITOR_TOKEN_SECRET: envSchemas.secret,
  /** Signs the Google sign-in cookie (`kaki_oauth`). */
  SESSION_SECRET: envSchemas.secret,
  /** Sign-in, sessions and workspace creation (FEAT-005 D2). */
  IDENTITY_DATABASE_URL: z.string().startsWith('postgres'),
  /** The dashboard origin: magic links, the Google redirect URI and the Origin check. */
  PUBLIC_APP_URL: envSchemas.url,
  /** Derives each magic link's token from its ID (FEAT-005 D6). */
  MAGIC_LINK_SECRET: envSchemas.secret,
  /** `smtp://localhost:1025` (Mailpit) locally; the SES SMTP endpoint in AWS (MD). */
  SMTP_URL: z.string().regex(/^smtps?:\/\//),
  EMAIL_FROM: z.string().min(3).default('KakiAgent <no-reply@kakiagent.local>'),
  /** `false` only for local HTTP; the session cookie is Secure everywhere else. */
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  /** Google sign-in is offered only when both are set (FEAT-005 §3.3). */
  GOOGLE_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_ISSUER: envSchemas.url.default('https://accounts.google.com'),
  /** The embedder for fact chunks (FEAT-022 D4); `fake` until real-model access (M1.5, D5). */
  LLM_PROVIDER: z.enum(['fake', 'anthropic-dev']).default('fake'),
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
});

export type Config = z.infer<typeof schema>;
export const loadApiConfig = () => loadConfig(schema);

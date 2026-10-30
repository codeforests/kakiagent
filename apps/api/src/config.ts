import { envSchemas, loadConfig } from '@kaki/platform';
import { z } from 'zod';

export const schema = envSchemas.base
  .extend(envSchemas.valkey.shape)
  .extend(envSchemas.aws.pick({ AWS_REGION: true, AWS_ENDPOINT_URL: true }).shape)
  .extend({
    PORT: envSchemas.port.default(3000),
    HOST: z.string().default('0.0.0.0'),
    DASHBOARD_DATABASE_URL: z.string().startsWith('postgres'),
    VISITOR_DATABASE_URL: z.string().startsWith('postgres'),
    /** Public URLs handed to the widget in its config response. */
    PUBLIC_REALTIME_URL: envSchemas.url,
    PUBLIC_WIDGET_PANEL_URL: envSchemas.url,
    /** The snippet's loader, the dashboard's preview page, and this api's public origin (FEAT-032). */
    PUBLIC_WIDGET_LOADER_URL: envSchemas.url,
    PUBLIC_WIDGET_PREVIEW_URL: envSchemas.url,
    PUBLIC_API_URL: envSchemas.url.transform((u) => u.replace(/\/+$/, '')),
    VISITOR_TOKEN_SECRET: envSchemas.secret,
    /** Signs the Google sign-in cookie (`kaki_oauth`). */
    SESSION_SECRET: envSchemas.secret,
    /** Sign-in, sessions and workspace creation (FEAT-005 D2). */
    IDENTITY_DATABASE_URL: z.string().startsWith('postgres'),
    /** The dashboard origin: magic links, the Google redirect URI and the Origin check. */
    PUBLIC_APP_URL: envSchemas.url,
    /** Derives each magic link's token from its ID (FEAT-005 D6). */
    MAGIC_LINK_SECRET: envSchemas.secret,
    /** Seals TOTP secrets (FEAT-006 §5.1): 32 random bytes, base64url. KMS replaces it (FEAT-037/MD). */
    MFA_SECRET_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64url').length === 32, 'must be 32 bytes, base64url'),
    /** The product name authenticator apps show as the issuer (D4 placeholder name). */
    APP_NAME: z.string().min(1).max(40).default('KakiAgent'),
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
    /** The page limit a new website source gets, until plans exist (FEAT-012 D8, FEAT-067). */
    CRAWL_PAGE_LIMIT: z.coerce.number().int().min(1).max(2000).default(100),
    /** The file sources a tenant may have, until plans exist (D2 Starter; FEAT-015, FEAT-067). */
    FILE_LIMIT: z.coerce.number().int().min(1).max(1000).default(50),
    /** Browsers PUT uploads here through presigned URLs (FEAT-015 §3.2). */
    QUARANTINE_BUCKET: z.string().min(3),
    /** Dev-only: accept hosts on private addresses, such as the fixture site (FEAT-012 §5.6). */
    CRAWL_ALLOW_PRIVATE_HOSTS: z
      .preprocess((v) => v === 'true' || v === '1', z.boolean())
      .default(false),
  });

export type Config = z.infer<typeof schema>;
export const loadApiConfig = () => loadConfig(schema);

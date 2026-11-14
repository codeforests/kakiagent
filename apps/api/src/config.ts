import { envSchemas, loadConfig } from '@kaki/platform';
import { z } from 'zod';

export const schema = envSchemas.base
  .extend(envSchemas.valkey.shape)
  .extend(envSchemas.aws.pick({ AWS_REGION: true, AWS_ENDPOINT_URL: true }).shape)
  .extend(envSchemas.llm.shape)
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
    /** Signs channel handoff links (FEAT-038 D4); the same in the agent-worker. */
    HANDOFF_LINK_SECRET: envSchemas.secret,
    /** Seals TOTP secrets (FEAT-006 §5.1): 32 random bytes, base64url. KMS replaces it (FEAT-037/MD). */
    MFA_SECRET_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64url').length === 32, 'must be 32 bytes, base64url'),
    /**
     * Seals channel credentials (a Telegram bot token, FEAT-037 §5.2): 32 random bytes,
     * base64url, the same in the api, agent-worker and scheduler. KMS replaces it at MD.
     */
    CHANNEL_SECRET_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64url').length === 32, 'must be 32 bytes, base64url'),
    /** Where channel webhooks reach this api: `<url>/hooks/<kind>/<connection id>` (FEAT-037). */
    PUBLIC_HOOKS_URL: envSchemas.url.transform((u) => u.replace(/\/+$/, '')),
    /** The Telegram Bot API; the local fake (`pnpm fixtures:telegram`) in dev and E2E. */
    TELEGRAM_API_BASE: envSchemas.url.default('https://api.telegram.org'),
    /** Webhook requests per connection per minute (FEAT-037 §5.6). */
    HOOK_RATE_LIMIT: z.coerce.number().int().min(10).max(100_000).default(600),
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
    /** The page limit a new website source gets, until plans exist (FEAT-012 D8, FEAT-067). */
    CRAWL_PAGE_LIMIT: z.coerce.number().int().min(1).max(2000).default(100),
    /** The file sources a tenant may have, until plans exist (D2 Starter; FEAT-015, FEAT-067). */
    FILE_LIMIT: z.coerce.number().int().min(1).max(1000).default(50),
    /** Browsers PUT uploads here through presigned URLs (FEAT-015 §3.2). */
    QUARANTINE_BUCKET: z.string().min(3),
    /** The email channel (FEAT-036 §3): `in.<platform domain>` of the forwarding addresses. */
    EMAIL_INBOUND_DOMAIN: z.string().min(3),
    /** Scanned email attachments; staff download them through 5-minute presigned GETs. */
    ATTACHMENTS_BUCKET: z.string().min(3),
    /** The audit anchors bucket, listed (never read) by "Verify audit chain" (FEAT-060 §5.6). */
    AUDIT_ANCHOR_BUCKET: z.string().min(3),
    /** The custom sending domain's provider: SES v2, or `fixture` locally (refused in production). */
    EMAIL_IDENTITY_PROVIDER: z.enum(['ses', 'fixture']).default('ses'),
    SES_CONFIGURATION_SET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    /** Dev-only: accept hosts on private addresses, such as the fixture site (FEAT-012 §5.6). */
    CRAWL_ALLOW_PRIVATE_HOSTS: z
      .preprocess((v) => v === 'true' || v === '1', z.boolean())
      .default(false),
  });

export type Config = z.infer<typeof schema>;
export const loadApiConfig = () => loadConfig(schema);

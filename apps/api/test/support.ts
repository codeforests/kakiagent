import { sql } from '@kaki/db';
import type { TestDatabase } from '@kaki/db/testing';
import { SESSION_COOKIE, startSession, type GoogleSignIn } from '@kaki/identity';
import type { Resolver } from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import {
  createLogger,
  memoryRateLimiter,
  type Email,
  type Mailer,
  type Publisher,
} from '@kaki/platform';
import { buildApp } from '../src/app.js';
import { schema as configSchema } from '../src/config.js';

export const APP_URL = 'http://localhost:5173';

/** Records emails; `down` makes every send fail like an unreachable provider. */
export function fakeMailer() {
  const sent: Email[] = [];
  const m = {
    sent,
    down: false,
    async send(e: Email) {
      if (m.down) throw new Error('smtp down');
      sent.push(e);
    },
    async close() {},
  };
  return m satisfies Mailer;
}

export const tokenIn = (e: Email) => /#token=([A-Za-z0-9_-]{43})/.exec(e.text)![1]!;

export function testConfig(tdb: TestDatabase, env: Record<string, string> = {}) {
  return configSchema.parse({
    NODE_ENV: 'test',
    VALKEY_URL: 'redis://localhost:6379',
    DASHBOARD_DATABASE_URL: tdb.urlFor('app_dashboard'),
    VISITOR_DATABASE_URL: tdb.urlFor('app_agent_visitor'),
    IDENTITY_DATABASE_URL: tdb.urlFor('app_identity'),
    PUBLIC_REALTIME_URL: 'http://localhost:3001',
    PUBLIC_WIDGET_PANEL_URL: 'http://localhost:5175/w/v1/panel.js',
    PUBLIC_APP_URL: APP_URL,
    VISITOR_TOKEN_SECRET: 'v'.repeat(32),
    SESSION_SECRET: 's'.repeat(32),
    MAGIC_LINK_SECRET: 'm'.repeat(32),
    SMTP_URL: 'smtp://localhost:1025',
    ...env,
  });
}

/** The api on the test database, with fakes for email, rate limits and pub/sub. */
export async function testApp(
  tdb: TestDatabase,
  opts: {
    env?: Record<string, string>;
    publisher?: Publisher;
    mailer?: Mailer;
    google?: GoogleSignIn | null;
    resolve?: Resolver;
  } = {},
) {
  return buildApp({
    config: testConfig(tdb, opts.env),
    logger: createLogger('api-test', 'silent'),
    dashboardDb: tdb.zone('dashboard'),
    visitorDb: tdb.zone('visitor'),
    identityDb: tdb.zone('identity'),
    publisher: opts.publisher ?? { publish: async () => {}, close: async () => {} },
    llm: gatewayFromConfig({ provider: 'fake' }),
    mailer: opts.mailer ?? fakeMailer(),
    rateLimiter: memoryRateLimiter(),
    google: opts.google ?? null,
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
  });
}

/** A real session cookie for an existing user, as a sign-in would create (FEAT-005 §5.4). */
export async function sessionCookie(tdb: TestDatabase, email: string): Promise<string> {
  const zone = tdb.zone('identity');
  const { token } = await zone.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`select id from users where email = ${email}`,
    );
    return startSession(tx, rows[0]!.id, 'magic_link');
  });
  return `${SESSION_COOKIE}=${token}`;
}

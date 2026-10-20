import { envSchemas, loadConfig } from '@kaki/platform';
import { z } from 'zod';

export const schema = envSchemas.base.extend(envSchemas.valkey.shape).extend({
  PORT: envSchemas.port.default(3001),
  HOST: z.string().default('0.0.0.0'),
  DASHBOARD_DATABASE_URL: z.string().startsWith('postgres'),
  VISITOR_DATABASE_URL: z.string().startsWith('postgres'),
  IDENTITY_DATABASE_URL: z.string().startsWith('postgres'),
  VISITOR_TOKEN_SECRET: envSchemas.secret,
  /** SSE keep-alive comment interval; proxies drop idle streams. */
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
});

export type Config = z.infer<typeof schema>;
export const loadRealtimeConfig = () => loadConfig(schema);

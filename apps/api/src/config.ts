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
  SESSION_SECRET: envSchemas.secret,
  /** Dev-only sign-in (plan §2). Ignored, and compiled out, in production builds. */
  KAKI_DEV_AUTH: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof schema>;
export const loadApiConfig = () => loadConfig(schema);

import type { ZoneDb } from '@kaki/db';
import type { GoogleSignIn } from '@kaki/identity';
import type { Resolver } from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import type { Logger, Mailer, Publisher, RateLimiter } from '@kaki/platform';
import Fastify from 'fastify';
import type { Config } from './config.js';

export interface Deps {
  config: Config;
  logger: Logger;
  dashboardDb: ZoneDb;
  visitorDb: ZoneDb;
  publisher: Publisher;
  /** Embeds fact chunks on save (FEAT-022 D4). */
  llm: LlmGateway;
  /** Sign-in, sessions and workspace creation (FEAT-005). */
  identityDb: ZoneDb;
  mailer: Mailer;
  rateLimiter: RateLimiter;
  /** Null when Google sign-in isn't configured. */
  google: GoogleSignIn | null;
  /** DNS for the website check (FEAT-012 D7); tests pass a fixed one. */
  resolve?: Resolver;
}

export function createServer(logger: Logger) {
  return Fastify({ loggerInstance: logger, trustProxy: true });
}

export type App = ReturnType<typeof createServer>;

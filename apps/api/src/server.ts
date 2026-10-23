import type { ZoneDb } from '@kaki/db';
import type { GoogleSignIn } from '@kaki/identity';
import type { Resolver } from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import type { Logger, Mailer, Publisher, RateLimiter } from '@kaki/platform';
import Fastify from 'fastify';
import type { Config } from './config.js';

/** Presigns the browser's PUT into quarantine (FEAT-015 §5.1); tests pass a fake. */
export interface UploadSigner {
  sign(
    key: string,
    sizeBytes: number,
    expiresInS: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
}

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
  /** Presigns file uploads into quarantine (FEAT-015 §5.1). */
  uploads: UploadSigner;
  /** DNS for the website check (FEAT-012 D7); tests pass a fixed one. */
  resolve?: Resolver;
}

export function createServer(logger: Logger) {
  return Fastify({ loggerInstance: logger, trustProxy: true });
}

export type App = ReturnType<typeof createServer>;

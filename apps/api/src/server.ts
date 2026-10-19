import type { ZoneDb } from '@kaki/db';
import type { LlmGateway } from '@kaki/llm-gateway';
import type { Logger, Publisher } from '@kaki/platform';
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
}

export function createServer(logger: Logger) {
  return Fastify({ loggerInstance: logger, trustProxy: true });
}

export type App = ReturnType<typeof createServer>;

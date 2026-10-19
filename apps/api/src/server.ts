import type { ZoneDb } from '@kaki/db';
import type { Logger, Publisher } from '@kaki/platform';
import Fastify from 'fastify';
import type { Config } from './config.js';

export interface Deps {
  config: Config;
  logger: Logger;
  dashboardDb: ZoneDb;
  visitorDb: ZoneDb;
  publisher: Publisher;
}

export function createServer(logger: Logger) {
  return Fastify({ loggerInstance: logger, trustProxy: true });
}

export type App = ReturnType<typeof createServer>;

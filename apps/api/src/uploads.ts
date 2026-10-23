import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadRequestBody, UploadTicket } from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import { countFileSources, dashboardKb, FileLimitError, quarantineKey } from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps, UploadSigner } from './server.js';
import { checkFile } from './sources.js';

/** How long an upload URL works (FEAT-015 §3.2). */
export const UPLOAD_TTL_S = 15 * 60;

/**
 * The S3 presigner: the PUT is signed for this key, this exact `Content-Length` (S3 refuses
 * any other body size) and an opaque content type, since the bytes decide the type (D5).
 */
export function s3UploadSigner(cfg: {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
}): UploadSigner {
  const s3 = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  const headers = { 'Content-Type': 'application/octet-stream' };
  return {
    async sign(key, sizeBytes, expiresInS) {
      const cmd = new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        ContentLength: sizeBytes,
        ContentType: headers['Content-Type'],
      });
      const url = await getSignedUrl(s3, cmd, {
        expiresIn: expiresInS,
        signableHeaders: new Set(['content-length', 'content-type']),
      });
      return { url, headers };
    },
  };
}

/**
 * `POST /api/v1/kb/uploads` (KB-02; FEAT-015 §3.2): a presigned PUT under the session
 * tenant's quarantine prefix, for a fresh upload ID. Nothing is written; the source is
 * created after the upload, by `POST /kb/sources` with this ID.
 */
export function registerUploadRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  app.post('/api/v1/kb/uploads', async (req, reply) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'kb.manage')) throw new ForbiddenError('kb.manage');
    const body = UploadRequestBody.parse(req.body);
    checkFile(body.fileName, body.sizeBytes);
    const files = await withTenant(deps.dashboardDb, s.tenantId, (tx) =>
      countFileSources(dashboardKb(tx, s.tenantId, s.userId)),
    );
    if (files >= deps.config.FILE_LIMIT) throw new FileLimitError('file limit');
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_S * 1000);
    const { url, headers } = await deps.uploads.sign(
      quarantineKey(s.tenantId, uploadId),
      body.sizeBytes,
      UPLOAD_TTL_S,
    );
    return reply
      .code(201)
      .send(UploadTicket.parse({ uploadId, url, headers, expiresAt: expiresAt.toISOString() }));
  });
}

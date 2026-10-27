import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  PrivacyNoticeBody,
  PrivacySettingsResponse,
  PurposeStatementBody,
  type PrivacyDocuments,
} from '@kaki/contracts';
import { desc, eq, schema, withTenant, type Tx } from '@kaki/db';
import {
  dataFlowPdf,
  DEFAULT_PURPOSE,
  DOCUMENTS_UPDATED_ON,
  dpaPdf,
  getPrivacySettings,
  NOTICE_CSS,
  noticeSections,
  privacyNoticeUrl,
  privacyReadiness,
  renderNoticeHtml,
  savePrivacyNotice,
  savePurposeStatement,
  SUB_PROCESSORS,
  TRANSFERS,
  visitorPrivacy,
  type PrivacySettings,
  type WordingRef,
} from '@kaki/governance';
import { can, CURRENT_TERMS, TERMS_DOCUMENTS } from '@kaki/identity';
import { getBusinessProfile, resolveWidgetKey, sgDay } from '@kaki/tenancy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** The hosted notice's headers (FEAT-058 §3): no script, nothing embeddable, not indexed. */
const NOTICE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
};

const DOCUMENTS: PrivacyDocuments = {
  updatedOn: DOCUMENTS_UPDATED_ON,
  dpaVersion: CURRENT_TERMS.dpa.version,
  subProcessors: SUB_PROCESSORS.map((s) => ({ ...s })),
  transfers: TRANSFERS.map((t) => ({ ...t })),
};

const PDFS = {
  'data-flow.pdf': () => dataFlowPdf(),
  'dpa.pdf': () => dpaPdf({ dpaVersion: CURRENT_TERMS.dpa.version }),
} as const;
const DocParams = z.object({ doc: z.enum(['data-flow.pdf', 'dpa.pdf']) });

/** The token stylesheet plus the page's own rules, read once at start-up (D7). */
function noticeCss(): string {
  const path = createRequire(import.meta.url).resolve('@kaki/design-tokens/tokens.css');
  return `${readFileSync(path, 'utf8')}\n${NOTICE_CSS}`;
}

const refOf = (w: WordingRef) => ({ seq: w.seq, savedAt: w.createdAt.toISOString() });

async function latestTerms(tx: Tx, tenantId: string) {
  const { termsAcceptances: t } = schema;
  const rows = await tx
    .select({ document: t.document, version: t.version, acceptedAt: t.acceptedAt })
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(desc(t.acceptedAt));
  return TERMS_DOCUMENTS.map((document) => {
    const latest = rows.find((r) => r.document === document);
    return {
      document,
      title: CURRENT_TERMS[document].title,
      currentVersion: CURRENT_TERMS[document].version,
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest?.acceptedAt.toISOString() ?? null,
    };
  });
}

/**
 * The privacy routes (GOV-14, GOV-07, GOV-11, LED-02; FEAT-058 §3, §5.2): the dashboard's
 * Privacy and data settings (Owner and Admin), its PDFs, and the public hosted notice.
 */
export function registerPrivacyRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, visitorDb, config } = deps;
  const css = noticeCss();
  const pdfCache = new Map<keyof typeof PDFS, Promise<Uint8Array>>();

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'settings.manage')) throw new ForbiddenError('settings.manage');
    return s;
  }

  async function response(tx: Tx, tenantId: string, settings: PrivacySettings) {
    const profile = await getBusinessProfile(tx, tenantId, sgDay(new Date()));
    const [tenant] = await tx
      .select({ widgetKey: schema.tenants.widgetKey })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    const { notice, purpose } = settings;
    return PrivacySettingsResponse.parse({
      version: settings.version,
      notice:
        notice.mode === 'none'
          ? notice
          : notice.mode === 'link'
            ? { mode: 'link', url: notice.url, wording: refOf(notice.wording) }
            : {
                mode: 'template',
                fields: notice.fields,
                templateVersion: notice.templateVersion,
                publicUrl: privacyNoticeUrl(
                  {
                    mode: 'template',
                    templateVersion: notice.templateVersion,
                    fields: notice.fields,
                  },
                  tenant!.widgetKey,
                  config.PUBLIC_API_URL,
                ),
                wording: refOf(notice.wording),
              },
      purpose: { text: purpose.text, wording: purpose.wording ? refOf(purpose.wording) : null },
      defaults: {
        purpose: DEFAULT_PURPOSE,
        template: {
          organisationName: profile.name,
          uen: profile.uen,
          contactEmail: profile.contactEmail,
        },
      },
      readiness: await privacyReadiness(tx, tenantId),
      documents: DOCUMENTS,
      terms: await latestTerms(tx, tenantId),
    });
  }

  app.get('/api/v1/settings/privacy', async (req) => {
    const s = await manager(req);
    return withTenant(dashboardDb, s.tenantId, async (tx) =>
      response(tx, s.tenantId, await getPrivacySettings(tx, s.tenantId)),
    );
  });

  app.put('/api/v1/settings/privacy/notice', async (req) => {
    const s = await manager(req);
    const { version, ...notice } = PrivacyNoticeBody.parse(req.body);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const saved = await savePrivacyNotice(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        version,
        notice,
      });
      return response(tx, s.tenantId, saved);
    });
  });

  app.put('/api/v1/settings/privacy/purpose', async (req) => {
    const s = await manager(req);
    const { version, purpose } = PurposeStatementBody.parse(req.body);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const saved = await savePurposeStatement(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        version,
        purpose,
      });
      return response(tx, s.tenantId, saved);
    });
  });

  app.get('/api/v1/settings/privacy/documents/:doc', async (req, reply) => {
    await manager(req);
    const parsed = DocParams.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    const { doc } = parsed.data;
    // The registry is static, so each PDF is made once per process.
    let pdf = pdfCache.get(doc);
    if (!pdf) pdfCache.set(doc, (pdf = PDFS[doc]()));
    const bytes = await pdf;
    return reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        `attachment; filename="kakiagent-${doc.replace('.pdf', '')}-${DOCUMENTS_UPDATED_ON}.pdf"`,
      )
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  });

  const notAvailable = (reply: FastifyReply) =>
    reply
      .code(404)
      .headers({ ...NOTICE_HEADERS, 'cache-control': 'public, max-age=60' })
      .send(
        renderNoticeHtml(
          {
            title: 'This privacy notice isn’t available',
            sections: [
              {
                heading: 'What you can do',
                paragraphs: ['Ask the business for its privacy notice.'],
              },
            ],
            lastUpdated: '',
          },
          css,
        ),
      );

  // The hosted notice of a template tenant (GOV-14; D7): public, no session, no CORS.
  app.get('/privacy/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const install = await resolveWidgetKey(visitorDb, key);
    if (!install || install.status !== 'active') return notAvailable(reply);
    const v = await withTenant(visitorDb, install.tenantId, (tx) => visitorPrivacy(tx));
    if (!v || v.notice?.mode !== 'template' || !v.noticeSavedAt) return notAvailable(reply);
    const html = renderNoticeHtml(
      noticeSections({
        businessName: v.businessName,
        uen: v.uen,
        fields: v.notice.fields,
        purpose: v.purpose?.purpose.en ?? DEFAULT_PURPOSE.en,
        savedAt: v.noticeSavedAt,
      }),
      css,
    );
    return reply.headers({ ...NOTICE_HEADERS, 'cache-control': 'public, max-age=60' }).send(html);
  });
}

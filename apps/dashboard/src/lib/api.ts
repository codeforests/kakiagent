import {
  AssistantSettingsResponse,
  AuthOptions,
  BusinessProfileResponse,
  ConversationList,
  CreateWorkspaceResponse,
  MagicLinkResponse,
  MagicLinkVerifyResponse,
  FactList,
  FactResponse,
  Me,
  ApproveAllResponse,
  ApprovePreview,
  ApproveSelectionResponse,
  ConflictList,
  ResolveConflictResponse,
  RejectSelectionResponse,
  ReviewList,
  ReviewSummary,
  UndoResponse,
  SourceDetail,
  SourceList,
  SourceResponse,
  type ApproveFactBody,
  type AssistantSettingsBody,
  type BusinessProfileBody,
  type CreateFactBody,
  type CreateSourceBody,
  type CreateWorkspaceBody,
  type FactListQuery,
  type FactRef,
  type ResolveConflictBody,
  type ReviewListQuery,
  type ReviewScopeQuery,
  type UpdateFactBody,
} from '@kaki/contracts';
import type { z } from 'zod';

/**
 * A 401 (FEAT-005 §3.6): `unauthorized` when no session was sent, `session_expired` when
 * the one sent has ended (idle, too old or signed out elsewhere).
 */
export class UnauthorizedError extends Error {
  readonly code: 'unauthorized' | 'session_expired';
  constructor(code: string) {
    super('Sign in to continue');
    this.code = code === 'session_expired' ? 'session_expired' : 'unauthorized';
  }
}

/** A non-2xx answer with the API's `{ error, message }` body (design §3.2). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The rest of the body, e.g. `sourceId` on `source_exists`. */
  readonly details: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    } & Record<string, unknown>;
    if (res.status === 401) throw new UnauthorizedError(err.error ?? 'unauthorized');
    throw new ApiError(
      res.status,
      err.error ?? 'error',
      err.message ?? `${path}: ${res.status}`,
      err,
    );
  }
  return res;
}

async function request<S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await send(method, path, body);
  return schema.parse(await res.json());
}

const getJson = <S extends z.ZodType>(path: string, schema: S) => request('GET', path, schema);

function query(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const qs = q.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  me: () => getJson('/api/v1/me', Me),
  authOptions: () => getJson('/api/v1/auth/options', AuthOptions),
  requestMagicLink: (email: string) =>
    request('POST', '/api/v1/auth/magic-link', MagicLinkResponse, { email }),
  verifyMagicLink: (token: string) =>
    request('POST', '/api/v1/auth/magic-link/verify', MagicLinkVerifyResponse, { token }),
  signOut: async () => void (await send('POST', '/api/v1/auth/sign-out')),
  signOutEverywhere: async () => void (await send('POST', '/api/v1/auth/sign-out-everywhere')),
  createWorkspace: (body: CreateWorkspaceBody) =>
    request('POST', '/api/v1/workspaces', CreateWorkspaceResponse, body),
  conversations: () => getJson('/api/v1/conversations', ConversationList),
  facts: (filter: FactListQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter))
      if (v !== undefined && v !== '') params.set(k, String(v));
    const qs = params.toString();
    return getJson(`/api/v1/kb/facts${qs ? `?${qs}` : ''}`, FactList);
  },
  fact: (id: string) => getJson(`/api/v1/kb/facts/${encodeURIComponent(id)}`, FactResponse),
  createFact: (body: CreateFactBody) => request('POST', '/api/v1/kb/facts', FactResponse, body),
  updateFact: (id: string, body: UpdateFactBody) =>
    request('PATCH', `/api/v1/kb/facts/${encodeURIComponent(id)}`, FactResponse, body),
  /** FEAT-011 §3.2: conditional on the version the owner saw; 204 on success. */
  deleteFact: async (id: string, version: number) =>
    void (await send('DELETE', `/api/v1/kb/facts/${encodeURIComponent(id)}?version=${version}`)),
  /** FEAT-024 §3: SCR-APP-041. */
  assistantSettings: () => getJson('/api/v1/settings/assistant', AssistantSettingsResponse),
  saveAssistantSettings: (body: AssistantSettingsBody) =>
    request('PUT', '/api/v1/settings/assistant', AssistantSettingsResponse, body),
  /** FEAT-009 §3: SCR-APP-044 and the setup step. */
  businessProfile: () => getJson('/api/v1/settings/business-profile', BusinessProfileResponse),
  saveBusinessProfile: (body: BusinessProfileBody) =>
    request('PUT', '/api/v1/settings/business-profile', BusinessProfileResponse, body),
  /** FEAT-012 §3: SCR-APP-023, SCR-APP-024 and the website form. */
  sources: () => getJson('/api/v1/kb/sources', SourceList),
  source: (id: string) => getJson(`/api/v1/kb/sources/${encodeURIComponent(id)}`, SourceDetail),
  createSource: (body: CreateSourceBody) =>
    request('POST', '/api/v1/kb/sources', SourceResponse, body),
  retrySource: (id: string, version: number) =>
    request('POST', `/api/v1/kb/sources/${encodeURIComponent(id)}/retry`, SourceResponse, {
      version,
    }),
  deleteSource: async (id: string, version: number) =>
    void (await send('DELETE', `/api/v1/kb/sources/${encodeURIComponent(id)}?version=${version}`)),
  /** FEAT-013 §3: SCR-APP-019 and SCR-APP-008. */
  reviewFacts: (q: ReviewListQuery) => getJson(`/api/v1/kb/review/facts${query(q)}`, ReviewList),
  reviewSummary: () => getJson('/api/v1/kb/review/summary', ReviewSummary),
  approvePreview: (scope: ReviewScopeQuery) =>
    getJson(`/api/v1/kb/review/preview${query(scope)}`, ApprovePreview),
  approveAll: (scope: ReviewScopeQuery, previewHash: string) =>
    request('POST', '/api/v1/kb/review/approve-all', ApproveAllResponse, {
      ...scope,
      previewHash,
    }),
  approveFact: (id: string, body: ApproveFactBody) =>
    request('POST', `/api/v1/kb/facts/${encodeURIComponent(id)}/approve`, FactResponse, body),
  rejectFact: (id: string, version: number) =>
    request('POST', `/api/v1/kb/facts/${encodeURIComponent(id)}/reject`, FactResponse, {
      version,
    }),
  approveSelected: (facts: FactRef[]) =>
    request('POST', '/api/v1/kb/review/approve', ApproveSelectionResponse, { facts }),
  rejectSelected: (facts: FactRef[]) =>
    request('POST', '/api/v1/kb/review/reject', RejectSelectionResponse, { facts }),
  undoReview: (facts: FactRef[]) =>
    request('POST', '/api/v1/kb/review/undo', UndoResponse, { facts }),
  conflicts: () => getJson('/api/v1/kb/conflicts', ConflictList),
  resolveConflict: (body: ResolveConflictBody) =>
    request('POST', '/api/v1/kb/conflicts/resolve', ResolveConflictResponse, body),
};

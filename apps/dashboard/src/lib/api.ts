import {
  AuthOptions,
  ConversationList,
  CreateWorkspaceResponse,
  MagicLinkResponse,
  MagicLinkVerifyResponse,
  FactList,
  FactResponse,
  Me,
  type CreateFactBody,
  type CreateWorkspaceBody,
  type FactListQuery,
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
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
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
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 401) throw new UnauthorizedError(err.error ?? 'unauthorized');
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? `${path}: ${res.status}`);
  }
  return res;
}

async function request<S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await send(method, path, body);
  return schema.parse(await res.json());
}

const getJson = <S extends z.ZodType>(path: string, schema: S) => request('GET', path, schema);

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
};

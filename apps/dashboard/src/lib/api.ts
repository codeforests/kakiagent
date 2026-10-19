import {
  ConversationList,
  FactList,
  FactResponse,
  Me,
  type CreateFactBody,
  type FactStatus,
  type UpdateFactBody,
} from '@kaki/contracts';
import type { z } from 'zod';

export class UnauthorizedError extends Error {}

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

async function request<S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? `${path}: ${res.status}`);
  }
  return schema.parse(await res.json());
}

const getJson = <S extends z.ZodType>(path: string, schema: S) => request('GET', path, schema);

export const api = {
  me: () => getJson('/api/v1/me', Me),
  conversations: () => getJson('/api/v1/conversations', ConversationList),
  facts: (filter: { status?: FactStatus | undefined; q?: string | undefined }) => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.q) params.set('q', filter.q);
    const qs = params.toString();
    return getJson(`/api/v1/kb/facts${qs ? `?${qs}` : ''}`, FactList);
  },
  fact: (id: string) => getJson(`/api/v1/kb/facts/${encodeURIComponent(id)}`, FactResponse),
  createFact: (body: CreateFactBody) => request('POST', '/api/v1/kb/facts', FactResponse, body),
  updateFact: (id: string, body: UpdateFactBody) =>
    request('PATCH', `/api/v1/kb/facts/${encodeURIComponent(id)}`, FactResponse, body),
};

import { ConversationList, Me } from '@kaki/contracts';
import type { z } from 'zod';

export class UnauthorizedError extends Error {}

async function getJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return schema.parse(await res.json());
}

export const api = {
  me: () => getJson('/api/v1/me', Me),
  conversations: () => getJson('/api/v1/conversations', ConversationList),
};

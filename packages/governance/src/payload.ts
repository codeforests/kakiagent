import { piiMask } from '@kaki/platform';
import { canonicalJson } from './canonical.js';

/**
 * What an audit entry may carry (ADR-014 decision 2, D7): IDs, codes, hashes, numbers,
 * booleans and masked text, never free text. The value types are branded, so a plain
 * `string` in a payload is a type error; `assertAuditEntry` re-checks the same rules at
 * runtime for anything that got past the types (design D6).
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AuditId = Brand<string, 'AuditId'>;
export type AuditCode = Brand<string, 'AuditCode'>;
export type AuditHash = Brand<string, 'AuditHash'>;
export type Masked = Brand<{ readonly masked: string }, 'Masked'>;
export type AuditValue =
  number | boolean | null | AuditId | AuditCode | AuditHash | Masked | readonly AuditValue[];
export type AuditPayload = { readonly [key: string]: AuditValue };

export type ActorType = 'agent' | 'user' | 'operator' | 'system' | 'visitor';
export const ACTOR_TYPES: readonly ActorType[] = ['agent', 'user', 'operator', 'system', 'visitor'];

export interface AuditEntry {
  /** The event type, a code such as `fact.updated`. */
  action: string;
  actorType: ActorType;
  /** An ID (UUID or code), never a name or email. */
  actorId?: string | undefined;
  /** The primary subject: a type code and its ID. */
  subjectType: string;
  subjectId: string;
  /** Further subjects, such as the conversation of a message (GOV-02 filters on them). */
  related?: readonly { type: string; id: string }[] | undefined;
  payload?: AuditPayload | undefined;
  /** Personal data the entry needs: stored in `audit_pii`, deletable with the contact. */
  pii?: { contactId: string | null; data: Record<string, unknown> } | undefined;
}

export class AuditPayloadError extends Error {
  override name = 'AuditPayloadError';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const MASKED_MAX = 500;
const ARRAY_MAX = 200;
const DEPTH_MAX = 4;
const PAYLOAD_BYTES_MAX = 8192;

const isId = (s: string) => UUID_RE.test(s) || CODE_RE.test(s);

export function auditId(id: string): AuditId {
  if (!UUID_RE.test(id)) throw new AuditPayloadError('auditId: not a UUID');
  return id.toLowerCase() as AuditId;
}

export function auditCode(code: string): AuditCode {
  if (!CODE_RE.test(code)) throw new AuditPayloadError(`auditCode: invalid code`);
  return code as AuditCode;
}

export function auditHash(hex: string): AuditHash {
  if (!HASH_RE.test(hex)) throw new AuditPayloadError('auditHash: not a SHA-256 hex digest');
  return hex as AuditHash;
}

/** Text that passed the edge PII masker (ADR-015), at most 500 characters. */
export function masked(text: string): Masked {
  const m = piiMask(text);
  if (m.length > MASKED_MAX) throw new AuditPayloadError(`masked: over ${MASKED_MAX} characters`);
  return { masked: m } as Masked;
}

function checkValue(v: unknown, path: string, depth: number): void {
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new AuditPayloadError(`${path}: non-finite number`);
    return;
  }
  if (typeof v === 'string') {
    if (!isId(v) && !HASH_RE.test(v))
      throw new AuditPayloadError(`${path}: free text is not allowed; use an ID, code or masked()`);
    return;
  }
  // The payload itself is level 1; a container here would be level depth + 2.
  if (depth + 2 > DEPTH_MAX) throw new AuditPayloadError(`${path}: nested too deeply`);
  if (Array.isArray(v)) {
    if (v.length > ARRAY_MAX) throw new AuditPayloadError(`${path}: over ${ARRAY_MAX} items`);
    v.forEach((x, i) => checkValue(x, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'masked') {
      const m = (v as { masked: unknown }).masked;
      if (typeof m !== 'string' || m.length > MASKED_MAX)
        throw new AuditPayloadError(`${path}: masked text must be a string of ≤ ${MASKED_MAX}`);
      if (m.includes('\u0000')) throw new AuditPayloadError(`${path}: NUL in masked text`);
      return;
    }
    checkPayload(v as Record<string, unknown>, path, depth + 1);
    return;
  }
  throw new AuditPayloadError(`${path}: unsupported ${typeof v}`);
}

function checkPayload(obj: Record<string, unknown>, path: string, depth: number) {
  if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null)
    throw new AuditPayloadError(`${path}: not a plain object`);
  for (const [k, v] of Object.entries(obj)) {
    if (!KEY_RE.test(k)) throw new AuditPayloadError(`${path}: invalid key`);
    checkValue(v, `${path}.${k}`, depth);
  }
}

/** Throws `AuditPayloadError` unless every part of the entry is PII-free by construction. */
export function assertAuditEntry(entry: AuditEntry): void {
  if (!CODE_RE.test(entry.action)) throw new AuditPayloadError('action: invalid code');
  if (!ACTOR_TYPES.includes(entry.actorType)) throw new AuditPayloadError('actorType: invalid');
  if (entry.actorId !== undefined && !isId(entry.actorId))
    throw new AuditPayloadError('actorId: must be an ID');
  for (const s of [{ type: entry.subjectType, id: entry.subjectId }, ...(entry.related ?? [])]) {
    if (!TYPE_RE.test(s.type)) throw new AuditPayloadError('subject type: invalid');
    if (!isId(s.id)) throw new AuditPayloadError('subject id: must be an ID');
  }
  if (entry.payload !== undefined) {
    if (entry.payload === null || typeof entry.payload !== 'object' || Array.isArray(entry.payload))
      throw new AuditPayloadError('payload: must be an object');
    checkPayload(entry.payload as Record<string, unknown>, 'payload', 0);
    if (Buffer.byteLength(canonicalJson(entry.payload)) > PAYLOAD_BYTES_MAX)
      throw new AuditPayloadError(`payload: over ${PAYLOAD_BYTES_MAX} bytes`);
  }
  if (entry.pii !== undefined) {
    if (entry.pii.contactId !== null && !UUID_RE.test(entry.pii.contactId))
      throw new AuditPayloadError('pii.contactId: not a UUID');
    canonicalJson(entry.pii.data); // must be serialisable for the commitment
  }
}

/** `type:id` subject refs, the primary subject first. */
export function subjectRefs(entry: AuditEntry): string[] {
  return [
    `${entry.subjectType}:${entry.subjectId}`,
    ...(entry.related ?? []).map((r) => `${r.type}:${r.id}`),
  ];
}

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), for hashing audit entries
 * deterministically (ADR-014 decision 1). Object keys are sorted by UTF-16 code units;
 * strings and finite numbers use ECMAScript serialisation, which is what
 * `JSON.stringify` produces for them; there is no whitespace.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError('canonicalJson: only plain objects and arrays');
      const obj = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) throw new TypeError(`canonicalJson: undefined at "${k}"`);
        parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

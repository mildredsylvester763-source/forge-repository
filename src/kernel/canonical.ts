/**
 * Deterministic JSON: object keys sorted, no whitespace, undefined properties dropped.
 * Used for hashing, so two equal values must always serialise to the same bytes.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (current: unknown): string => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(current);
    }

    if (typeof current === 'object') {
      if (ancestors.has(current)) throw new TypeError('canonicalJson: cyclic value');
      ancestors.add(current);
      try {
        if (Array.isArray(current)) {
          // Iterate every index instead of Array#map: sparse holes must be rejected, not omitted
          // into malformed JSON such as "[1,,3]".
          const items: string[] = [];
          for (let index = 0; index < current.length; index += 1) {
            items.push(encode(current[index]));
          }
          return '[' + items.join(',') + ']';
        }

        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('canonicalJson: unsupported object prototype');
        }

        const obj = current as Record<string, unknown>;
        const keys = Object.keys(obj)
          .filter((key) => obj[key] !== undefined)
          .sort();
        return '{' + keys.map((key) => JSON.stringify(key) + ':' + encode(obj[key])).join(',') + '}';
      } finally {
        ancestors.delete(current);
      }
    }

    throw new TypeError(`canonicalJson: unsupported type ${typeof current}`);
  };

  return encode(value);
}

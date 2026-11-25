import { AppError } from './errors.ts';

export interface FieldSpec {
  max: number;
  optional?: boolean;
}

export type Parsed<S extends Record<string, FieldSpec>> = {
  [K in keyof S]: S[K]['optional'] extends true ? string | undefined : string;
};

function invalid(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

/** Strict body parsing: only known string fields, with length caps. Unknown fields are rejected. */
export function parseFields<const S extends Record<string, FieldSpec>>(
  body: Record<string, unknown>,
  spec: S,
): Parsed<S> {
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(spec, key)) throw invalid(key, 'unknown_field');
  }
  const out: Record<string, string | undefined> = {};
  for (const [field, rule] of Object.entries(spec)) {
    const value = body[field];
    if (value === undefined) {
      if (rule.optional === true) {
        out[field] = undefined;
        continue;
      }
      throw invalid(field, 'required');
    }
    if (typeof value !== 'string') throw invalid(field, 'must_be_string');
    if (value.length > rule.max) throw invalid(field, 'too_long');
    out[field] = value;
  }
  return out as Parsed<S>;
}

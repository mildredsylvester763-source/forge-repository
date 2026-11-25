export interface AppErrorOptions {
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
  cause?: unknown;
}

/** An error that is safe to show to a client. Anything else becomes a generic 500. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export function retryAfterHeader(ms: number): Record<string, string> {
  return { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) };
}

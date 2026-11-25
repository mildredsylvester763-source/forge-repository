import { AppError } from './errors.ts';
import type { EventStore } from './events.ts';
import type { RouteTable } from './http.ts';
import type { Logger } from './logger.ts';

/**
 * Liveness stays independent of storage. Readiness proves the event store can answer,
 * which is also the database dependency used by the current application composition.
 */
export function healthRoutes(events: Pick<EventStore, 'head'>, logger: Logger): RouteTable {
  return {
    '/healthz': {
      GET: async () => ({ status: 200, body: { status: 'ok' } }),
    },
    '/readyz': {
      GET: async () => {
        try {
          const head = await events.head();
          return { status: 200, body: { status: 'ready', auditSeq: head.seq } };
        } catch (err) {
          // Keep connection details and provider errors out of the public health response and logs.
          logger.error('readiness probe failed', { dependency: 'event_store' });
          throw new AppError(503, 'not_ready', 'A required service is unavailable.', { cause: err });
        }
      },
    },
  };
}

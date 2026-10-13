import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeConfig } from './config.ts';
import { systemClock, type Clock } from './kernel/clock.ts';
import { InMemoryEventStore, type EventStore } from './kernel/events.ts';
import { createHttpHandler, type RouteTable } from './kernel/http.ts';
import { createLogger, type Logger } from './kernel/logger.ts';
import {
  CompositeBreachChecker,
  DEFAULT_THROTTLE,
  HibpBreachChecker,
  IdentityService,
  InMemorySessionStore,
  InMemoryUserStore,
  LocalBlocklistChecker,
  LoginThrottle,
  PasswordHasher,
  SessionService,
  identityRoutes,
  type BreachChecker,
  type ThrottleConfig,
} from './modules/identity/index.ts';

export interface AppOverrides {
  clock?: Clock;
  logger?: Logger;
  breach?: BreachChecker;
  events?: EventStore;
  throttle?: Partial<ThrottleConfig>;
}

export interface ForgeApp {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  events: EventStore;
  identity: IdentityService;
  logger: Logger;
}

/**
 * Composition root: the one place where modules are wired together.
 * Adding a module means adding its routes here and (if it reacts to others) subscribing to events.
 */
export function buildApp(config: ForgeConfig, overrides: AppOverrides = {}): ForgeApp {
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  const events = overrides.events ?? new InMemoryEventStore({ clock, logger });

  const hasher = new PasswordHasher({
    params: config.password.params,
    peppers: config.password.peppers,
    currentPepperVersion: config.password.currentPepperVersion,
    concurrency: config.password.hashConcurrency,
    maxQueue: config.password.hashQueue,
  });

  const breach =
    overrides.breach ??
    new CompositeBreachChecker([
      new LocalBlocklistChecker(),
      new HibpBreachChecker({ baseUrl: config.breach.baseUrl, timeoutMs: config.breach.timeoutMs }),
    ]);

  const identity = new IdentityService({
    users: new InMemoryUserStore(),
    sessions: new SessionService({ store: new InMemorySessionStore(), clock, config: config.session }),
    hasher,
    breach,
    events,
    throttle: new LoginThrottle({ config: { ...DEFAULT_THROTTLE, ...overrides.throttle }, clock }),
    clock,
    logger,
    auditKey: config.auditKey,
    breachMode: config.breach.mode,
    checkBreachOnSignIn: config.breach.checkOnSignIn,
  });

  const routes: RouteTable = {
    '/healthz': { GET: async () => ({ status: 200, body: { status: 'ok' } }) },
    '/readyz': {
      GET: async () => {
        const head = await events.head();
        return { status: 200, body: { status: 'ready', auditSeq: head.seq } };
      },
    },
    ...identityRoutes(identity, config.cookie, clock),
  };

  const handler = createHttpHandler({
    routes,
    logger,
    allowedOrigins: config.allowedOrigins,
    trustProxyHops: config.trustProxyHops,
    hsts: config.env === 'production',
  });

  return { handler, events, identity, logger };
}

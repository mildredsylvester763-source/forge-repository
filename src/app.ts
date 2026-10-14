import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeConfig } from './config.ts';
import { systemClock, type Clock } from './kernel/clock.ts';
import { InMemoryEventStore, type EventStore } from './kernel/events.ts';
import { createHttpHandler, type RouteTable } from './kernel/http.ts';
import { createLogger, type Logger } from './kernel/logger.ts';
import { kernelMigrations } from './kernel/migrations.ts';
import { migrate, openDatabase, type Database } from './kernel/sqlite.ts';
import { SqliteEventStore } from './kernel/sqlite-events.ts';
import {
  CompositeBreachChecker,
  DEFAULT_THROTTLE,
  HibpBreachChecker,
  IdentityService,
  InMemoryIdentityUnitOfWork,
  InMemorySessionStore,
  InMemoryUserStore,
  LocalBlocklistChecker,
  LoginThrottle,
  PasswordHasher,
  SessionService,
  SqliteIdentityUnitOfWork,
  SqliteSessionStore,
  SqliteUserStore,
  identityMigrations,
  identityRoutes,
  type BreachChecker,
  type IdentityUnitOfWork,
  type SessionStore,
  type ThrottleConfig,
  type UserStore,
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
  /** Null when running on in-memory storage. */
  db: Database | null;
  close(): void;
}

interface Storage {
  db: Database | null;
  events: EventStore;
  users: UserStore;
  sessionStore: SessionStore;
  uow: IdentityUnitOfWork;
}

function buildStorage(config: ForgeConfig, clock: Clock, logger: Logger, eventsOverride: EventStore | undefined): Storage {
  const path = config.storage.databasePath;
  if (path !== null && eventsOverride === undefined) {
    const db = openDatabase(path);
    migrate(db, 'kernel', kernelMigrations);
    migrate(db, 'identity', identityMigrations);
    const events = new SqliteEventStore({ db, clock, logger });
    const users = new SqliteUserStore(db);
    const sessionStore = new SqliteSessionStore(db);
    return { db, events, users, sessionStore, uow: new SqliteIdentityUnitOfWork({ db, users, sessions: sessionStore, events, clock }) };
  }
  const events = eventsOverride ?? new InMemoryEventStore({ clock, logger });
  const users = new InMemoryUserStore();
  const sessionStore = new InMemorySessionStore();
  return { db: null, events, users, sessionStore, uow: new InMemoryIdentityUnitOfWork({ users, sessions: sessionStore, events, clock }) };
}

/**
 * Composition root: the one place where modules are wired together.
 * Adding a module means adding its routes here and (if it reacts to others) subscribing to events.
 */
export function buildApp(config: ForgeConfig, overrides: AppOverrides = {}): ForgeApp {
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  const storage = buildStorage(config, clock, logger, overrides.events);
  const { events } = storage;

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
    users: storage.users,
    sessions: new SessionService({ store: storage.sessionStore, clock, config: config.session }),
    hasher,
    breach,
    events,
    uow: storage.uow,
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
        const head = await events.head(); // also proves the database answers
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

  return { handler, events, identity, logger, db: storage.db, close: () => storage.db?.close() };
}

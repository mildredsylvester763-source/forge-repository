import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeConfig } from './config.ts';
import { systemClock, type Clock } from './kernel/clock.ts';
import { InMemoryEventStore, type EventStore } from './kernel/events.ts';
import { createHttpHandler, type RouteTable } from './kernel/http.ts';
import { createLogger, type Logger } from './kernel/logger.ts';
import { kernelMigrations } from './kernel/migrations.ts';
import { migrate, openDatabase, type Database } from './kernel/sqlite.ts';
import { PostgresEventStore } from './kernel/postgres-events.ts';
import type { SqlPool } from './kernel/sql.ts';
import {
  BuildCiService,
  PostgresBuildCiStore,
  SqliteBuildCiStore,
  migrateBuildCiSqlite,
  type PipelineAuthorizer,
  type PipelineStore,
  SqliteWorkspaceMembershipReader,
  PostgresWorkspaceMembershipReader,
  createWorkspacePipelineAuthorizer,
  workspaceAccessMigrations,
  type WorkspaceMembershipReader,
  buildCiRoutes,
} from './modules/build-ci/index.ts';
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
  PostgresIdentityUnitOfWork,
  PostgresSessionStore,
  PostgresUserStore,
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
  /** A connected, already-migrated PostgreSQL pool. When given, it is the storage. */
  postgres?: SqlPool;
  /** Workspace-scoped policy supplied by the workspace/permissions module. Defaults to deny. */
  buildCiAuthorize?: PipelineAuthorizer;
}

export interface ForgeApp {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  events: EventStore;
  identity: IdentityService;
  buildCi: BuildCiService;
  logger: Logger;
  /** The SQLite handle, or null (in-memory and PostgreSQL storage). */
  db: Database | null;
  close(): Promise<void>;
}

interface Storage {
  db: Database | null;
  pool: SqlPool | null;
  events: EventStore;
  users: UserStore;
  sessionStore: SessionStore;
  uow: IdentityUnitOfWork;
  buildCiDb: Database | null;
  buildCiStore: PipelineStore;
  workspaceMemberships: WorkspaceMembershipReader;
}

function buildStorage(config: ForgeConfig, clock: Clock, logger: Logger, overrides: AppOverrides): Storage {
  const eventsOverride = overrides.events;
  if (overrides.postgres) {
    const pool = overrides.postgres;
    const events = new PostgresEventStore({ pool, clock, logger });
    const users = new PostgresUserStore(pool);
    const sessionStore = new PostgresSessionStore(pool);
    return {
      db: null, pool, events, users, sessionStore,
      uow: new PostgresIdentityUnitOfWork({ pool, users, sessions: sessionStore, events, clock }),
      buildCiDb: null,
      buildCiStore: new PostgresBuildCiStore(pool),
      workspaceMemberships: new PostgresWorkspaceMembershipReader(pool),
    };
  }
  const path = config.storage.databasePath;
  if (path !== null && eventsOverride === undefined) {
    const db = openDatabase(path);
    migrate(db, 'kernel', kernelMigrations);
    migrate(db, 'identity', identityMigrations);
    migrateBuildCiSqlite(db);
    migrate(db, 'workspace_access', workspaceAccessMigrations);
    const events = new SqliteEventStore({ db, clock, logger });
    const users = new SqliteUserStore(db);
    const sessionStore = new SqliteSessionStore(db);
    return {
      db, pool: null, events, users, sessionStore,
      uow: new SqliteIdentityUnitOfWork({ db, users, sessions: sessionStore, events, clock }),
      buildCiDb: null,
      buildCiStore: new SqliteBuildCiStore(db),
      workspaceMemberships: new SqliteWorkspaceMembershipReader(db),
    };
  }
  const events = eventsOverride ?? new InMemoryEventStore({ clock, logger });
  const users = new InMemoryUserStore();
  const sessionStore = new InMemorySessionStore();
  // Keep Build & CI persistence real even when identity/events use in-memory test adapters.
  const buildCiDb = openDatabase(':memory:');
  migrateBuildCiSqlite(buildCiDb);
  migrate(buildCiDb, 'workspace_access', workspaceAccessMigrations);
  return {
    db: null, pool: null, events, users, sessionStore,
    uow: new InMemoryIdentityUnitOfWork({ users, sessions: sessionStore, events, clock }),
    buildCiDb,
    buildCiStore: new SqliteBuildCiStore(buildCiDb),
    workspaceMemberships: new SqliteWorkspaceMembershipReader(buildCiDb),
  };
}

/**
 * Composition root: the one place where modules are wired together.
 * Adding a module means adding its routes here and (if it reacts to others) subscribing to events.
 */
export function buildApp(config: ForgeConfig, overrides: AppOverrides = {}): ForgeApp {
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  const storage = buildStorage(config, clock, logger, overrides);
  const { events } = storage;
  // Workspace permissions are read from persisted membership records; identity alone grants no access.
  const buildCi = new BuildCiService({
    store: storage.buildCiStore,
    authorize: overrides.buildCiAuthorize ?? createWorkspacePipelineAuthorizer(storage.workspaceMemberships),
  });

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
    ...buildCiRoutes(buildCi, identity, config.cookie, clock),
  };

  const handler = createHttpHandler({
    routes,
    logger,
    allowedOrigins: config.allowedOrigins,
    trustProxyHops: config.trustProxyHops,
    hsts: config.env === 'production',
    // Only pipeline-definition creation needs a larger body budget; all other routes keep the 16 KiB default.
    maxBodyBytes: { '/v1/build-ci/pipelines': 300 * 1024 },
  });

  const close = async (): Promise<void> => {
    storage.db?.close();
    storage.buildCiDb?.close();
    await storage.pool?.end();
  };

  return { handler, events, identity, buildCi, logger, db: storage.db, close };
}

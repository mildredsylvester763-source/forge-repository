import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeConfig } from './config.ts';
import { systemClock, type Clock } from './kernel/clock.ts';
import { InMemoryEventStore, type EventStore } from './kernel/events.ts';
import { createHttpHandler, type RouteTable } from './kernel/http.ts';
import { createLogger, type Logger } from './kernel/logger.ts';
import { kernelMigrations } from './kernel/migrations.ts';
import { healthRoutes } from './kernel/health.ts';
import { migrate, openDatabase, type Database } from './kernel/sqlite.ts';
import { PostgresEventStore } from './kernel/postgres-events.ts';
import type { SqlPool } from './kernel/sql.ts';
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
import {
  InMemoryTaskRunStore,
  PostgresTaskRunStore,
  SqliteTaskRunStore,
  TaskRuntimeService,
  taskRuntimeMigrations,
  taskRuntimeRoutes,
  type TaskRunStore,
} from './modules/task-runtime/index.ts';
import {
  InMemoryOrchestratorPlanStore,
  OrchestratorService,
  PostgresOrchestratorPlanStore,
  SqliteOrchestratorPlanStore,
  orchestratorMigrations,
  orchestratorRoutes,
  type OrchestratorPlanStore,
} from './modules/orchestrator/index.ts';
import {
  InMemoryGoldenStore,
  PostgresGoldenStore,
  SqliteGoldenStore,
  TestQualityService,
  testQualityMigrations,
  testQualityRoutes,
  type TestQualityGoldenStore,
} from './modules/test-quality/index.ts';
import {
  InMemoryGeneratedSuiteStore,
  PostgresGeneratedSuiteStore,
  SqliteGeneratedSuiteStore,
  TestGenerationService,
  testGenerationMigrations,
  testGenerationRoutes,
  type GeneratedSuiteStore,
} from './modules/test-generation/index.ts';
import {
  InMemoryLiveTestingStore,
  LiveTestingService,
  PostgresLiveTestingStore,
  SqliteLiveTestingStore,
  liveTestingMigrations,
  liveTestingRoutes,
  type LiveTestingStore,
} from './modules/live-testing/index.ts';
import {
  InMemoryWebSearchStore,
  PostgresWebSearchStore,
  SqliteWebSearchStore,
  WebSearchService,
  webSearchMigrations,
  webSearchRoutes,
  type WebSearchStore,
} from './modules/web-search/index.ts';
import {
  InMemorySearchIntegrityStore,
  PostgresSearchIntegrityStore,
  SearchIntegrityService,
  SqliteSearchIntegrityStore,
  searchIntegrityMigrations,
  searchIntegrityRoutes,
  type SearchIntegrityStore,
} from './modules/search-integrity/index.ts';
import {
  InMemoryWorkspaceRetrievalStore,
  PostgresWorkspaceRetrievalStore,
  SqliteWorkspaceRetrievalStore,
  WorkspaceRetrievalService,
  workspaceRetrievalMigrations,
  workspaceRetrievalRoutes,
  type WorkspaceRetrievalStore,
} from './modules/workspace-retrieval/index.ts';
import {
  AiTrainingService,
  InMemoryAiTrainingStore,
  PostgresAiTrainingStore,
  SqliteAiTrainingStore,
  aiTrainingMigrations,
  aiTrainingRoutes,
  type AiTrainingStore,
} from './modules/ai-training/index.ts';

export interface AppOverrides {
  clock?: Clock;
  logger?: Logger;
  breach?: BreachChecker;
  events?: EventStore;
  throttle?: Partial<ThrottleConfig>;
  /** A connected, already-migrated PostgreSQL pool. When given, it is the storage. */
  postgres?: SqlPool;
}

export interface ForgeApp {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  events: EventStore;
  identity: IdentityService;
  tasks: TaskRuntimeService;
  orchestrator: OrchestratorService;
  testQuality: TestQualityService;
  testGeneration: TestGenerationService;
  liveTesting: LiveTestingService;
  webSearch: WebSearchService;
  workspaceRetrieval: WorkspaceRetrievalService;
  searchIntegrity: SearchIntegrityService;
  aiTraining: AiTrainingService;
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
  runs: TaskRunStore;
  plans: OrchestratorPlanStore;
  goldens: TestQualityGoldenStore;
  suites: GeneratedSuiteStore;
  liveTesting: LiveTestingStore;
  webSearch: WebSearchStore;
  workspaceRetrieval: WorkspaceRetrievalStore;
  searchIntegrity: SearchIntegrityStore;
  aiTraining: AiTrainingStore;
}

function buildStorage(config: ForgeConfig, clock: Clock, logger: Logger, overrides: AppOverrides): Storage {
  const eventsOverride = overrides.events;
  if (overrides.postgres) {
    const pool = overrides.postgres;
    const events = new PostgresEventStore({ pool, clock, logger });
    const users = new PostgresUserStore(pool);
    const sessionStore = new PostgresSessionStore(pool);
    const runs = new PostgresTaskRunStore(pool);
    const plans = new PostgresOrchestratorPlanStore(pool);
    const goldens = new PostgresGoldenStore(pool);
    const suites = new PostgresGeneratedSuiteStore(pool);
    const liveTesting = new PostgresLiveTestingStore(pool);
    const webSearch = new PostgresWebSearchStore(pool);
    const workspaceRetrieval = new PostgresWorkspaceRetrievalStore(pool);
    const searchIntegrity = new PostgresSearchIntegrityStore(pool);
    const aiTraining = new PostgresAiTrainingStore(pool);
    return { db: null, pool, events, users, sessionStore, runs, plans, goldens, suites, liveTesting, webSearch, workspaceRetrieval, searchIntegrity, aiTraining, uow: new PostgresIdentityUnitOfWork({ pool, users, sessions: sessionStore, events, clock }) };
  }
  const path = config.storage.databasePath;
  if (path !== null && eventsOverride === undefined) {
    const db = openDatabase(path);
    migrate(db, 'kernel', kernelMigrations);
    migrate(db, 'identity', identityMigrations);
    migrate(db, 'task_runtime', taskRuntimeMigrations);
    migrate(db, 'orchestrator', orchestratorMigrations);
    migrate(db, 'test_quality', testQualityMigrations);
    migrate(db, 'test_generation', testGenerationMigrations);
    migrate(db, 'live_testing', liveTestingMigrations);
    migrate(db, 'web_search', webSearchMigrations);
    migrate(db, 'workspace_retrieval', workspaceRetrievalMigrations);
    migrate(db, 'search_integrity', searchIntegrityMigrations);
    migrate(db, 'ai_training', aiTrainingMigrations);
    const events = new SqliteEventStore({ db, clock, logger });
    const users = new SqliteUserStore(db);
    const sessionStore = new SqliteSessionStore(db);
    const runs = new SqliteTaskRunStore(db);
    const plans = new SqliteOrchestratorPlanStore(db);
    const goldens = new SqliteGoldenStore(db);
    const suites = new SqliteGeneratedSuiteStore(db);
    const liveTesting = new SqliteLiveTestingStore(db);
    const webSearch = new SqliteWebSearchStore(db);
    const workspaceRetrieval = new SqliteWorkspaceRetrievalStore(db);
    const searchIntegrity = new SqliteSearchIntegrityStore(db);
    const aiTraining = new SqliteAiTrainingStore(db);
    return { db, pool: null, events, users, sessionStore, runs, plans, goldens, suites, liveTesting, webSearch, workspaceRetrieval, searchIntegrity, aiTraining, uow: new SqliteIdentityUnitOfWork({ db, users, sessions: sessionStore, events, clock }) };
  }
  const events = eventsOverride ?? new InMemoryEventStore({ clock, logger });
  const users = new InMemoryUserStore();
  const sessionStore = new InMemorySessionStore();
  const runs = new InMemoryTaskRunStore();
  const plans = new InMemoryOrchestratorPlanStore();
  const goldens = new InMemoryGoldenStore();
  const suites = new InMemoryGeneratedSuiteStore();
  const liveTesting = new InMemoryLiveTestingStore();
  const webSearch = new InMemoryWebSearchStore();
  const workspaceRetrieval = new InMemoryWorkspaceRetrievalStore();
  const searchIntegrity = new InMemorySearchIntegrityStore();
  const aiTraining = new InMemoryAiTrainingStore();
  return { db: null, pool: null, events, users, sessionStore, runs, plans, goldens, suites, liveTesting, webSearch, workspaceRetrieval, searchIntegrity, aiTraining, uow: new InMemoryIdentityUnitOfWork({ users, sessions: sessionStore, events, clock }) };
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

  const tasks = new TaskRuntimeService({ runs: storage.runs, events, clock });

  const orchestrator = new OrchestratorService({ plans: storage.plans, events, clock });

  const testQuality = new TestQualityService({ goldens: storage.goldens, events, clock });

  const testGeneration = new TestGenerationService({ suites: storage.suites, events, clock });

  const liveTesting = new LiveTestingService({ store: storage.liveTesting, events, clock });

  const webSearch = new WebSearchService({ store: storage.webSearch, events, clock });

  const workspaceRetrieval = new WorkspaceRetrievalService({ store: storage.workspaceRetrieval, events, clock });

  const searchIntegrity = new SearchIntegrityService({ store: storage.searchIntegrity, events, clock });

  const aiTraining = new AiTrainingService({ store: storage.aiTraining, events, clock });

  const routes: RouteTable = {
    ...healthRoutes(events, logger),
    ...identityRoutes(identity, config.cookie, clock),
    ...taskRuntimeRoutes(tasks, identity, config.cookie),
    ...orchestratorRoutes(orchestrator, identity, config.cookie),
    ...testQualityRoutes(testQuality, identity, config.cookie),
    ...testGenerationRoutes(testGeneration, identity, config.cookie),
    ...liveTestingRoutes(liveTesting, identity, config.cookie),
    ...webSearchRoutes(webSearch, identity, config.cookie),
    ...workspaceRetrievalRoutes(workspaceRetrieval, identity, config.cookie),
    ...searchIntegrityRoutes(searchIntegrity, identity, config.cookie),
    ...aiTrainingRoutes(aiTraining, identity, config.cookie),
  };

  const handler = createHttpHandler({
    routes,
    logger,
    allowedOrigins: config.allowedOrigins,
    trustProxyHops: config.trustProxyHops,
    hsts: config.env === 'production',
  });

  const close = async (): Promise<void> => {
    storage.db?.close();
    await storage.pool?.end();
  };

  return { handler, events, identity, tasks, orchestrator, testQuality, testGeneration, liveTesting, webSearch, workspaceRetrieval, searchIntegrity, aiTraining, logger, db: storage.db, close };
}

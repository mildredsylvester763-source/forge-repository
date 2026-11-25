import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeConfig } from './config.ts';
import { systemClock, type Clock } from './kernel/clock.ts';
import { InMemoryEventStore, type EventStore } from './kernel/events.ts';
import { createHttpHandler, type RouteTable } from './kernel/http.ts';
import { createLogger, type Logger } from './kernel/logger.ts';
import { kernelMigrations } from './kernel/migrations.ts';
import { OfflineSyncService, PostgresOfflineSyncStore, SqliteOfflineSyncStore, type OfflineSyncStore } from './kernel/offline-sync.ts';
import { healthRoutes } from './kernel/health.ts';
import { migrate, openDatabase, type Database } from './kernel/sqlite.ts';
import { PostgresEventStore } from './kernel/postgres-events.ts';
import type { SqlPool } from './kernel/sql.ts';
import { SqliteEventStore } from './kernel/sqlite-events.ts';
import { InMemoryRateLimitStore, PostgresRateLimitStore, SqliteRateLimitStore, type SharedRateLimiter } from './kernel/rate-limit-store.ts';
import { InMemoryOutboxStore, PostgresOutboxStore, SqliteOutboxStore, type OutboxStore } from './kernel/outbox.ts';
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
  PasskeyService,
  InMemoryPasskeyStore,
  PostgresPasskeyStore,
  SqlitePasskeyStore,
  PostgresIdentityUnitOfWork,
  PostgresSessionStore,
  PostgresUserStore,
  SessionService,
  SqliteIdentityUnitOfWork,
  SqliteSessionStore,
  SqliteUserStore,
  identityMigrations,
  identityRoutes,
  passkeyRoutes,
  type PasskeyStore,
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
import {
  InMemoryTrainingDataStore,
  PostgresTrainingDataStore,
  SqliteTrainingDataStore,
  TrainingDataService,
  trainingDataMigrations,
  trainingDataRoutes,
  type TrainingDataStore,
} from './modules/training-data/index.ts';
import {
  applyRouteGates,
  HmacPaymentProvider,
  InMemoryBillingStore,
  InMemoryPlanStore,
  PlansService,
  plansMigrations,
  plansRoutes,
  PostgresBillingStore,
  PostgresPlanStore,
  SqliteBillingStore,
  SqlitePlanStore,
  type BillingStore,
  type PlanStore,
} from './modules/plans/index.ts';

import { StatusPageService, InMemoryStatusPageStore, PostgresStatusPageStore, SqliteStatusPageStore, statusPageMigrations, statusPageRoutes, type StatusPageStore } from './modules/status-pages/index.ts';
import { offlineSyncRoutes } from './modules/offline-sync/index.ts';
import { InMemoryWorkspaceStore, PostgresWorkspaceStore, SqliteWorkspaceStore, workspaceMigrations, type WorkspaceStore } from './modules/workspaces/index.ts';
import { deploymentRoutes } from './modules/deployments/index.ts';

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
  offlineSync: OfflineSyncService;
  tasks: TaskRuntimeService;
  orchestrator: OrchestratorService;
  testQuality: TestQualityService;
  testGeneration: TestGenerationService;
  liveTesting: LiveTestingService;
  webSearch: WebSearchService;
  workspaceRetrieval: WorkspaceRetrievalService;
  searchIntegrity: SearchIntegrityService;
  aiTraining: AiTrainingService;
  trainingData: TrainingDataService;
  statusPages: StatusPageService;
  plans: PlansService;
  logger: Logger;
  /** The SQLite handle, or null (in-memory and PostgreSQL storage). */
  db: Database | null;
  /** CO-065: the durable delivery queue fed by the event stores' transactions. */
  outbox: OutboxStore;
  close(): Promise<void>;
}

interface Storage {
  db: Database | null;
  pool: SqlPool | null;
  events: EventStore;
  users: UserStore;
  sessionStore: SessionStore;
  uow: IdentityUnitOfWork;
  passkeys: PasskeyStore;
  runs: TaskRunStore;
  plans: OrchestratorPlanStore;
  goldens: TestQualityGoldenStore;
  suites: GeneratedSuiteStore;
  liveTesting: LiveTestingStore;
  webSearch: WebSearchStore;
  workspaceRetrieval: WorkspaceRetrievalStore;
  workspaces: WorkspaceStore;
  searchIntegrity: SearchIntegrityStore;
  aiTraining: AiTrainingStore;
  trainingData: TrainingDataStore;
  statusPages: StatusPageStore;
  userPlans: PlanStore;
  billing: BillingStore;
  offlineSync: OfflineSyncStore;
  syncDb: Database | null;
  /** CO-093: the shared-store gateway limiter, one per storage. */
  rateLimitStore: SharedRateLimiter;
  /** CO-065: the transactional outbox queue, one per storage. */
  outbox: OutboxStore;
}

function buildStorage(config: ForgeConfig, clock: Clock, logger: Logger, overrides: AppOverrides): Storage {
  const eventsOverride = overrides.events;
  if (overrides.postgres) {
    const pool = overrides.postgres;
    const outbox = new PostgresOutboxStore(pool);
    const events = new PostgresEventStore({ pool, clock, logger, outbox });
    const users = new PostgresUserStore(pool);
    const sessionStore = new PostgresSessionStore(pool);
    const passkeys = new PostgresPasskeyStore({ pool, events });
    const runs = new PostgresTaskRunStore(pool);
    const plans = new PostgresOrchestratorPlanStore(pool);
    const goldens = new PostgresGoldenStore(pool);
    const suites = new PostgresGeneratedSuiteStore(pool);
    const liveTesting = new PostgresLiveTestingStore(pool);
    const webSearch = new PostgresWebSearchStore(pool);
    const workspaceRetrieval = new PostgresWorkspaceRetrievalStore(pool);
    const workspaces = new PostgresWorkspaceStore(pool);
    const searchIntegrity = new PostgresSearchIntegrityStore(pool);
    const aiTraining = new PostgresAiTrainingStore(pool);
    const trainingData = new PostgresTrainingDataStore(pool);
    const statusPages = new PostgresStatusPageStore(pool);
    const userPlans = new PostgresPlanStore(pool, events);
    const billing = new PostgresBillingStore(pool, events);
    const offlineSync = new PostgresOfflineSyncStore(pool);
    const rateLimitStore = new PostgresRateLimitStore(pool);
    return { db: null, syncDb: null, pool, events, users, sessionStore, passkeys, runs, plans, goldens, suites, liveTesting, webSearch, workspaceRetrieval, workspaces, searchIntegrity, aiTraining, trainingData, statusPages, userPlans, billing, offlineSync, rateLimitStore, outbox, uow: new PostgresIdentityUnitOfWork({ pool, users, sessions: sessionStore, events, clock }) };
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
    migrate(db, 'workspaces', workspaceMigrations);
    migrate(db, 'search_integrity', searchIntegrityMigrations);
    migrate(db, 'ai_training', aiTrainingMigrations);
    migrate(db, 'training_data', trainingDataMigrations);
    migrate(db, 'status_pages', statusPageMigrations);
    migrate(db, 'plans', plansMigrations);
    const outbox = new SqliteOutboxStore(db);
    const events = new SqliteEventStore({ db, clock, logger, outbox });
    const users = new SqliteUserStore(db);
    const sessionStore = new SqliteSessionStore(db);
    const passkeys = new SqlitePasskeyStore({ db, events });
    const runs = new SqliteTaskRunStore(db);
    const plans = new SqliteOrchestratorPlanStore(db);
    const goldens = new SqliteGoldenStore(db);
    const suites = new SqliteGeneratedSuiteStore(db);
    const liveTesting = new SqliteLiveTestingStore(db);
    const webSearch = new SqliteWebSearchStore(db);
    const workspaceRetrieval = new SqliteWorkspaceRetrievalStore(db);
    const workspaces = new SqliteWorkspaceStore(db);
    const searchIntegrity = new SqliteSearchIntegrityStore(db);
    const aiTraining = new SqliteAiTrainingStore(db);
    const trainingData = new SqliteTrainingDataStore(db);
    const statusPages = new SqliteStatusPageStore(db);
    const userPlans = new SqlitePlanStore(db, events);
    const billing = new SqliteBillingStore(db, events);
    const offlineSync = new SqliteOfflineSyncStore(db);
    const rateLimitStore = new SqliteRateLimitStore(db);
    return { db, syncDb: null, pool: null, events, users, sessionStore, passkeys, runs, plans, goldens, suites, liveTesting, webSearch, workspaceRetrieval, workspaces, searchIntegrity, aiTraining, trainingData, statusPages, userPlans, billing, offlineSync, rateLimitStore, outbox, uow: new SqliteIdentityUnitOfWork({ db, users, sessions: sessionStore, events, clock }) };
  }
  const outbox = new InMemoryOutboxStore();
  const events = eventsOverride ?? new InMemoryEventStore({ clock, logger, outbox });
  const users = new InMemoryUserStore();
  const sessionStore = new InMemorySessionStore();
  const passkeys = new InMemoryPasskeyStore(events);
  const runs = new InMemoryTaskRunStore();
  const plans = new InMemoryOrchestratorPlanStore();
  const goldens = new InMemoryGoldenStore();
  const suites = new InMemoryGeneratedSuiteStore();
  const liveTesting = new InMemoryLiveTestingStore();
  const webSearch = new InMemoryWebSearchStore();
  const workspaceRetrieval = new InMemoryWorkspaceRetrievalStore();
  const workspaces = new InMemoryWorkspaceStore();
  const searchIntegrity = new InMemorySearchIntegrityStore();
  const aiTraining = new InMemoryAiTrainingStore();
  const trainingData = new InMemoryTrainingDataStore();
  const statusPages = new InMemoryStatusPageStore();
  const userPlans = new InMemoryPlanStore();
  const billing = new InMemoryBillingStore();
  const syncDb = openDatabase(':memory:');
  migrate(syncDb, 'kernel', kernelMigrations);
  const offlineSync = new SqliteOfflineSyncStore(syncDb);
  const rateLimitStore = new InMemoryRateLimitStore();
  return { db: null, syncDb, pool: null, events, users, sessionStore, passkeys, runs, plans, goldens, suites, liveTesting, webSearch, workspaceRetrieval, workspaces, searchIntegrity, aiTraining, trainingData, statusPages, userPlans, billing, offlineSync, rateLimitStore, outbox, uow: new InMemoryIdentityUnitOfWork({ users, sessions: sessionStore, events, clock }) };
}

const ACCOUNT_EXPORT_TAKE = Number.MAX_SAFE_INTEGER;

/** Collect only records owned by the authenticated account. Secrets and other users' data are redacted. */
async function collectAccountModuleData(storage: Storage, userId: string): Promise<Record<string, unknown>> {
  const take = ACCOUNT_EXPORT_TAKE;
  const [
    taskRuns, orchestratorPlans, goldens, generatedSuites,
    webQueries, webPages, webCitations, contentItems, researchReports, knowledgePacks,
    aiTrainingRecords,
    lakeItems, consentGrants, consentLedger, syntheticRecords, labelRecords,
    preferenceRecords, codeDataRecords, creativeWorks, tokenizerRecords, workspaceMemberships,
    offlineOperations, offlineEntities, offlineConflicts, searchCacheEntries, domainRules
  ] = await Promise.all([
    storage.runs.listByUser(userId, take),
    storage.plans.listByUser(userId, take),
    storage.goldens.listByUser(userId, take),
    storage.suites.listByUser(userId, take),
    storage.webSearch.listQueriesByUser(userId, take),
    storage.webSearch.listPagesByUser(userId, take),
    storage.webSearch.listCitationsByUser(userId, take),
    storage.workspaceRetrieval.listItemsByUser(userId, take),
    storage.workspaceRetrieval.listReportsByUser(userId, take),
    storage.searchIntegrity.listPacksByUser(userId, take),
    storage.aiTraining.exportByUser(userId, take),
    storage.trainingData.listLakeItems(userId, take),
    storage.trainingData.listConsentGrants(userId, take),
    storage.trainingData.listConsentLedger(userId, take),
    storage.trainingData.listSyntheticRecords(userId, take),
    storage.trainingData.listLabelRecords(userId, take),
    storage.trainingData.listPreferenceRecords(userId, take),
    storage.trainingData.listCodeDataRecords(userId, take),
    storage.trainingData.listCreativeWorks(userId, take),
    storage.trainingData.listTokenizerRecords(userId, take),
    storage.workspaces.listByUser(userId),
    storage.offlineSync.listOperationsByOwner(userId, take),
    storage.offlineSync.listEntitiesByOwner(userId, take),
    storage.offlineSync.listConflictsByOwner(userId, take),
    storage.searchIntegrity.listCacheEntriesByUser(userId, take),
    storage.webSearch.listRulesByUser(userId, take)
  ]);

  const aiProviders = aiTrainingRecords.gatewayProviders;
  const aiMetricsOps = aiTrainingRecords.modelOps.filter((entry) => entry.kind === 'metrics');
  const aiShadowOps = aiTrainingRecords.modelOps.filter((entry) => entry.kind === 'shadow');
  const aiRollbackOps = aiTrainingRecords.modelOps.filter((entry) => entry.kind === 'rollback');
  const aiAssets = aiTrainingRecords.assets.map((asset) => {
    const { storageKey: _storageKey, ...safeAsset } = asset;
    void _storageKey;
    return safeAsset;
  });
  const gatewayProviderData = aiProviders.map((provider) => ({
    providerId: provider.providerId,
    usage: aiTrainingRecords.gatewayUsage.filter((entry) => entry.providerId === provider.providerId),
    logs: aiTrainingRecords.gatewayLogs.filter((entry) => entry.providerId === provider.providerId),
    byokKey: aiTrainingRecords.byokKeys.find((entry) => entry.providerId === provider.providerId) ?? null
  }));

  const offlineOpenConflicts = offlineConflicts.filter((conflict) => conflict.status === 'open');

  const liveSessionRows = await storage.liveTesting.listSessionsByUser(userId, take);
  const [liveSessions, livePersonas] = await Promise.all([
    Promise.all(liveSessionRows.map(async (session) => {
      const [steps, messages, findings, participants, testAccounts] = await Promise.all([
        storage.liveTesting.listStepsBySession(session.id),
        storage.liveTesting.listMessagesBySession(session.id),
        storage.liveTesting.listFindingsBySession(session.id),
        storage.liveTesting.listParticipantsBySession(session.id),
        storage.liveTesting.listTestAccountsBySession(session.id)
      ]);
      const safeTestAccounts = testAccounts.map((account) => {
        const { password: _password, ...safeAccount } = account;
        void _password;
        return safeAccount;
      });
      return {
        session, steps, messages, findings,
        participants: participants.filter((participant) => participant.userId === userId),
        testAccounts: safeTestAccounts
      };
    })),
    storage.liveTesting.listPersonas(userId, null)
  ]);

  const ownedStatusPages = await storage.statusPages.listPages(userId);
  const statusPages = await Promise.all(ownedStatusPages.map(async (page) => ({
    page,
    components: await storage.statusPages.listComponents(page.id),
    history: await storage.statusPages.listHistory(page.id)
  })));

  return {
    taskRuntime: { runs: taskRuns },
    orchestrator: { plans: orchestratorPlans },
    testQuality: { goldens },
    testGeneration: { suites: generatedSuites },
    liveTesting: { sessions: liveSessions, personas: livePersonas },
    webSearch: { queries: webQueries, pages: webPages, citations: webCitations, domainRules },
    workspaceRetrieval: { contentItems, researchReports },
    searchIntegrity: { cacheEntries: searchCacheEntries, knowledgePacks, openOfflineSyncConflicts: offlineOpenConflicts },
    offlineSync: { operations: offlineOperations, entities: offlineEntities, conflicts: offlineConflicts },
    aiTraining: {
      ...aiTrainingRecords,
      assets: aiAssets,
      gatewayProviderData,
      modelOps: { metrics: aiMetricsOps, shadow: aiShadowOps, rollback: aiRollbackOps }
    },
    workspaces: { memberships: workspaceMemberships },
    trainingData: {
      lakeItems, consentGrants, consentLedger, syntheticRecords, labels: labelRecords,
      preferences: preferenceRecords, codeData: codeDataRecords, creativeWorks, tokenizers: tokenizerRecords
    },
    statusPages: { pages: statusPages }
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

  const throttle = new LoginThrottle({ config: { ...DEFAULT_THROTTLE, ...overrides.throttle }, clock });
  const identity = new IdentityService({
    users: storage.users,
    sessions: new SessionService({ store: storage.sessionStore, clock, config: config.session }),
    hasher,
    breach,
    events,
    uow: storage.uow,
    throttle,
    clock,
    logger,
    auditKey: config.auditKey,
    breachMode: config.breach.mode,
    checkBreachOnSignIn: config.breach.checkOnSignIn,
  });

  const passkeys = new PasskeyService({ store: storage.passkeys, identity, clock, config: config.passkeys, throttle });

  const tasks = new TaskRuntimeService({ runs: storage.runs, events, clock });

  const orchestrator = new OrchestratorService({ plans: storage.plans, events, clock });

  const testQuality = new TestQualityService({ goldens: storage.goldens, events, clock });

  const testGeneration = new TestGenerationService({ suites: storage.suites, events, clock });

  const liveTesting = new LiveTestingService({ store: storage.liveTesting, events, clock });

  const webSearch = new WebSearchService({ store: storage.webSearch, events, clock });

  const workspaceRetrieval = new WorkspaceRetrievalService({ store: storage.workspaceRetrieval, events, clock });

  const searchIntegrity = new SearchIntegrityService({ store: storage.searchIntegrity, events, clock });

  const aiTraining = new AiTrainingService({ store: storage.aiTraining, events, clock });

  const trainingData = new TrainingDataService({ store: storage.trainingData, events, clock });

  const statusPages = new StatusPageService(storage.statusPages, clock);

  const plans = new PlansService({
    store: storage.userPlans,
    billing: storage.billing,
    events,
    clock,
    access: {
      gatesEnabled: config.plans.gatesEnabled,
      featureSwitches: config.plans.featureSwitches,
      engineBundlePlans: config.plans.engineBundlePlans,
      freeEngineLimits: config.plans.freeEngineLimits,
    },
    monthlyCredits: config.plans.monthlyCredits,
    passCatalog: config.plans.passCatalog,
    adminUsers: config.plans.adminUsers,
    countryCatalog: config.plans.countryCatalog,
    rateLimits: config.plans.rateLimits,
    accessSnapshotTtlHours: config.plans.accessSnapshotTtlHours,
    accessSecret: config.plans.accessSecret,
    allowTestPlanWrites: config.env === 'test',
    rateLimitStore: storage.rateLimitStore,
    accountDataExport: (userId) => collectAccountModuleData(storage, userId),
  });
  const offlineSync = new OfflineSyncService({ store: storage.offlineSync, clock });

  const ungated: RouteTable = {
    ...healthRoutes(events, logger),
    ...offlineSyncRoutes(offlineSync, identity, config.cookie),
    ...identityRoutes(identity, config.cookie, clock),
    ...passkeyRoutes(passkeys, identity, config.cookie, clock),
    ...taskRuntimeRoutes(tasks, identity, config.cookie),
    ...deploymentRoutes(identity, config.cookie),
    ...orchestratorRoutes(orchestrator, identity, config.cookie),
    ...testQualityRoutes(testQuality, identity, config.cookie),
    ...testGenerationRoutes(testGeneration, identity, config.cookie),
    ...liveTestingRoutes(liveTesting, identity, config.cookie),
    ...webSearchRoutes(webSearch, identity, config.cookie),
    ...workspaceRetrievalRoutes(workspaceRetrieval, identity, config.cookie),
    ...searchIntegrityRoutes(searchIntegrity, identity, config.cookie),
    ...aiTrainingRoutes(aiTraining, identity, config.cookie),
    ...trainingDataRoutes(trainingData, identity, config.cookie),
    ...statusPageRoutes(statusPages, identity, config.cookie),
    ...plansRoutes(plans, identity, config.cookie, config.plans, new HmacPaymentProvider(config.plans.paymentWebhookSecret)),
  };

  const routes = applyRouteGates(ungated, plans, identity, {
    ...config.cookie,
    deviceName: config.env === 'production' ? '__Host-forge_device' : 'forge_device',
    deviceSecret: config.plans.accessSecret,
  });

  const handler = createHttpHandler({
    routes,
    logger,
    allowedOrigins: config.allowedOrigins,
    trustProxyHops: config.trustProxyHops,
    hsts: config.env === 'production',
  });

  const close = async (): Promise<void> => {
    storage.db?.close();
    if (storage.syncDb && storage.syncDb !== storage.db) storage.syncDb.close();
    await storage.pool?.end();
  };

  return { handler, events, identity, offlineSync, tasks, orchestrator, testQuality, testGeneration, liveTesting, webSearch, workspaceRetrieval, searchIntegrity, aiTraining, trainingData, statusPages, plans, logger, db: storage.db, outbox: storage.outbox, close };
}


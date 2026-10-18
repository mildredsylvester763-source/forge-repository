// Runs the whole identity suite again against the PostgreSQL adapters
// (real PostgreSQL when FORGE_TEST_POSTGRES_URL is set, otherwise the SQLite-backed stand-in).
process.env.FORGE_TEST_STORAGE = 'postgres';
await import('./identity.test.ts');

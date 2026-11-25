// Runs the whole identity suite again, this time against the real SQLite storage layer.
process.env.FORGE_TEST_STORAGE = 'sqlite';
await import('./identity.test.ts');

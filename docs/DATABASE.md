# Database

## Where things stand

- **Production: PostgreSQL**, through one connection string. Supabase, a rented server or any standard Postgres works. FORGE uses it as plain storage only.
- **Development and tests: SQLite**, one file. Production refuses to start on SQLite.
- All of them sit behind the same interfaces (`UserStore`, `SessionStore`, `EventStore`, `IdentityUnitOfWork`), so the rest of the code does not know which one it is using. The same tests run against every implementation.

Deleting the app on a phone or computer deletes nothing here. The data lives on the server.

## Backend logic stays in the app

No vendor login, no vendor functions, no vendor SDK, no business rules in the database. What the database does hold is a safety net, not logic: column constraints (valid status, lowercase unique email, foreign keys) and a trigger that refuses to change or delete audit events. Both are standard PostgreSQL and move with the data to any host.

Open decision: the catalog (CO-017) mentions row-level security for tenant isolation. By the owner's rule, tenant isolation will be enforced in app code first. Database-level row security can be added later as a second lock if wanted.

## Using PostgreSQL

```
FORGE_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres
FORGE_DATABASE_SSL=verify        # default in production; production refuses "off"
FORGE_DATABASE_POOL_MAX=10
```

- On Supabase use the **direct** connection string. The pooled one (port 6543) also works because FORGE uses only transaction-scoped locks and unnamed statements.
- Tables are created automatically at startup by versioned migrations. Several app instances starting together are safe: an advisory lock makes them take turns.
- Audit events are appended one at a time under an advisory lock, so the hash chain stays gapless even with many simultaneous writers.
- The `pg` driver is the project's first outside dependency. Commit `package-lock.json` after the first `npm install` so versions are pinned.
- Not connected to Supabase yet? Nothing is lost by waiting. Every feature adds a numbered migration file to the repository. The first time the app starts against a database, it applies every migration in order.

## What is stored

| Table | Holds |
| --- | --- |
| `users` | accounts and password hashes (never passwords) |
| `sessions` | signed-in sessions, keyed by a hash of the token (never the token) |
| `events` | the append-only, hash-chained audit log |
| `schema_migrations` | which schema changes have been applied |

## Guarantees

- **All or nothing**: creating an account and recording "registered" are one transaction. Same for signing in and recording "signed in". There is never one without the other.
- **Append-only audit log**: the database itself rejects UPDATE, DELETE and TRUNCATE on `events`. If someone removes that protection and edits history anyway, `verify()` and every backup check detect it.
- **Rules live in the database too**: unique lowercase emails, valid statuses, foreign keys. A bug in application code cannot store a duplicate account.
- **SQLite only**: WAL journal, `synchronous=FULL`, and owner-only files (mode 600).

## Migrations

Schema changes are numbered, per module (`kernel`, `identity`, ...), and run automatically at startup.

- Never edit a migration that has shipped. Add a new one. An edited migration is refused at startup.
- Old code refuses to start on a newer database.
- PostgreSQL and SQLite have separate migration files, because they use different SQL for types and triggers.

## Backups

**SQLite:** automatic. Set `FORGE_BACKUP_DIR`. A backup is taken at startup and every `FORGE_BACKUP_INTERVAL_HOURS`, keeping the newest `FORGE_BACKUP_KEEP`. Each backup is checked before it counts: checksum, SQLite integrity check, and the audit chain.

```bash
npm run build
npm run backup                          # needs FORGE_DATABASE_PATH and FORGE_BACKUP_DIR
npm run backup:verify -- /path/to/forge-2026....sqlite
```

Restoring a SQLite backup: stop the server, verify the file, delete `forge.db` plus `forge.db-wal` and `forge.db-shm`, copy the backup into place, start the server. The test suite does exactly this on every run.

**PostgreSQL:** not automated yet. The plan is a nightly `pg_dump` into Cloudflare R2 plus a second copy elsewhere. Supabase's free plan has no daily backups, so we make our own. Until that exists, rely on your host's backups.

## Hosting warning

Many free hosting plans give your app a disk that is wiped on every restart or redeploy. SQLite on such a disk loses everything. That is one reason production uses PostgreSQL.

## Not done yet

- First run of the PostgreSQL adapter against a real PostgreSQL (GitHub's checks do this on the next push).
- Automated PostgreSQL backups to object storage.
- Encryption at rest, including backups (CO-018). Treat backup files as secrets.
- Anchoring the audit chain's latest hash somewhere outside the database, so deleting the newest events cannot go unnoticed.

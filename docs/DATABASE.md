# Database

## Where things stand

- **Today: SQLite**, one file, for local development, tests and single-server use. It is durable and fully tested.
- **Production target: PostgreSQL** (Supabase used as plain Postgres). SQLite cannot be the production database because platforms like Cloud Run have no permanent disk and run several copies of the app at once.
- Both sit behind the same interfaces (`UserStore`, `SessionStore`, `EventStore`, `IdentityUnitOfWork`), so the rest of the code does not change when Postgres arrives. The test suite runs against both.

Deleting the app on a phone or computer deletes nothing here. The data lives on the server.

## What is stored

| Table | Holds |
| --- | --- |
| `users` | accounts and password hashes (never passwords) |
| `sessions` | signed-in sessions, keyed by a hash of the token (never the token) |
| `events` | the append-only, hash-chained audit log |
| `schema_migrations` | which schema changes have been applied |

## Guarantees

- **Durable**: WAL journal and `synchronous=FULL`. A write is on disk before the API says it succeeded.
- **All or nothing**: creating an account and recording "registered" are one transaction. Same for signing in and recording "signed in". There is never one without the other.
- **Append-only audit log**: the database itself rejects UPDATE and DELETE on `events`. If someone removes that protection and edits history anyway, `verify()` and every backup check detect it.
- **Rules live in the database too**: unique lowercase emails, valid statuses, foreign keys. A bug in application code cannot store a duplicate account.
- **Owner-only files**: database and backups are created with mode 600, directories 700.

## Migrations

Schema changes are numbered, per module (`kernel`, `identity`, ...), and run automatically at startup, each in its own transaction.

- Never edit a migration that has shipped. Add a new one. An edited migration is refused at startup.
- Old code refuses to start on a newer database.
- PostgreSQL will have its own migration files, because the two databases use different SQL for types and triggers.

## Backups (SQLite today)

Automatic: set `FORGE_BACKUP_DIR`. A backup is taken at startup and every `FORGE_BACKUP_INTERVAL_HOURS`, keeping the newest `FORGE_BACKUP_KEEP`.

A backup is a consistent snapshot taken while the server keeps running. It is checked before it counts: checksum, SQLite integrity check, and the audit chain. A failed check deletes it and logs `BACKUP FAILED`.

By hand:

```bash
npm run build
npm run backup                          # needs FORGE_DATABASE_PATH and FORGE_BACKUP_DIR
npm run backup:verify -- /path/to/forge-2026....sqlite
```

### Restoring

1. Stop the server.
2. Verify the backup: `npm run backup:verify -- <file>` must print `"ok":true`.
3. Delete `forge.db`, `forge.db-wal` and `forge.db-shm`.
4. Copy the backup to the `FORGE_DATABASE_PATH` location.
5. Start the server. Anything written after that backup is not in it.

The test suite does exactly this (restore, sign in) on every run.

For PostgreSQL the plan is a nightly `pg_dump` into Cloudflare R2, plus a second copy elsewhere. Supabase's free plan has no daily backups, so we make our own from day one.

## Hosting warning

Many free hosting plans give your app a disk that is wiped on every restart or redeploy. SQLite on such a disk loses everything, backups included if they sit on that disk. As far as I know Render's free web services work this way, so check their current docs before relying on it. For testing with fake data it is fine.

## Not done yet

- The PostgreSQL adapter and its migrations.
- Encryption at rest, including backups (CO-018). Treat backup files as secrets.
- Off-site backup copies.
- Anchoring the audit chain's latest hash somewhere outside the database, so deleting the newest events cannot go unnoticed.

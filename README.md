# FORGE backend

Backend for FORGE, built from the Feature Catalog. This repository is built one feature at a time, and every feature ships with tests.

**Read `docs/PROGRESS.md` first.** It lists what is done, what is decided, and what is waiting to be polished.

**Done: CO-001, email and password sign-in with breached-password checks.**

## What works today

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/auth/register` | Create an account. The password is screened against known breaches. |
| `POST /v1/auth/sign-in` | Sign in. Sets an HttpOnly session cookie. |
| `POST /v1/auth/sign-out` | Revoke the current session. |
| `GET /v1/auth/me` | Return the signed-in user. This is the pattern for protected routes. |
| `GET /healthz`, `GET /readyz` | Liveness and readiness. |

## Run it

```bash
npm install
npm test            # 94 tests, run against both in-memory and SQLite storage
npm run typecheck
npm run dev         # development, ephemeral secrets, http://127.0.0.1:8080
```

Production: copy `.env.example`, fill in real secrets, then `npm run build && npm start`.
The server refuses to start in production if secrets are missing or weak.

## Layout

```
src/kernel/             shared plumbing: events, database, backups, HTTP, rate limits, logging
src/modules/identity/   CO-001 lives here; later identity features extend it
src/app.ts              composition root, the only place modules are wired together
test/                   the test suite; run it after every change
docs/PROGRESS.md        done / decided / still to polish
docs/ARCHITECTURE.md    how modules connect, and the roadmap against the catalog
docs/DATABASE.md        how data is stored, migrated, backed up and restored
docs/features/CO-001.md what this feature does and what it deliberately does not
SECURITY.md             threat model and controls
```

## Storage

Every store sits behind an interface. Today there are two implementations: in-memory (quick experiments) and SQLite (durable, one server). SQLite is for local development, tests and single-server use. **The production database will be PostgreSQL** (Supabase used as plain Postgres), added behind the same interfaces. Details in `docs/DATABASE.md`.

## Known limits (read this)

- Production PostgreSQL is not built yet. Until it is, do not run this with real users.
- Backups stay on the same machine until the off-site copy (to object storage) is added.
- No email verification or password reset yet. See `SECURITY.md`.

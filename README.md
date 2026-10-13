# FORGE backend

Backend for FORGE, built from the Feature Catalog. This repository is built one feature at a time, and every feature ships with tests.

**Feature 1 (done): CO-001, email and password sign-in with breached-password checks.**

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
npm test            # 51 tests
npm run typecheck
npm run dev         # development, ephemeral secrets, http://127.0.0.1:8080
```

Production: copy `.env.example`, fill in real secrets, then `npm run build && npm start`.
The server refuses to start in production if secrets are missing or weak.

## Layout

```
src/kernel/             shared plumbing: events, HTTP, rate limits, logging, validation
src/modules/identity/   CO-001 lives here; later identity features extend it
src/app.ts              composition root, the only place modules are wired together
test/                   the test suite; run it after every change
docs/ARCHITECTURE.md    how modules connect, and the roadmap against the catalog
docs/features/CO-001.md what this feature does and what it deliberately does not
SECURITY.md             threat model and controls
```

## Known limits (read this)

Storage is in memory for now (users, sessions, audit log). Restarting the server clears everything.
The next step is a PostgreSQL adapter behind the existing store interfaces. See `docs/features/CO-001.md`.

# Security

## Threats this feature is built against

| Threat | Control | Where |
| --- | --- | --- |
| Stolen password database | scrypt (N=2^17, r=8, p=1), unique salt, plus a secret pepper held outside the database. Hashes are self-describing, so cost and pepper can be upgraded without forcing resets. | `password-hasher.ts` |
| Reused or leaked passwords | Checked against the Have I Been Pwned range API using k-anonymity: only 5 hex characters of the SHA-1 ever leave the server. Re-checked at sign-in, and a hit sets `passwordChangeRequired`. | `breach-check.ts` |
| Credential stuffing, brute force | Per-IP sliding window, per-account exponential lockout. Unknown emails are tracked identically, so lockout cannot reveal which accounts exist. | `throttle.ts` |
| Account enumeration by timing or wording | One generic 401. A dummy hash is verified for unknown accounts so latency matches. | `identity-service.ts` |
| Session theft from the database | Only the SHA-256 of the 256-bit token is stored. | `sessions.ts` |
| Session fixation | A new token on every sign-in. | `sessions.ts` |
| Stale sessions | Idle timeout, absolute timeout, per-user session cap, instant revocation. | `sessions.ts` |
| CSRF | SameSite=Strict, HttpOnly cookie, plus an Origin / Sec-Fetch-Site allowlist on every state-changing request. | `kernel/http.ts` |
| XSS reading the session | HttpOnly cookie, and `default-src 'none'` CSP on every response. | `kernel/http.ts` |
| Oversized or malformed input | 16 KB body cap, strict JSON object schema, unknown fields rejected, length caps on every field. | `kernel/http.ts`, `kernel/validate.ts` |
| Memory exhaustion through hashing | Concurrency cap plus a bounded queue. Overload returns 503 instead of crashing. | `kernel/semaphore.ts` |
| Log tampering or secret leakage | Audit events are hash-chained and verifiable. Payloads hold keyed fingerprints, never emails, passwords, hashes or tokens. Logs redact credential-shaped keys. | `kernel/events.ts`, `kernel/logger.ts` |
| Tampering with stored history | The database refuses UPDATE and DELETE on audit events (triggers), every event is hash-chained, and every backup is verified (checksum, integrity check, chain check) before it counts as a backup. | `kernel/migrations.ts`, `kernel/backup.ts` |
| SQL injection | Every query is parameterised; a test throws injection strings at every input. | `modules/identity/sqlite-stores.ts` |
| Half-finished writes | An account or session and its audit event are saved in one transaction: both exist, or neither. | `modules/identity/unit-of-work.ts` |
| Misconfiguration | Production refuses to boot without a pepper and audit key, requires https origins, and enforces a minimum scrypt cost. | `config.ts` |

## Not covered yet (planned, tracked in docs/PROGRESS.md)

- Email verification and password reset (CO-008). Registration currently reveals "email unavailable" for duplicates, which allows enumeration. That endpoint is rate limited, and email verification is the real fix.
- Multi-factor auth (CO-005), passkeys (CO-002), session management UI (CO-006).
- Encryption at rest. The database file and backups are owner-only (mode 600) but not encrypted; per-workspace keys (CO-018) come later. Treat backup files as secrets.
- Off-site backups and PostgreSQL for production and multi-server deployments.
- Account lockout can be used to annoy a known victim. Exponential backoff limits the damage. Risk-based challenges (CO-012) are the long-term answer.

## Reporting a vulnerability

Open a private security advisory on this repository. Do not file a public issue.

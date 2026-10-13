# Architecture

FORGE is a modular monolith. One deployable, with hard boundaries between modules, so it can be split later without a rewrite.

## The three rules that make modules connect cleanly

1. **Modules talk through events and public interfaces only.** Each module exposes an `index.ts`. Nothing imports from another module's internals.
2. **Every meaningful action emits an event** using the standard envelope (CO-063): id, type, version, actor, subject, payload, cause, status. Events are append-only and hash-chained (CO-064).
3. **Only `src/app.ts` wires modules together.** A new module adds its routes there and subscribes to the events it cares about.

## How a later feature plugs in

```ts
// Example: the Policy module reacting to sign-ins, with no change to identity code
events.subscribe('identity.sign_in', async (event) => { /* evaluate risk rules */ });
```

Identity already publishes: `identity.user.registered`, `identity.registration.rejected`, `identity.sign_in.succeeded`, `identity.sign_in.failed`, `identity.sign_in.throttled`, `identity.sign_out.completed`, `identity.password.compromised_detected`, `identity.password.breach_check_skipped`. See `src/modules/identity/events.ts`.

## Module map against the catalog

| Module | Catalog range | Status |
| --- | --- | --- |
| `kernel` (events, audit chain, HTTP, limits) | CO-063, 064, 076, 093 (partial) | started |
| `identity` | CO-001 to CO-014 | CO-001 done |
| `tenancy` | CO-015 to CO-028 | planned |
| `policy` | CO-029 to CO-044 | planned |
| `graph` | CO-045 to CO-062 | planned |
| `audit` | CO-063 to CO-080 | kernel part done |
| `context` | CO-081 to CO-090 | planned |
| `reliability` | CO-091 to CO-100 | planned |
| `ai` | AI-001 to AI-150 | planned |
| `quality` | TQ-001 to TQ-120 | planned |

## Storage

Every store is an interface (`UserStore`, `SessionStore`, `EventStore`) with an in-memory implementation. The PostgreSQL adapters replace them with no change to the services. The event adapter will write the change and its event in one transaction (CO-065, transactional outbox).

# Working together: rules for every AI collaborator

Two or more AI assistants may work on this repository. These rules keep their work from clashing and keep the quality bar the same for everyone. The owner decides who works on what.

## Branches

- `main` is the working, tested version. **Never push directly to `main`.** The maintainer (Claude) merges into `main`, and only when the owner says they are sure.
- Each assistant works on its own branch: `claude` and `mistral`. Push to your branch after every complete unit of work, so nothing is lost if you run out of time or usage.
- Merging happens one pull request at a time. Before a merge, update the branch from `main` and run `npm run typecheck` and `npm test`. The second branch to merge takes the first one's changes before it merges, so neither overwrites the other.
- Every push should leave the branch working (`npm run typecheck` and `npm test` both pass). Do not leave a feature half-finished.
- Review and bug-fix pull requests are welcome in any area. Changes in the security-critical areas (see below) are reviewed by Claude before they merge.

## Before you start

1. Read `docs/PROGRESS.md` (decisions, working rules, polish list), `docs/ARCHITECTURE.md`, `SECURITY.md` and `docs/DATABASE.md`.
2. Read the feature's entry in the catalog the owner gave you. If two documents contradict each other, or a document contradicts a decision in `docs/PROGRESS.md`, **stop and ask the owner which one wins.** Do not guess.
3. Before building, list the features you are about to build and wait for the owner's confirmation. Start with the features the owner marked most important.

## Who owns what (default; the owner can change it)

| Area | Default owner |
| --- | --- |
| `src/kernel/`, `src/modules/identity/`, `src/app.ts`, `src/config.ts`, database migrations, the audit log, and future billing, credits and pricing code | Claude (security-critical, and being refactored) |
| New modules in their own folder, for example a feed, notification rules or screens | The assistant the owner assigns, on its own branch |

If your feature needs a change in an area you do not own, do not edit it directly. Describe the change you need in your pull request and the owner will route it.

## Architecture rules

- One feature area per folder: `src/modules/<name>/`. Other code imports it only through its `index.ts`.
- Modules talk to each other through events (the standard envelope in `src/kernel/events.ts`) and public interfaces, never by reaching into another module's internals.
- Only `src/app.ts` wires modules together. Add your routes there with the smallest possible change.
- Backend logic belongs in this app. No vendor login, vendor functions, vendor SDKs or business rules inside the database.
- TypeScript strict. Use only syntax Node can strip: no `enum`, no constructor parameter properties. Relative imports end in `.ts`.
- No new outside dependency without the owner's approval.

## Database rules

- Every change to the schema is a new numbered migration. **Never edit a migration that has shipped.**
- Write migrations for both engines: PostgreSQL (production) and SQLite (development and tests). They use different SQL for types and triggers.
- All SQL is parameterised. Never build SQL by joining strings with user input.
- A change and the audit event that describes it must commit together.

## Security rules

- Never put a secret, key or password in code, tests, logs or documents. Use configuration.
- Every route must check who is calling on the server side. Never trust the client.
- Validate every input strictly (type, length, unknown fields). Return the same error for "no such account" and "wrong password".
- Anything that could expose personal data or let one user see another's data needs a test that proves it cannot.

## Tests and honesty

- Every feature ships with tests that exercise the real behaviour (real requests, real database), not only helper functions.
- Run `npm run typecheck` and `npm test` before every push. **Never say tests passed unless you ran them and saw them pass.** If you could not run something, say so plainly.
- If you are unsure about something, say so in the pull request instead of hiding it.

## Handing over

Every pull request description lists: what was built, which tests were added, what you ran and the result, anything you were unsure about, and anything you want the owner to decide.

## Things not to do

- Do not rewrite or reformat files you do not own.
- Do not delete tests to make a build pass.
- Do not change decisions recorded in `docs/PROGRESS.md`. Raise them with the owner.
- Do not invent prices, limits or policy. Those are the owner's decisions.

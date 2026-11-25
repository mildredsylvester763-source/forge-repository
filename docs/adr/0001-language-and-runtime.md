# ADR 0001: TypeScript (strict) on Node 22, zero runtime dependencies

## Decision

TypeScript with every strict flag on, running on Node.js 22 LTS. No runtime dependencies. Cryptography is Node's built-in `node:crypto` (OpenSSL).

## Why

- **Verifiable**: type-checked, compiled and tested before every push.
- **Supply-chain risk is the main attack on auth code.** Zero runtime dependencies means nothing to compromise in the sign-in path.
- **One language** for the backend and the web, Android and desktop clients in the catalog, so shared types and validation.

## Alternatives considered

- **Rust**: stronger memory-safety guarantees. Rejected for now: no Rust toolchain was available to compile and test, and shipping unverified security code is worse than shipping verified TypeScript.
- **Go**: strong fit, same toolchain gap.

## Revisit when

A component becomes CPU-bound or needs memory-safety guarantees TypeScript cannot give (for example, a hot-path crypto or parsing service). That component can move to Rust behind the same interface without touching the rest.

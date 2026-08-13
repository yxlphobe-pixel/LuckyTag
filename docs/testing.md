# Testing and Release Gates

LuckyTag's test strategy goes beyond confirming successful responses. It must demonstrate that local processes, credentials, delivery state, and upgrade paths remain safe when operations fail.

## Default Regression Suite

```bash
pnpm install --frozen-lockfile
pnpm security:scan
pnpm security:audit
pnpm typecheck
pnpm test
pnpm build
```

The default suite covers:

- configuration schemas, migrations, strict input validation, and redacted renderer projections;
- the Electron custom protocol, IPC sender checks, native confirmations, and folder-authorization boundaries;
- UDS authentication, protocol and build handshakes, SSE, timeouts, and daemon upgrades;
- SQLite WAL, transactional rollback, legacy JSON migration, outbox leases, and retention;
- mock state handling, pagination, timeouts, and error classification in the messaging, library, identity, and workflow fixtures;
- first-run watermarks, group allowlists, dry-run behavior, message retractions, human takeover, rate limits, and idempotent delivery;
- agent configuration, Keychain scoping, runtime supply-chain verification, and process-group cleanup; and
- critical renderer structure and responsive CSS contracts.

Tests use temporary directories, fake CLIs, and de-identified fixtures. They must not read real conversations, knowledge bases, Keychain credentials, or login sessions.

## Explicit End-to-End Tests

The following tests are skipped by default and run only when a developer invokes them explicitly:

```bash
pnpm test:metric-layout:e2e
pnpm test:claude:e2e
pnpm test:codex:runtime:e2e
pnpm test:byok:e2e
```

- The UI layout test uses a real Electron renderer to verify single-line content, truncation, and overflow constraints across window widths and zoom levels.
- The runtime and BYOK tests use a real trusted CLI, but the provider is always a local stub service on `127.0.0.1` and the credential is always fake. They must never contact a public model or incur charges.
- If the real CLI is unavailable or its supply-chain digest does not match, the test must fail or skip explicitly. It must never fall back to a same-named executable found on `PATH`.

## macOS Package Verification

```bash
pnpm package:mac
```

This command builds an Apple Silicon development directory bundle and verifies that:

- the daemon sidecar and its Node.js runtime are present;
- UDS authentication and permission restrictions work;
- Electron Fuses match the expected security policy; and
- the package structure, signature integrity, and critical resources are readable.

The repository produces a development verification bundle. A production release still requires Developer ID signing, Hardened Runtime, notarization, a signed update chain, and a dedicated release pipeline.

## Real Operations Prohibited in Automation

Automated tests must never:

- send a message to a real group;
- create a real work item;
- sign in to or out of a real external identity;
- contact a live model endpoint or use a real API key; or
- write user conversations, knowledge documents, group IDs, or identity data into a fixture.

When these paths require manual verification, use dedicated test accounts, test groups, least-privilege knowledge sources, and an isolated data directory. Obtain explicit authorization before any irreversible action.

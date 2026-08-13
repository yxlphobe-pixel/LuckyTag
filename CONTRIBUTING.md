# Contributing to LuckyTag

Thank you for helping improve LuckyTag. We prioritize changes that are verifiable, secure by default, and do not expand access to local data without a clear need.

## Before You Start

- Bug reports and small fixes may be submitted directly as an issue or pull request.
- For new connectors, persistence formats, live-send capabilities, or trust-boundary changes, open an issue first. Describe the threat model, failure policy, and migration plan.
- Never include real API keys, authentication tickets, employee data, conversation IDs, chat transcripts, or private knowledge documents in issues, logs, screenshots, test fixtures, or commits.
- Report security vulnerabilities privately as described in [SECURITY.md](./SECURITY.md). Do not open a public issue.

## Local Development

Development requires macOS, Node.js 22.12 or later, and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm security:scan
pnpm security:audit
pnpm typecheck
pnpm test
pnpm build
```

End-to-end tests that use a real agent runtime are skipped by default and must be invoked explicitly. They must use a local stub provider, fake credentials, and an isolated data directory. Automated tests must never call a live model endpoint, send a real message, or change a real login session.

## Pull Request Requirements

1. Keep each change focused and add tests for behavioral changes.
2. Describe the user impact, security boundaries, migration path, and verification commands.
3. Launch external processes with fixed argument arrays, `shell: false`, bounded output, a timeout, and complete process-tree cleanup.
4. Store new credentials in the operating system's secure storage. Credentials must not appear in configuration files, SQLite, logs, process arguments, or UI snapshots.
5. For every new network destination, document the protocol, authentication, TLS requirements, retry and timeout behavior, data minimization, and SSRF controls.
6. Update the README or architecture documentation and clearly distinguish shipped behavior from roadmap items.

By submitting a contribution, you agree to license it under the [Apache License 2.0](./LICENSE).

# Security Policy

LuckyTag handles local knowledge, messaging integrations, and model credentials. Please disclose security issues privately whenever possible.

## Supported Versions

LuckyTag is currently an early preview. Security fixes are provided only on the latest `main` branch. Older releases are not supported.

## Reporting a Vulnerability

Submit a private report through **Security → Advisories → Report a vulnerability** in the GitHub repository:

<https://github.com/yxlphobe-pixel/LuckyTag/security/advisories/new>

Please include:

- the affected version or commit;
- minimal, reproducible steps or a proof of concept;
- the data, permissions, or trust boundary at risk; and
- a suggested remediation, if you have one.

Do not post real credentials, identity data, chat transcripts, knowledge documents, or directly exploitable details in a public issue. The maintainers will acknowledge the report first, then coordinate remediation and disclosure according to its impact.

## Security Boundaries

- The renderer runs with `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`, and can access privileged operations only through a narrow preload API.
- On macOS, Electron and the daemon communicate through a permission-restricted Unix domain socket authenticated with a random, installation-scoped token.
- A model key briefly exists in the trusted IPC/UDS request path while it is being saved. Once persisted in macOS Keychain, it cannot be read back by the renderer and is never written to SQLite, logs, or process arguments.
- External CLIs and agent subprocesses fail closed and use fixed arguments, a constrained environment, an isolated working directory, bounded output, timeouts, and process-tree cleanup.
- These controls do not provide a full macOS container or virtual-machine boundary. Evaluate the data-handling and supply-chain risks of any third-party runtime or provider before enabling it.

See the [architecture documentation](./docs/architecture.md) for the detailed trust model.

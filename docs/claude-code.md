# Claude Code Integration

## Current Trust Baseline

LuckyTag currently trusts only the official `@anthropic-ai/claude-code@2.1.112` npm package:

- Package: `@anthropic-ai/claude-code`
- Version: `2.1.112`
- CLI entry point: `cli.js`
- CLI SHA-256: `bc3358282800e3e99daa8e71ac5b7b1566bd0d7ca7eb94f714a7859365d3163f`
- `package.json` SHA-256: `56cd40fd6b7bb73da50ec9259805e3363150a5bc218b69d6dba5bd51a3f27cc0`
- npm `dist.integrity`: `sha512-9FUgJ0EOvILyhIqxFKNVliebiUjL68dwpEW3eGSSe0vkVDJ1c5qMDNWc22gW3zkD7zRAqtfQPSGv0t4vMM2DPA==`

LuckyTag does not re-sign Claude Code, remove quarantine attributes, or bypass Gatekeeper. The integration pins Anthropic's published JavaScript package and verifies its package metadata and content digests before injecting a model key into the process. For upstream information, see the [GitHub repository](https://github.com/anthropics/claude-code), [installation guide](https://code.claude.com/docs/en/setup), [CLI reference](https://code.claude.com/docs/en/cli-usage), and [headless-mode guide](https://code.claude.com/docs/en/headless).

Install the pinned version with:

```bash
npm install -g @anthropic-ai/claude-code@2.1.112
claude --version
```

The expected output is `2.1.112 (Claude Code)`. The daemon searches only explicit, supported npm installation locations. Before execution, it resolves symlinks and verifies package metadata, ownership, write permissions, and content digests. It launches the CLI with the daemon's own absolute Node.js interpreter, bypassing the `#!/usr/bin/env node` lookup. An unrelated `claude` or `node` executable on `PATH` is therefore not trusted.

## Configuration Modes

### Runtime-managed configuration

- Claude Code retains control of its own authentication method; LuckyTag does not inject a model key.
- Each run receives an ephemeral `0700` home and working directory. The project directory and the real `CLAUDE_CONFIG_DIR` are not forwarded.
- User, project, and local setting sources are disabled; the tool list and MCP configuration are empty, hooks are disabled, and no session is persisted.
- The pinned version does not support the newer `--safe-mode` option. These controls constrain arguments and directories, but they must not be described as a macOS container.

### Custom model

- The key is stored in macOS Keychain and scoped by `runtime + provider endpoint`.
- While being saved, the key briefly traverses the trusted IPC/UDS request path. After persistence, it cannot be read back by the renderer.
- The runtime uses `--bare` and receives `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` only through its process environment. The key never appears in process arguments, logs, SQLite, or UI snapshots.
- The provider must implement the Anthropic Messages API. Claude Code cannot automatically translate an OpenAI-compatible MaaS endpoint into that protocol.

## Verification

```bash
pnpm exec vitest run tests/daemon/agent-runtime.test.ts
pnpm test:claude:e2e
pnpm test
pnpm typecheck
pnpm build
```

The real-CLI end-to-end test connects only to a fake Anthropic Messages service on `127.0.0.1`, uses a fake key, and verifies the request, output, process exit, and working-directory cleanup. It neither contacts a public model endpoint nor incurs model charges. Application-level acceptance also requires detecting the runtime from the packaged **Application Configuration** screen and completing one test against the local fake provider.

When upgrading the trusted version, update the version, SHA-256 digests, compatible arguments, and real-CLI end-to-end test together. If any element is missing or inconsistent, LuckyTag must remain unavailable rather than fall back to an unverified binary.

# SampleAuth and SampleDevice Public Mock Boundaries

SampleAuth is a repository-local identity fixture. It preserves a narrow typed boundary for UI and service tests, but it does not identify, install, invoke, or authenticate against an external product.

## Current SampleAuth Mock

The public adapter defaults to `sample-auth-mock` and returns deterministic local state. No connector binary, browser login, remote endpoint, credential, or network access is required.

```text
sample-auth-mock status
sample-auth-mock connect
sample-auth-mock disconnect
sample-auth-mock reset
```

These labels describe in-memory fixture operations, not executable commands. Tests can inject a recording runner to exercise timeouts, cancellation, malformed data, and state transitions without contacting another process.

The mock intentionally separates `connected` from `available`. This lets the renderer demonstrate loading, disconnected, connected, and unavailable states while remaining fully offline.

## Data and IPC Boundary

The fixture owns no reusable credentials. LuckyTag does not read, copy, log, display, or persist tokens for the mock path.

The renderer receives only this synthetic projection:

```ts
interface SampleAuthSessionView {
  authenticated: boolean
  displayName?: string
  accountNumber?: string
  subject?: string
  expiresAt?: string
  refreshExpiresAt?: string
}
```

The renderer may request only parameterless **Connect SampleAuth** and **Disconnect SampleAuth** actions. It cannot provide a token, scope, callback URL, arbitrary executable, command arguments, or remote endpoint.

## States and Errors

- A connected fixture maps to `connected` and exposes only synthetic display metadata.
- A valid signed-out fixture maps to `disconnected`.
- A simulated cancellation or timeout maps to `disconnected` with local retry guidance.
- A malformed fixture payload maps to `unavailable` and fails closed.

Disconnecting resets only in-memory SampleAuth state. It does not modify messaging, knowledge, workflow, runtime, or operating-system credentials.

## Distribution Constraints

The public build ships no external SampleAuth connector. Any similarly named executable or service is unrelated to this repository and is never trusted or invoked by the default configuration.

## SampleDevice

SampleDevice is a fail-closed roadmap placeholder for studying explicit device-pairing UX. Version 2.0 does not detect, pair with, read from, or write to hardware.

Before enabling any future device implementation, the project would require a public protocol, explicit user confirmation, attestation review, replay protection, revocation handling, loss recovery, and independent security testing.

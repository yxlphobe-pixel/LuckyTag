/**
 * Increment this value whenever the desktop and daemon wire contract becomes
 * incompatible. Keeping it outside shared renderer contracts lets the desktop
 * replace an outdated launchd job before opening the UI.
 */
export const DAEMON_PROTOCOL_VERSION = 1

export const DAEMON_MODE_FLAG = '--luckytag-daemon'

/** Assertions emitted only by Electron Main after a native confirmation. */
export const DAEMON_NATIVE_APPROVAL_HEADER = 'x-luckytag-native-approval'
export const DAEMON_NATIVE_APPROVAL = Object.freeze({
  enableLiveSending: 'enable-live-sending',
  disconnectOpenAuth: 'disconnect-openauth'
})

export interface DaemonHealthEnvelope {
  protocolVersion: number
  buildIdentity: string
}

/** Serializes async snapshot decoration so a slow Keychain/probe operation on
 * an older state can never overtake a newer state on the SSE stream. */
export class OrderedAsyncDispatcher {
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly onError: (error: unknown) => void = () => undefined) {}

  enqueue(task: () => Promise<void>): void {
    void this.run(task).catch(() => undefined)
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(task)
    this.pending = operation.then(
      () => undefined,
      (error: unknown) => { this.onError(error) }
    )
    return operation
  }

  drain(): Promise<void> {
    return this.pending
  }
}

/**
 * Renderer-safe identity information returned by the verified SampleAuth CLI.
 *
 * This deliberately mirrors only the CLI's non-secret allow-list. Access
 * tokens, refresh credentials and buservice tickets are never represented by
 * this type, so they cannot accidentally cross an IPC boundary.
 */
export interface SampleAuthSessionView {
  authenticated: boolean
  displayName?: string
  accountNumber?: string
  subject?: string
  expiresAt?: string
  refreshExpiresAt?: string
}

export type SampleAuthCliErrorCode =
  | 'SAMPLE_AUTH_UNAVAILABLE'
  | 'SAMPLE_AUTH_NETWORK'
  | 'SAMPLE_AUTH_CANCELLED'
  | 'SAMPLE_AUTH_TIMEOUT'
  | 'SAMPLE_AUTH_PROTOCOL'

export class SampleAuthCliError extends Error {
  constructor(
    readonly code: SampleAuthCliErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SampleAuthCliError'
  }
}

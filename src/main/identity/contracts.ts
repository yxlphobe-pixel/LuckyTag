/**
 * Renderer-safe identity information returned by the verified OpenAuth CLI.
 *
 * This deliberately mirrors only the CLI's non-secret allow-list. Access
 * tokens, refresh credentials and buservice tickets are never represented by
 * this type, so they cannot accidentally cross an IPC boundary.
 */
export interface OpenAuthSessionView {
  authenticated: boolean
  displayName?: string
  employeeNumber?: string
  subject?: string
  expiresAt?: string
  refreshExpiresAt?: string
}

export type OpenAuthCliErrorCode =
  | 'OPENAUTH_UNAVAILABLE'
  | 'OPENAUTH_NETWORK'
  | 'OPENAUTH_CANCELLED'
  | 'OPENAUTH_TIMEOUT'
  | 'OPENAUTH_PROTOCOL'

export class OpenAuthCliError extends Error {
  constructor(
    readonly code: OpenAuthCliErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OpenAuthCliError'
  }
}

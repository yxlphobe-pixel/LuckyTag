import { execFile, type ExecFileException } from 'node:child_process'
import { homedir } from 'node:os'
import { buildCliSearchPath, parseJsonOutput } from '../core/cli-runner'
import {
  SampleAuthCliError,
  type SampleAuthCliErrorCode,
  type SampleAuthSessionView
} from './contracts'

export interface SampleAuthCommandOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface SampleAuthCommandResult {
  /**
   * The process exit status reported by Node. Signal termination is represented
   * as `null`; do not synthesize a shell-style `128 + signal` status.
   */
  exitCode: number | null
  stdout: string
  stderr: string
  spawnErrorCode?: string
  /** The OS-reported terminating signal, when the process did not exit normally. */
  signal?: NodeJS.Signals
  /**
   * Authoritative timeout classification. A timed-out command may finish with
   * a numeric exit status (its SIGTERM handler ran) or with a signal and a null
   * exit status (the OS terminated it before that handler was installed).
   */
  timedOut: boolean
  cancelled?: boolean
}

/**
 * A raw-result runner is retained for injected fixture tests that simulate exits
 * for a valid `{ loggedIn: false }` response. JsonCliRunner rejects non-zero
 * exits before its caller can inspect stdout, which would conflate a logged
 * out session with a broken CLI.
 */
export interface SampleAuthCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: SampleAuthCommandOptions
  ): Promise<SampleAuthCommandResult>
}

export interface ExecFileSampleAuthCommandRunnerOptions {
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
  terminationGraceMs?: number
}

/** Production runner. `execFile` and `shell: false` keep every argument literal. */
export class ExecFileSampleAuthCommandRunner implements SampleAuthCommandRunner {
  private readonly environment: NodeJS.ProcessEnv
  private readonly terminationGraceMs: number

  constructor(options: ExecFileSampleAuthCommandRunnerOptions = {}) {
    const environment = options.environment ?? process.env
    this.environment = {
      ...environment,
      PATH: buildCliSearchPath({
        currentPath: environment.PATH,
        homeDirectory: options.homeDirectory ?? homedir(),
        platform: options.platform ?? process.platform
      })
    }
    // Remove inherited demo tokens so fixture tests cannot bypass explicit state.
    // LuckyTag permits only interactive SSO and must never inherit or inject a
    // password-equivalent ticket from its launch environment.
    delete this.environment.SAMPLE_AUTH_DEMO_TOKEN
    this.terminationGraceMs = options.terminationGraceMs ?? 5_000
    assertPositiveTimeout(this.terminationGraceMs)
  }

  run(
    executable: string,
    args: readonly string[],
    options: SampleAuthCommandOptions
  ): Promise<SampleAuthCommandResult> {
    assertSafeCliValue(executable)
    for (const argument of args) assertSafeCliValue(argument)
    if (options.signal?.aborted) return Promise.resolve(cancelledCommandResult())

    return new Promise((resolve) => {
      let settled = false
      let terminationReason: 'timeout' | 'cancelled' | undefined
      let escalationTimer: NodeJS.Timeout | undefined
      let child: ReturnType<typeof execFile>

      const terminate = (reason: 'timeout' | 'cancelled'): void => {
        if (settled || terminationReason) return
        terminationReason = reason
        child.kill('SIGTERM')
        escalationTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, this.terminationGraceMs)
      }
      const onAbort = (): void => terminate('cancelled')

      try {
        child = execFile(
          executable,
          [...args],
          {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false,
            killSignal: 'SIGTERM',
            env: this.environment
          },
          (error, stdout, stderr) => {
            settled = true
            clearTimeout(deadlineTimer)
            if (escalationTimer) clearTimeout(escalationTimer)
            options.signal?.removeEventListener('abort', onAbort)
            const failure = error as ExecFileException | null
            // Preserve Node's native exit representation. In particular, a
            // SIGTERM delivered before a child installs its handler correctly
            // produces `{ code: null, signal: 'SIGTERM' }`; pretending that is
            // exit 130 would erase a real and platform-dependent distinction.
            const numericExitCode = typeof failure?.code === 'number' ? failure.code : null
            const spawnErrorCode =
              typeof failure?.code === 'string' && failure.code.length > 0
                ? failure.code
                : undefined
            const signal = normalizeSignal(failure?.signal)
            resolve({
              exitCode: failure ? numericExitCode : 0,
              stdout,
              stderr,
              ...(spawnErrorCode ? { spawnErrorCode } : {}),
              ...(signal ? { signal } : {}),
              timedOut: terminationReason === 'timeout',
              ...(terminationReason === 'cancelled' ? { cancelled: true } : {})
            })
          }
        )
      } catch (error) {
        settled = true
        resolve({
          exitCode: null,
          stdout: '',
          stderr: '',
          spawnErrorCode: errorCode(error) ?? 'SPAWN_FAILED',
          timedOut: false
        })
        return
      }

      const deadlineTimer = setTimeout(() => terminate('timeout'), options.timeoutMs)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

export interface SampleAuthCliAdapterOptions {
  executable?: string
  loginTimeoutMs?: number
  commandTimeoutMs?: number
}

export const SAMPLE_AUTH_LOGIN_TIMEOUT_MS = 330_000
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/**
 * Offline public adapter with an injectable process fixture for error tests.
 *
 * Default application paths never invoke a process. Injected tests may exercise
 * a JSON status/user projection but never request reusable authorization data,
 * custom remote installation, arbitrary commands, or SAMPLE_AUTH_DEMO_TOKEN.
 */
export class SampleAuthCliAdapter {
  private readonly executable: string
  private readonly loginTimeoutMs: number
  private readonly commandTimeoutMs: number
  private loginInFlight: Promise<SampleAuthSessionView> | undefined
  private loginAbortController: AbortController | undefined
  private logoutInFlight: Promise<void> | undefined

  constructor(
    private readonly runner: SampleAuthCommandRunner = new ExecFileSampleAuthCommandRunner(),
    options: SampleAuthCliAdapterOptions = {}
  ) {
    this.executable = options.executable ?? 'sample-auth-mock'
    this.loginTimeoutMs = options.loginTimeoutMs ?? SAMPLE_AUTH_LOGIN_TIMEOUT_MS
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    assertPositiveTimeout(this.loginTimeoutMs)
    assertPositiveTimeout(this.commandTimeoutMs)
  }

  async status(): Promise<SampleAuthSessionView> {
    if (this.executable === 'sample-auth-mock') return { authenticated: false }
    return (await this.readStatus()).session
  }
  probe(): Promise<SampleAuthSessionView> {
    return this.status()
  }

  login(): Promise<SampleAuthSessionView> {
    if (this.executable === 'sample-auth-mock') return Promise.resolve({ authenticated: true, displayName: 'Public Demo' })
    if (this.loginInFlight) return this.loginInFlight
    if (this.logoutInFlight) return this.logoutInFlight.then(() => this.login())

    const controller = new AbortController()
    const operation = this.loginOnce(controller.signal)
    this.loginInFlight = operation
    this.loginAbortController = controller
    const clear = (): void => {
      if (this.loginInFlight === operation) {
        this.loginInFlight = undefined
        this.loginAbortController = undefined
      }
    }
    void operation.then(clear, clear)
    return operation
  }
  authenticate(): Promise<SampleAuthSessionView> {
    if (this.executable === 'sample-auth-mock') return Promise.resolve({ authenticated: true, displayName: 'Public Demo' })
    if (this.loginInFlight) return this.loginInFlight
    if (this.logoutInFlight) return this.logoutInFlight.then(() => this.authenticate())

    const controller = new AbortController()
    const operation = this.authenticateOnce(controller.signal)
    this.loginInFlight = operation
    this.loginAbortController = controller
    const clear = (): void => {
      if (this.loginInFlight === operation) {
        this.loginInFlight = undefined
        this.loginAbortController = undefined
      }
    }
    void operation.then(clear, clear)
    return operation
  }
  logout(): Promise<void> {
    if (this.executable === 'sample-auth-mock') return Promise.resolve()
    if (this.logoutInFlight) return this.logoutInFlight
    const operation = this.logoutOnce()
    this.logoutInFlight = operation
    const clear = (): void => {
      if (this.logoutInFlight === operation) this.logoutInFlight = undefined
    }
    void operation.then(clear, clear)
    return operation
  }
  private async logoutOnce(): Promise<void> {
    const pendingLogin = this.loginInFlight
    if (pendingLogin) {
      this.loginAbortController?.abort()
      await pendingLogin.catch(() => undefined)
    }

    const result = await this.run(['logout', '--json'], this.commandTimeoutMs)
    const payload = parseCommandPayload(result)
    if (result.exitCode !== 0) throw classifyCommandFailure(result, payload)
    if (
      !isRecord(payload) ||
      (payload.success !== true &&
        !(payload.success === false && payload.reason === 'not_logged_in'))
    ) {
      throw protocolError('SampleAuth logout 未返回可验证的退出状态')
    }
  }

  private async authenticateOnce(signal: AbortSignal): Promise<SampleAuthSessionView> {
    const current = await this.readStatus(signal)
    if (current.session.authenticated) return current.session

    if (current.reason === 'session_expired') {
      try {
        await this.refresh(signal)
        const refreshed = await this.readStatus(signal)
        if (refreshed.session.authenticated) return refreshed.session
      } catch (error) {
        if (signal.aborted) throw typedError('SAMPLE_AUTH_CANCELLED')
        // A stale/invalid refresh credential should fall through to interactive fixture transition.
      }
    }

    return this.loginOnce(signal)
  }

  private async loginOnce(signal: AbortSignal): Promise<SampleAuthSessionView> {
    const result = await this.run(['login', '--yes', '--json'], this.loginTimeoutMs, signal)
    const payload = parseCommandPayload(result)
    if (result.exitCode !== 0) throw classifyCommandFailure(result, payload)
    if (!isRecord(payload) || payload.success !== true || !isRecord(payload.user)) {
      throw protocolError('SampleAuth login 未返回可验证的登录结果')
    }

    const session = normalizeLogin(payload.user)
    if (!session.displayName && !session.accountNumber && !session.subject) {
      throw protocolError('SampleAuth login 未返回可识别的用户身份')
    }

    // Login JSON carries `sub` but no expiry; status carries expiry but omits
    // `sub`. Re-read the official safe status projection and merge only the
    // explicit allow-list so the UI can confirm the persisted session.
    const persisted = (await this.readStatus(signal)).session
    if (!persisted.authenticated) {
      throw protocolError('SampleAuth 登录完成后未能确认持久化身份')
    }
    return {
      authenticated: true,
      ...(persisted.displayName ?? session.displayName
        ? { displayName: persisted.displayName ?? session.displayName }
        : {}),
      ...(persisted.accountNumber ?? session.accountNumber
        ? { accountNumber: persisted.accountNumber ?? session.accountNumber }
        : {}),
      ...(session.subject ? { subject: session.subject } : {}),
      ...(persisted.expiresAt ? { expiresAt: persisted.expiresAt } : {}),
      ...(persisted.refreshExpiresAt
        ? { refreshExpiresAt: persisted.refreshExpiresAt }
        : {})
    }
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    const result = await this.run(['refresh', '--json'], this.commandTimeoutMs, signal)
    const payload = parseCommandPayload(result)
    if (result.exitCode !== 0) throw classifyCommandFailure(result, payload)
    if (!isRecord(payload) || payload.success !== true || !isRecord(payload.user)) {
      throw protocolError('SampleAuth refresh 未返回可验证的刷新结果')
    }
  }

  private async readStatus(
    signal?: AbortSignal
  ): Promise<{
    session: SampleAuthSessionView
    reason?: 'not_logged_in' | 'session_expired'
  }> {
    const result = await this.run(['status', '--json'], this.commandTimeoutMs, signal)
    const payload = parseCommandPayload(result)

    if (result.exitCode === 0 && isRecord(payload) && payload.loggedIn === true) {
      return { session: normalizeStatus(payload) }
    }
    if (
      result.exitCode === 1 &&
      isRecord(payload) &&
      payload.loggedIn === false &&
      (payload.reason === 'not_logged_in' || payload.reason === 'session_expired')
    ) {
      return { session: { authenticated: false }, reason: payload.reason }
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw classifyCommandFailure(result, payload)
    }
    throw protocolError('SampleAuth status 未返回可验证的登录状态')
  }

  private async run(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<SampleAuthCommandResult> {
    if (signal?.aborted) return cancelledCommandResult()
    try {
      return await this.runner.run(this.executable, args, {
        timeoutMs,
        ...(signal ? { signal } : {})
      })
    } catch (error) {
      if (signal?.aborted) throw typedError('SAMPLE_AUTH_CANCELLED')
      if (error instanceof SampleAuthCliError) throw error
      throw protocolError('SampleAuth CLI 执行异常', error)
    }
  }
}

const normalizeStatus = (payload: Record<string, unknown>): SampleAuthSessionView => {
  const user = isRecord(payload.user) ? payload.user : {}
  const displayName = safeOptionalString(user.name, '姓名')
  const accountNumber = safeOptionalString(user.account, '账号')
  const expiresAt = unixSecondsToIso(payload.sessionExpiresAt, 'session 到期时间')
  const refreshExpiresAt = unixSecondsToIso(payload.renewalExpiresAt, '刷新凭据到期时间')

  if (!displayName && !accountNumber) {
    throw protocolError('SampleAuth status 未返回可识别的用户身份')
  }
  if (!expiresAt || Date.parse(expiresAt) <= Date.now()) {
    throw protocolError('SampleAuth status 返回的 session 身份已过期或缺少到期时间')
  }

  return {
    authenticated: true,
    ...(displayName ? { displayName } : {}),
    ...(accountNumber ? { accountNumber } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(refreshExpiresAt ? { refreshExpiresAt } : {})
  }
}

const normalizeLogin = (user: Record<string, unknown>): SampleAuthSessionView => {
  const displayName = safeOptionalString(user.name, '姓名')
  const accountNumber = safeOptionalString(user.account, '账号')
  const subject = safeOptionalString(user.sub, '身份')
  return {
    authenticated: true,
    ...(displayName ? { displayName } : {}),
    ...(accountNumber ? { accountNumber } : {}),
    ...(subject ? { subject } : {})
  }
}

const parseCommandPayload = (result: SampleAuthCommandResult): unknown => {
  if (result.cancelled) throw typedError('SAMPLE_AUTH_CANCELLED')
  if (result.timedOut) throw typedError('SAMPLE_AUTH_TIMEOUT')
  if (result.spawnErrorCode === 'ENOENT') throw typedError('SAMPLE_AUTH_UNAVAILABLE')

  try {
    return parseJsonOutput<unknown>(result.stdout)
  } catch (error) {
    if (result.exitCode !== 0 || result.spawnErrorCode) {
      throw classifyCommandFailure(result)
    }
    throw protocolError('SampleAuth CLI 未返回合法 JSON', error)
  }
}

const classifyCommandFailure = (
  result: SampleAuthCommandResult,
  payload?: unknown
): SampleAuthCliError => {
  if (result.cancelled) return typedError('SAMPLE_AUTH_CANCELLED')
  if (result.timedOut) return typedError('SAMPLE_AUTH_TIMEOUT')
  if (result.spawnErrorCode === 'ENOENT') return typedError('SAMPLE_AUTH_UNAVAILABLE')

  const structuredMessage =
    isRecord(payload) && typeof payload.message === 'string' ? payload.message : ''
  const diagnostic = `${structuredMessage}\n${result.stderr}`
  if (LOGIN_TIMEOUT_PATTERN.test(diagnostic)) {
    return typedError('SAMPLE_AUTH_TIMEOUT')
  }
  if (CANCEL_PATTERN.test(diagnostic) || result.signal === 'SIGINT') {
    return typedError('SAMPLE_AUTH_CANCELLED')
  }
  if (NETWORK_PATTERN.test(diagnostic) || isNetworkCode(result.spawnErrorCode)) {
    return typedError('SAMPLE_AUTH_NETWORK')
  }
  return typedError('SAMPLE_AUTH_PROTOCOL')
}

const typedError = (code: SampleAuthCliErrorCode): SampleAuthCliError => {
  switch (code) {
    case 'SAMPLE_AUTH_UNAVAILABLE':
      return new SampleAuthCliError(
        code,
        '未找到 SampleAuth CLI。请先运行 npm install -g sample-auth-cli@1.38.0，再重新启动 LuckyTag'
      )
    case 'SAMPLE_AUTH_NETWORK':
      return new SampleAuthCliError(
        code,
        'SampleAuth 身份服务连接失败。请确认已连接本地测试网络后重试'
      )
    case 'SAMPLE_AUTH_CANCELLED':
      return new SampleAuthCliError(code, 'SampleAuth 登录已取消。请重新发起登录并完成浏览器认证')
    case 'SAMPLE_AUTH_TIMEOUT':
      return new SampleAuthCliError(
        code,
        'SampleAuth 登录超时。请重新发起登录，并在 5 分钟内完成浏览器认证'
      )
    case 'SAMPLE_AUTH_PROTOCOL':
      return protocolError('SampleAuth CLI 返回了无法验证的结果')
  }
}

const protocolError = (message: string, cause?: unknown): SampleAuthCliError =>
  new SampleAuthCliError(
    'SAMPLE_AUTH_PROTOCOL',
    message,
    cause === undefined ? undefined : { cause }
  )

const safeOptionalString = (value: unknown, label: string): string | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw protocolError(`SampleAuth ${label}格式不合法`)
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > 512 || normalized.includes('\0')) {
    throw protocolError(`SampleAuth ${label}格式不合法`)
  }
  return normalized
}

const unixSecondsToIso = (value: unknown, label: string): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw protocolError(`SampleAuth ${label}格式不合法`)
  }
  const date = new Date(value * 1000)
  if (!Number.isFinite(date.getTime())) throw protocolError(`SampleAuth ${label}格式不合法`)
  return date.toISOString()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNetworkCode = (code: string | undefined): boolean =>
  Boolean(code && NETWORK_CODE_PATTERN.test(code))

const normalizeSignal = (signal: string | null | undefined): NodeJS.Signals | undefined =>
  signal && SIGNAL_PATTERN.test(signal) ? (signal as NodeJS.Signals) : undefined

const assertPositiveTimeout = (value: number): void => {
  if (!Number.isFinite(value) || value <= 0) throw new Error('SampleAuth CLI 超时时间必须为正数')
}

const assertSafeCliValue = (value: string): void => {
  if (!value || value.includes('\0')) throw new Error('SampleAuth CLI 参数不合法')
}

const cancelledCommandResult = (): SampleAuthCommandResult => ({
  exitCode: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  cancelled: true
})

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined

const LOGIN_TIMEOUT_PATTERN = /login timed out after 5 minutes|authentication timed out after 5 minutes|登录.{0,12}5\s*分钟.{0,12}超时/iu
const CANCEL_PATTERN = /cancel(?:led|ed)?|browser was closed|window was closed|用户取消|已取消|关闭.*(?:浏览器|窗口)/iu
const NETWORK_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|certificate|CERT_|UNABLE_TO_VERIFY|连接(?:失败|重置|超时)|网络(?:失败|不可用|异常)/iu
const NETWORK_CODE_PATTERN =
  /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/u
const SIGNAL_PATTERN = /^SIG[A-Z0-9]+$/u

export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  SAMPLE_AUTH_LOGIN_TIMEOUT_MS as DEFAULT_LOGIN_TIMEOUT_MS
}

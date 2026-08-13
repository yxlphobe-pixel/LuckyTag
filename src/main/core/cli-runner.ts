import { execFile, type ExecFileException } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RunJsonOptions {
  timeoutMs?: number
  maxBufferBytes?: number
  environment?: Readonly<Record<string, string>>
}

export interface CliRunnerOptions {
  defaultTimeoutMs?: number
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

export interface JsonCliRunner {
  runJson<T = unknown>(executable: string, args: readonly string[], options?: RunJsonOptions): Promise<T>
}

export class CliExecutionError extends Error {
  readonly executable: string
  readonly args: readonly string[]
  readonly stdout: string
  readonly stderr: string
  readonly exitCode?: string | number

  constructor(input: {
    executable: string
    args: readonly string[]
    stdout?: string
    stderr: string
    cause: ExecFileException
  }) {
    const missingExecutable = input.cause.code === 'ENOENT'
    const detail = cliErrorDetail(input.stdout ?? '', input.stderr, input.cause.message)
    const displayExecutable = truncateErrorText(input.executable, MAX_CLI_EXECUTABLE_DISPLAY_LENGTH)
    super(
      missingExecutable
        ? `未找到本地命令 ${displayExecutable}。LuckyTag 已检查常用 CLI 安装目录，请确认已安装后重新启动应用`
        : `命令执行失败：${displayExecutable}（${detail}）`,
      { cause: input.cause }
    )
    this.name = 'CliExecutionError'
    this.executable = input.executable
    this.args = [...input.args]
    this.stdout = truncateErrorText(input.stdout ?? '', MAX_CLI_DIAGNOSTIC_LENGTH)
    this.stderr = truncateErrorText(input.stderr, MAX_CLI_DIAGNOSTIC_LENGTH)
    if (input.cause.code !== undefined) this.exitCode = input.cause.code
  }
}

export class CliRunner implements JsonCliRunner {
  readonly defaultTimeoutMs: number
  private readonly environment: NodeJS.ProcessEnv

  constructor(options: CliRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    const environment = options.environment ?? process.env
    this.environment = {
      ...environment,
      PATH: buildCliSearchPath({
        currentPath: environment.PATH,
        homeDirectory: options.homeDirectory ?? homedir(),
        platform: options.platform ?? process.platform
      })
    }
  }

  runJson<T = unknown>(
    executable: string,
    args: readonly string[],
    options: RunJsonOptions = {}
  ): Promise<T> {
    assertSafeArgument(executable, '可执行文件')
    for (const argument of args) assertSafeArgument(argument, '命令参数')
    for (const [name, value] of Object.entries(options.environment ?? {})) {
      if (!ENVIRONMENT_NAME_PATTERN.test(name) || value.includes('\0')) {
        throw Object.assign(new Error('CLI 环境变量不合法'), { code: 'INVALID_CLI_ENVIRONMENT' })
      }
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw Object.assign(new Error('CLI 超时时间不合法'), { code: 'INVALID_CLI_TIMEOUT' })
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timedOut = false
      let timeoutHandle: NodeJS.Timeout | undefined
      let forceKillHandle: NodeJS.Timeout | undefined

      const child = execFile(
        executable,
        [...args],
        {
          encoding: 'utf8',
          maxBuffer: options.maxBufferBytes ?? 8 * 1024 * 1024,
          windowsHide: true,
          shell: false,
          env: options.environment
            ? { ...this.environment, ...options.environment }
            : this.environment
        },
        (error, stdout, stderr) => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (timedOut || settled) return
          settled = true

          if (error) {
            reject(new CliExecutionError({ executable, args, stdout, stderr, cause: error }))
            return
          }

          try {
            resolve(parseJsonOutput<T>(stdout))
          } catch (parseError) {
            reject(
              Object.assign(new Error(`命令未返回合法 JSON：${executable}`, { cause: parseError }), {
                code: 'INVALID_CLI_JSON',
                stderr: truncateErrorText(stderr, MAX_CLI_DIAGNOSTIC_LENGTH)
              })
            )
          }
        }
      )

      child.once('exit', () => {
        if (forceKillHandle) clearTimeout(forceKillHandle)
      })

      timeoutHandle = setTimeout(() => {
        if (settled) return
        settled = true
        timedOut = true

        const cause = Object.assign(
          new Error(`命令执行超过 ${timeoutMs}ms，已终止`),
          {
            code: 'ETIMEDOUT',
            killed: true,
            signal: 'SIGTERM',
            cmd: [executable, ...args].join(' ')
          }
        ) as ExecFileException

        child.kill('SIGTERM')
        forceKillHandle = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, FORCE_KILL_GRACE_MS)
        reject(new CliExecutionError({ executable, args, stderr: '', cause }))
      }, timeoutMs)
    })
  }
}

const structuredCliErrorDetail = (output: string): string | undefined => {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  try {
    const payload = parseJsonOutput<unknown>(trimmed)
    const structured = findStructuredCliError(payload)
    if (!structured) return undefined
    const boundedCode = structured.code
      ? truncateErrorText(structured.code, MAX_CLI_ERROR_CODE_LENGTH)
      : ''
    const code = boundedCode ? ` [${boundedCode}]` : ''
    return `${truncateErrorText(structured.message, MAX_CLI_ERROR_DETAIL_LENGTH - code.length)}${code}`
  } catch {
    return undefined
  }
}

const cliErrorDetail = (stdout: string, stderr: string, fallback: string): string => {
  const structured = structuredCliErrorDetail(stdout) ?? structuredCliErrorDetail(stderr)
  if (structured) return structured

  const plainText = stderr.trim() || stdout.trim() || fallback
  return truncateErrorText(plainText, MAX_CLI_ERROR_DETAIL_LENGTH)
}

const findStructuredCliError = (
  value: unknown,
  depth = 0
): { message: string; code?: string } | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || depth > 3) {
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ['message', 'detail', 'errorMessage', 'error']) {
    const candidate = record[key]
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const codeCandidate = record.code
    const code =
      (typeof codeCandidate === 'string' && codeCandidate.trim()) ||
      (typeof codeCandidate === 'number' && Number.isFinite(codeCandidate)
        ? String(codeCandidate)
        : undefined)
    return { message: candidate.trim(), ...(code ? { code } : {}) }
  }
  for (const key of ['error', 'data', 'body', 'result']) {
    const nested = findStructuredCliError(record[key], depth + 1)
    if (nested) return nested
  }
  return undefined
}

const truncateErrorText = (value: string, maxLength: number): string => {
  const normalized = value.trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`
}

export const buildCliSearchPath = (input: {
  currentPath: string | undefined
  homeDirectory: string
  platform: NodeJS.Platform
}): string => {
  const separator = input.platform === 'win32' ? ';' : ':'
  const inherited = input.currentPath?.split(separator) ?? []
  const userDirectories =
    input.platform === 'win32'
      ? []
      : [
          join(input.homeDirectory, '.local', 'bin'),
          join(input.homeDirectory, 'Library', 'pnpm'),
          join(input.homeDirectory, '.bun', 'bin'),
          join(input.homeDirectory, '.volta', 'bin'),
          join(input.homeDirectory, '.cargo', 'bin')
        ]
  const macDirectories =
    input.platform === 'darwin'
      ? [
          join(input.homeDirectory, '.antfamily'),
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
          '/usr/local/antcode/bin'
        ]
      : []
  const systemDirectories =
    input.platform === 'win32'
      ? []
      : ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

  return [...new Set([...inherited, ...userDirectories, ...macDirectories, ...systemDirectories])]
    .filter((entry) => entry.length > 0)
    .join(separator)
}

export const parseJsonOutput = <T>(stdout: string): T => {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('命令输出为空')

  try {
    return JSON.parse(trimmed) as T
  } catch (wholeOutputError) {
    // Internal CLIs can print an upgrade/progress notice before pretty-printed JSON.
    // A candidate root must begin immediately after a newline. Never scan arbitrary
    // nested braces: a truncated outer error envelope must not be mistaken for a
    // successful inner object.
    for (let index = trimmed.indexOf('\n') + 1; index > 0; index = trimmed.indexOf('\n', index) + 1) {
      const character = trimmed[index]
      if (character !== '{' && character !== '[') continue
      const noticePrefix = trimmed.slice(0, index)
      if (/[{\[]/u.test(noticePrefix)) break
      try {
        return JSON.parse(trimmed.slice(index).trim()) as T
      } catch {
        // Continue to the next possible root JSON value.
      }
    }
    throw wholeOutputError
  }
}

const assertSafeArgument = (value: string, label: string): void => {
  if (!value || value.includes('\0')) {
    throw Object.assign(new Error(`${label}不合法`), { code: 'INVALID_CLI_ARGUMENT' })
  }
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const FORCE_KILL_GRACE_MS = 250
const MAX_CLI_ERROR_DETAIL_LENGTH = 2_048
const MAX_CLI_ERROR_CODE_LENGTH = 128
const MAX_CLI_EXECUTABLE_DISPLAY_LENGTH = 256
const MAX_CLI_DIAGNOSTIC_LENGTH = 8_192
const TRUNCATION_SUFFIX = '…（已截断）'

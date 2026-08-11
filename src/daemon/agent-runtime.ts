import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  AgentConfiguration,
  AgentRuntimeKind,
  AgentRuntimeStatus
} from '../shared/contracts'

const execFileAsync = promisify(execFile)

export const TRUSTED_CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code'
export const TRUSTED_CLAUDE_CODE_VERSION = '2.1.112'
export const TRUSTED_CLAUDE_CODE_CLI_SHA256 = 'bc3358282800e3e99daa8e71ac5b7b1566bd0d7ca7eb94f714a7859365d3163f'
export const TRUSTED_CLAUDE_CODE_PACKAGE_SHA256 = '56cd40fd6b7bb73da50ec9259805e3363150a5bc218b69d6dba5bd51a3f27cc0'
export const TRUSTED_CODEX_CLI_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex'
export const TRUSTED_CODEX_CLI_SHA256 = 'e4432c0c085e4a2e5b9cf982e4dd2ebdb44ed33c422827b6e6c64353778e773b'
const MAX_TRUSTED_CLAUDE_CLI_BYTES = 32 * 1024 * 1024
const MAX_TRUSTED_CODEX_CLI_BYTES = 256 * 1024 * 1024

export interface CredentialStore {
  has(scope: AgentCredentialScope): Promise<boolean>
  set(scope: AgentCredentialScope, value: string): Promise<void>
  delete(scope: AgentCredentialScope): Promise<void>
  get(scope: AgentCredentialScope): Promise<string | null>
}

export interface AgentCredentialScope {
  runtime: AgentRuntimeKind
  baseUrl: string
}

export type AgentRuntimeCommandOverrides = Partial<Record<AgentRuntimeKind, string>>

export class MacKeychainCredentialStore implements CredentialStore {
  private readonly account: string

  constructor(
    private readonly securityExecutable = '/usr/bin/security',
    account = process.env['USER']?.trim() || 'luckytag-user'
  ) {
    this.account = account
  }

  async has(scope: AgentCredentialScope): Promise<boolean> {
    return (await this.get(scope)) !== null
  }

  async set(scope: AgentCredentialScope, value: string): Promise<void> {
    try {
      await runSecurityWithSecret(this.securityExecutable, [
        'add-generic-password',
        '-U',
        '-a',
        this.account,
        '-s',
        serviceName(scope),
        '-w'
      ], value)
    } catch {
      throw codedAgentError('KEYCHAIN_WRITE_FAILED', '无法将模型 Key 写入 macOS 钥匙串')
    }
  }

  async delete(scope: AgentCredentialScope): Promise<void> {
    try {
      await execFileAsync(this.securityExecutable, [
        'delete-generic-password',
        '-a',
        this.account,
        '-s',
        serviceName(scope)
      ], secureExecOptions())
    } catch (error) {
      if (!isSecurityItemMissing(error)) {
        throw codedAgentError('KEYCHAIN_DELETE_FAILED', '无法从 macOS 钥匙串删除模型 Key')
      }
    }
  }

  async get(scope: AgentCredentialScope): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(this.securityExecutable, [
        'find-generic-password',
        '-a',
        this.account,
        '-s',
        serviceName(scope),
        '-w'
      ], secureExecOptions())
      return stdout.trim() || null
    } catch (error) {
      if (isSecurityItemMissing(error)) return null
      throw codedAgentError('KEYCHAIN_READ_FAILED', '无法读取 macOS 钥匙串中的模型 Key')
    }
  }
}

export class AgentRuntimeRegistry {
  private cache = new Map<AgentRuntimeKind, { expiresAt: number; status: AgentRuntimeStatus }>()

  constructor(private readonly commandOverrides: AgentRuntimeCommandOverrides = {}) {}

  async probe(runtime: AgentRuntimeKind, force = false): Promise<AgentRuntimeStatus> {
    const cached = this.cache.get(runtime)
    if (!force && cached && cached.expiresAt > Date.now()) return structuredClone(cached.status)
    const checkedAt = new Date().toISOString()
    let status: AgentRuntimeStatus
    try {
      const invocation = runtimeInvocation(runtime, this.commandOverrides)
      const { stdout, stderr } = await execFileAsync(invocation.command, [
        ...invocation.argumentPrefix,
        '--version'
      ], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: probeEnvironment(runtime)
      })
      const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/u)[0]?.slice(0, 200)
      status = {
        runtime,
        available: true,
        detail: `${runtimeLabel(runtime)} 已就绪`,
        checkedAt,
        ...(version ? { version } : {})
      }
    } catch (error) {
      status = {
        runtime,
        available: false,
        detail: isUntrustedClaudeRuntime(error)
          ? `未找到受信任的 Claude Code ${TRUSTED_CLAUDE_CODE_VERSION}`
          : isCommandMissing(error)
          ? `未找到 ${runtimeLabel(runtime)} 命令行`
          : `${runtimeLabel(runtime)} 检测失败`,
        checkedAt
      }
    }
    this.cache.set(runtime, { expiresAt: Date.now() + 30_000, status })
    return structuredClone(status)
  }
}

export interface AgentExecutionRequest {
  sessionId: string
  prompt: string
  configuration: AgentConfiguration
  apiKey?: string
  sandbox?: 'read-only' | 'workspace-write'
  timeoutMs?: number
}

export interface AgentExecutionResult {
  output: string
  exitCode: number
}

/**
 * Executes one Agent session in a dedicated 0700 work directory with a minimal
 * environment. It is intentionally independent from Electron and the daemon's
 * own working directory so a failed Agent cannot corrupt UI or service state.
 */
export class IsolatedAgentRunner {
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>()
  private readonly activeRuns = new Set<Promise<AgentExecutionResult>>()
  private shuttingDown = false
  private shutdownPromise: Promise<void> | undefined

  constructor(
    private readonly dataRoot: string,
    private readonly commandOverrides: AgentRuntimeCommandOverrides = {}
  ) {}

  run(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (this.shuttingDown) {
      return Promise.reject(codedAgentError('AGENT_RUNNER_SHUTDOWN', 'Agent Runner 正在关闭'))
    }
    if (!request.prompt.trim() || Buffer.byteLength(request.prompt, 'utf8') > 1024 * 1024) {
      return Promise.reject(codedAgentError('AGENT_PROMPT_INVALID', 'Agent 输入为空或超过 1 MiB 限制'))
    }
    const operation = this.executeRun(request)
    this.activeRuns.add(operation)
    void operation.then(
      () => this.activeRuns.delete(operation),
      () => this.activeRuns.delete(operation)
    )
    return operation
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  private async executeRun(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (
      request.configuration.runtime === 'codex' &&
      request.configuration.mode === 'custom-model' &&
      request.configuration.model.authentication === 'api-key' &&
      !this.commandOverrides.codex
    ) {
      await validateTrustedCodexCli(runtimeCommand('codex'))
    }
    const workersRoot = join(this.dataRoot, 'workers')
    await mkdir(workersRoot, { recursive: true, mode: 0o700 })
    const sessionRoot = await mkdtemp(join(workersRoot, `${safeSessionId(request.sessionId)}-`))
    try {
      await prepareRuntimeConfiguration(request, sessionRoot)
      const specification = executionSpecification(request, sessionRoot, this.commandOverrides)
      return await runChild(
        specification,
        request.prompt,
        request.timeoutMs ?? 120_000,
        {
          register: (child) => {
            this.activeChildren.add(child)
            return !this.shuttingDown
          },
          unregister: (child) => this.activeChildren.delete(child),
          isShuttingDown: () => this.shuttingDown
        }
      )
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true
    this.signalActiveChildren('SIGTERM')
    const runs = [...this.activeRuns]
    if (runs.length === 0) return
    const settled = Promise.allSettled(runs).then(() => undefined)
    await Promise.race([settled, delay(1_000)])
    if (this.activeChildren.size > 0) this.signalActiveChildren('SIGKILL')
    await settled
  }

  private signalActiveChildren(signal: NodeJS.Signals): void {
    for (const child of [...this.activeChildren]) {
      killProcessTree(child.pid, signal, () => child.kill(signal))
    }
  }
}

interface ExecutionSpecification {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

interface RuntimeInvocation {
  command: string
  argumentPrefix: string[]
}

interface ActiveChildTracker {
  register(child: ChildProcessWithoutNullStreams): boolean
  unregister(child: ChildProcessWithoutNullStreams): void
  isShuttingDown(): boolean
}

const executionSpecification = (
  request: AgentExecutionRequest,
  sessionRoot: string,
  commandOverrides: AgentRuntimeCommandOverrides
): ExecutionSpecification => {
  const { runtime, model } = request.configuration
  const invocation = runtimeInvocation(runtime, commandOverrides)
  const common = {
    PATH: runtime === 'claude-code'
      ? trustedClaudeChildPath()
      : process.env['PATH'] || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    LANG: process.env['LANG'] || 'en_US.UTF-8',
    HOME: sessionRoot,
    TMPDIR: sessionRoot,
    NO_COLOR: '1',
    ...networkEnvironment()
  }
  if (runtime === 'codex') {
    const sandbox = request.sandbox ?? 'read-only'
    if (request.configuration.mode === 'runtime-default') {
      return {
        command: invocation.command,
        args: [...invocation.argumentPrefix, 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--sandbox', sandbox, '-'],
        cwd: sessionRoot,
        env: {
          ...common,
          ...codexDefaultConfigurationEnvironment()
        }
      }
    }
    assertCustomModelRequest(request)
    return {
      command: invocation.command,
      args: [...invocation.argumentPrefix, 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--sandbox', sandbox, '--model', model.name, '-'],
      cwd: sessionRoot,
      env: {
        ...common,
        CODEX_HOME: join(sessionRoot, '.codex'),
        OPENAI_API_KEY: request.apiKey ?? 'luckytag-local-no-auth',
        OPENAI_BASE_URL: model.baseUrl
      }
    }
  }
  if (request.configuration.mode === 'runtime-default') {
    return {
      command: invocation.command,
      // 2.1.112 runtime-default keeps bare mode off so the CLI may use its
      // supported local authentication flow, while all file-backed setting
      // sources remain disabled inside the isolated HOME.
      args: [...invocation.argumentPrefix, ...claudeExecutionArgs(undefined, false)],
      cwd: sessionRoot,
      env: {
        ...common,
        ...claudeEphemeralEnvironment()
      }
    }
  }
  assertCustomModelRequest(request)
  return {
    command: invocation.command,
    // Custom-model mode has explicit environment authentication, so the
    // official bare mode can safely skip all user/project customizations.
    args: [...invocation.argumentPrefix, ...claudeExecutionArgs(model.name, true)],
    cwd: sessionRoot,
    env: {
      ...common,
      ...claudeEphemeralEnvironment(),
      ANTHROPIC_API_KEY: request.apiKey ?? 'luckytag-local-no-auth',
      ANTHROPIC_BASE_URL: model.baseUrl
    }
  }
}

const runChild = async (
  specification: ExecutionSpecification,
  input: string,
  timeoutMs: number,
  tracker: ActiveChildTracker
): Promise<AgentExecutionResult> => new Promise((resolve, reject) => {
  const child = spawn(specification.command, specification.args, {
    cwd: specification.cwd,
    env: specification.env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let forceKillTimer: NodeJS.Timeout | undefined
  const accepted = tracker.register(child)
  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(child.pid, 'SIGTERM', () => child.kill('SIGTERM'))
    forceKillTimer = setTimeout(() => {
      killProcessTree(child.pid, 'SIGKILL', () => child.kill('SIGKILL'))
    }, 1_000)
    forceKillTimer.unref()
  }, timeoutMs)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout = appendBounded(stdout, chunk) })
  child.stderr.on('data', (chunk: string) => { stderr = appendBounded(stderr, chunk) })
  child.on('error', (error) => {
    tracker.unregister(child)
    clearTimeout(timer)
    if (forceKillTimer) clearTimeout(forceKillTimer)
    reject(tracker.isShuttingDown()
      ? codedAgentError('AGENT_RUNNER_SHUTDOWN', 'Agent Runner 已关闭')
      : error)
  })
  child.on('close', (code) => {
    tracker.unregister(child)
    clearTimeout(timer)
    if (forceKillTimer) clearTimeout(forceKillTimer)
    if (tracker.isShuttingDown()) {
      reject(codedAgentError('AGENT_RUNNER_SHUTDOWN', 'Agent Runner 已关闭'))
      return
    }
    if (timedOut) {
      reject(Object.assign(new Error('Agent 执行超时'), { code: 'AGENT_TIMEOUT' }))
      return
    }
    const exitCode = code ?? 1
    if (exitCode !== 0) {
      reject(Object.assign(new Error(stderr.trim() || `Agent 退出码 ${exitCode}`), {
        code: 'AGENT_EXECUTION_FAILED'
      }))
      return
    }
    resolve({ output: stdout.trim(), exitCode })
  })
  child.stdin.on('error', () => undefined)
  if (!accepted) {
    killProcessTree(child.pid, 'SIGTERM', () => child.kill('SIGTERM'))
    child.stdin.destroy()
  } else {
    child.stdin.end(input, 'utf8')
  }
})

const prepareRuntimeConfiguration = async (
  request: AgentExecutionRequest,
  sessionRoot: string
): Promise<void> => {
  if (request.configuration.runtime !== 'codex' || request.configuration.mode !== 'custom-model') return
  assertCustomModelRequest(request)
  const codexHome = join(sessionRoot, '.codex')
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  const baseUrl = JSON.stringify(request.configuration.model.baseUrl)
  const config = [
    'model_provider = "luckytag_custom"',
    '',
    '[model_providers.luckytag_custom]',
    'name = "LuckyTag custom model"',
    `base_url = ${baseUrl}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    ''
  ].join('\n')
  await writeFile(join(codexHome, 'config.toml'), config, { encoding: 'utf8', mode: 0o600 })
}

const secureExecOptions = () => ({
  encoding: 'utf8' as const,
  timeout: 10_000,
  maxBuffer: 128 * 1024,
  windowsHide: true,
  env: probeEnvironment()
})

const runSecurityWithSecret = (
  executable: string,
  args: string[],
  secret: string
): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    env: probeEnvironment(),
    shell: false,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 10_000)
  child.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
  child.once('close', (code) => {
    clearTimeout(timer)
    if (timedOut) reject(codedAgentError('KEYCHAIN_TIMEOUT', 'macOS 钥匙串操作超时'))
    else if (code !== 0) reject(codedAgentError('KEYCHAIN_COMMAND_FAILED', 'macOS 钥匙串拒绝了写入操作'))
    else resolve()
  })
  child.stdin.on('error', () => undefined)
  // `security ... -w` prompts for the value (and may request confirmation for
  // a new item). Feeding both lines keeps the secret out of argv/process lists.
  child.stdin.end(`${secret}\n${secret}\n`, 'utf8')
})

const probeEnvironment = (runtime?: AgentRuntimeKind): NodeJS.ProcessEnv => ({
  PATH: runtime === 'claude-code'
    ? trustedClaudeChildPath()
    : process.env['PATH'] || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  HOME: process.env['HOME'],
  LANG: process.env['LANG'] || 'en_US.UTF-8',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
})

const networkEnvironment = (): NodeJS.ProcessEnv => allowlistedEnvironment([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS'
])

const allowlistedEnvironment = (names: string[]): NodeJS.ProcessEnv => Object.fromEntries(
  names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : [])
)

const codexDefaultConfigurationEnvironment = (): NodeJS.ProcessEnv => {
  const home = process.env['HOME']?.trim()
  const codexHome = process.env['CODEX_HOME']?.trim() || (home ? join(home, '.codex') : '')
  return codexHome ? { CODEX_HOME: codexHome } : {}
}

const claudeEphemeralEnvironment = (): NodeJS.ProcessEnv => ({
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_FEEDBACK_COMMAND: '1',
  MCP_CONNECTION_NONBLOCKING: 'true'
})

const claudeExecutionArgs = (modelName?: string, bare = false): string[] => [
  ...(bare ? ['--bare'] : []),
  '-p',
  ...(modelName ? ['--model', modelName] : []),
  '--output-format',
  'text',
  '--tools',
  '',
  '--mcp-config',
  JSON.stringify({ mcpServers: {} }),
  '--strict-mcp-config',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--no-chrome',
  ...(!bare ? ['--setting-sources', ''] : []),
  '--settings',
  JSON.stringify({ disableAllHooks: true })
]

const serviceName = (scope: AgentCredentialScope): string => {
  const endpoint = normalizeCredentialEndpoint(scope.baseUrl)
  const endpointHash = createHash('sha256').update(endpoint).digest('hex').slice(0, 24)
  return `com.luckytag.agent.${scope.runtime}.${endpointHash}`
}
const normalizeCredentialEndpoint = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return 'runtime-default'
  try {
    return new URL(trimmed).toString()
  } catch {
    return trimmed
  }
}
const runtimeCommand = (runtime: AgentRuntimeKind): string => {
  const override = process.env['LUCKYTAG_CODEX_PATH']?.trim()
  if (runtime === 'codex' && override) return override
  const executableName = 'codex'
  const home = process.env['HOME']?.trim()
  const pathCandidates = (process.env['PATH'] || '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executableName))
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    ...(home ? [join(home, '.local', 'bin', 'codex')] : []),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...pathCandidates
  ]
  return [...new Set(candidates)].find(isExecutableFile) || executableName
}

export interface CodexCliTrustPolicy {
  path: string
  sha256: string
  uid: number
}

export const validateTrustedCodexCli = async (
  candidate: string,
  policy: CodexCliTrustPolicy = defaultCodexCliTrustPolicy()
): Promise<string> => {
  try {
    const cliPath = realpathSync(candidate)
    if (cliPath !== realpathSync(policy.path)) throw untrustedCodexRuntimeError()
    const metadata = statSync(cliPath)
    if (!metadata.isFile() || metadata.uid !== policy.uid || (metadata.mode & 0o022) !== 0 || metadata.size > MAX_TRUSTED_CODEX_CLI_BYTES) {
      throw untrustedCodexRuntimeError()
    }
    const { stdout } = await execFileAsync('/usr/bin/shasum', ['-a', '256', cliPath], {
      ...secureExecOptions(),
      maxBuffer: 8 * 1024
    })
    if (stdout.trim().split(/\s+/u)[0] !== policy.sha256) throw untrustedCodexRuntimeError()
    return cliPath
  } catch (error) {
    if (error instanceof Error && 'code' in error && String(error.code) === 'AGENT_RUNTIME_UNTRUSTED') throw error
    throw untrustedCodexRuntimeError()
  }
}

const defaultCodexCliTrustPolicy = (): CodexCliTrustPolicy => {
  const uid = process.getuid?.()
  if (uid === undefined) throw untrustedCodexRuntimeError()
  return { path: TRUSTED_CODEX_CLI_PATH, sha256: TRUSTED_CODEX_CLI_SHA256, uid }
}

const untrustedCodexRuntimeError = (): Error => codedAgentError(
  'AGENT_RUNTIME_UNTRUSTED',
  'Codex BYOK 只允许当前 LuckyTag 已验证的内置 Codex CLI'
)

export interface ClaudeCliTrustPolicy {
  packageName: string
  version: string
  sha256: string
  packageSha256: string
  uid: number
}

const defaultClaudeCliTrustPolicy = (): ClaudeCliTrustPolicy => {
  const uid = process.getuid?.()
  if (uid === undefined) throw untrustedClaudeRuntimeError()
  return {
    packageName: TRUSTED_CLAUDE_CODE_PACKAGE,
    version: TRUSTED_CLAUDE_CODE_VERSION,
    sha256: TRUSTED_CLAUDE_CODE_CLI_SHA256,
    packageSha256: TRUSTED_CLAUDE_CODE_PACKAGE_SHA256,
    uid
  }
}

export const validateTrustedClaudeCli = (
  candidate: string,
  policy: ClaudeCliTrustPolicy = defaultClaudeCliTrustPolicy()
): string => {
  try {
    const cliPath = realpathSync(candidate)
    const packageDirectory = dirname(cliPath)
    if (!cliPath.endsWith(`${sep}@anthropic-ai${sep}claude-code${sep}cli.js`)) {
      throw untrustedClaudeRuntimeError()
    }
    const packagePath = join(packageDirectory, 'package.json')
    if (lstatSync(packagePath).isSymbolicLink()) throw untrustedClaudeRuntimeError()
    const [cliMetadata, packageMetadata, directoryMetadata] = [
      statSync(cliPath),
      statSync(packagePath),
      statSync(packageDirectory)
    ]
    if (!cliMetadata.isFile() || !packageMetadata.isFile() || !directoryMetadata.isDirectory()) {
      throw untrustedClaudeRuntimeError()
    }
    if (
      [cliMetadata, packageMetadata, directoryMetadata].some((metadata) =>
        metadata.uid !== policy.uid || (metadata.mode & 0o022) !== 0
      )
    ) {
      throw untrustedClaudeRuntimeError()
    }
    if (cliMetadata.size <= 0 || cliMetadata.size > MAX_TRUSTED_CLAUDE_CLI_BYTES) {
      throw untrustedClaudeRuntimeError()
    }
    const packageBytes = readFileSync(packagePath)
    const packageDigest = createHash('sha256').update(packageBytes).digest('hex')
    if (packageDigest !== policy.packageSha256) throw untrustedClaudeRuntimeError()
    const packageValue = JSON.parse(packageBytes.toString('utf8')) as unknown
    if (!isPinnedClaudePackage(packageValue, policy)) throw untrustedClaudeRuntimeError()
    const digest = createHash('sha256').update(readFileSync(cliPath)).digest('hex')
    if (digest !== policy.sha256) throw untrustedClaudeRuntimeError()
    accessSync(cliPath, constants.R_OK | constants.X_OK)
    return cliPath
  } catch (error) {
    if (isUntrustedClaudeRuntime(error)) throw error
    throw untrustedClaudeRuntimeError()
  }
}

export const resolveTrustedClaudeCli = (
  candidates: readonly string[],
  policy: ClaudeCliTrustPolicy = defaultClaudeCliTrustPolicy()
): string => {
  for (const candidate of [...new Set(candidates)]) {
    try {
      return validateTrustedClaudeCli(candidate, policy)
    } catch {
      // Continue across known installation roots, but never fall back to PATH.
    }
  }
  throw untrustedClaudeRuntimeError()
}

export const resolveTrustedClaudeInvocation = (
  cliCandidates: readonly string[] = trustedClaudeCliCandidates(),
  nodePath = process.execPath,
  policy: ClaudeCliTrustPolicy = defaultClaudeCliTrustPolicy()
): RuntimeInvocation => ({
  // The packaged daemon is itself running under the sidecar Node that the
  // package verifier and DaemonManager selected. Execute that same absolute
  // interpreter directly so cli.js's `/usr/bin/env node` shebang is never
  // evaluated against child PATH.
  command: realpathSync(nodePath),
  argumentPrefix: [resolveTrustedClaudeCli(cliCandidates, policy)]
})

const isPinnedClaudePackage = (
  value: unknown,
  policy: ClaudeCliTrustPolicy
): value is { name: string; version: string } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record['name'] === policy.packageName && record['version'] === policy.version
}

const trustedClaudeCliCandidates = (): string[] => {
  const home = process.env['HOME']?.trim()
  const prefixes = [
    ...(home ? [
      join(home, '.petclaw', 'node'),
      join(home, '.npm-global'),
      join(home, '.local')
    ] : []),
    dirname(dirname(process.execPath)),
    '/opt/homebrew',
    '/usr/local',
    '/usr'
  ]
  if (home) {
    prefixes.push(
      ...versionedNodePrefixes(join(home, '.nvm', 'versions', 'node')),
      ...versionedNodePrefixes(join(home, '.asdf', 'installs', 'nodejs'))
    )
  }
  return [...new Set(prefixes)].flatMap((prefix) => [
    join(prefix, 'bin', 'claude'),
    join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  ])
}

const versionedNodePrefixes = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

const untrustedClaudeRuntimeError = (): Error => codedAgentError(
  'AGENT_RUNTIME_UNTRUSTED',
  `Claude Code 必须是受信任的 ${TRUSTED_CLAUDE_CODE_PACKAGE} ${TRUSTED_CLAUDE_CODE_VERSION}`
)

const isUntrustedClaudeRuntime = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && String(error.code) === 'AGENT_RUNTIME_UNTRUSTED'

const runtimeInvocation = (
  runtime: AgentRuntimeKind,
  overrides: AgentRuntimeCommandOverrides
): RuntimeInvocation => {
  const override = overrides[runtime]?.trim()
  if (override) return { command: override, argumentPrefix: [] }
  if (runtime === 'claude-code') return resolveTrustedClaudeInvocation()
  return { command: runtimeCommand(runtime), argumentPrefix: [] }
}

const trustedClaudeChildPath = (): string => [
  dirname(realpathSync(process.execPath)),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].join(delimiter)

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}
const runtimeLabel = (runtime: AgentRuntimeKind): string => runtime === 'codex' ? 'Codex CLI' : 'Claude Code'
const safeSessionId = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 48) || 'session'
const appendBounded = (current: string, chunk: string): string => `${current}${chunk}`.slice(-2_000_000)

const killProcessTree = (
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => boolean
): void => {
  if (process.platform !== 'win32' && pid) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // The process may have exited between the timeout and signal delivery.
    }
  }
  fallback()
}

const isCommandMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && String(error.code) === 'ENOENT'

const isSecurityItemMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (Number(error.code) === 44 || String(error.code) === '44')

function assertCustomModelRequest(request: AgentExecutionRequest): void {
  const expectedProtocol = request.configuration.runtime === 'codex'
    ? 'openai-responses'
    : 'anthropic-messages'
  if (request.configuration.model.protocol !== expectedProtocol) {
    throw codedAgentError('AGENT_PROTOCOL_MISMATCH', '所选 Agent Runtime 与模型协议不兼容')
  }
  if (!request.configuration.model.name.trim() || !request.configuration.model.baseUrl.trim()) {
    throw codedAgentError('AGENT_MODEL_CONFIGURATION_INCOMPLETE', '自定义模型名称或 URL 未配置')
  }
  if (request.configuration.model.authentication === 'api-key' && !request.apiKey?.trim()) {
    throw codedAgentError('AGENT_API_KEY_MISSING', '自定义模型 Key 尚未配置')
  }
}

export const safeAgentExecutionError = (error: unknown): Error => {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'AGENT_CONFIGURATION_TEST_FAILED'
  if (code === 'AGENT_TIMEOUT') return codedAgentError(code, '模型配置测试超时')
  if (code === 'ENOENT') return codedAgentError('AGENT_RUNTIME_NOT_FOUND', '未找到所选 Agent Runtime')
  if (code === 'AGENT_RUNTIME_UNTRUSTED') {
    return codedAgentError(
      code,
      error instanceof Error && error.message.includes('Codex')
        ? '未找到 LuckyTag 已验证的内置 Codex CLI'
        : `未找到受信任的 Claude Code ${TRUSTED_CLAUDE_CODE_VERSION}`
    )
  }
  if (code === 'AGENT_API_KEY_MISSING' || code === 'AGENT_MODEL_CONFIGURATION_INCOMPLETE') {
    return codedAgentError(code, error instanceof Error ? error.message : 'Agent 模型配置不完整')
  }
  return codedAgentError('AGENT_CONFIGURATION_TEST_FAILED', '模型服务调用失败，请检查 Runtime、模型、URL 和 Key')
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds)
  timer.unref()
})

const codedAgentError = (code: string, message: string): Error => Object.assign(new Error(message), { code })

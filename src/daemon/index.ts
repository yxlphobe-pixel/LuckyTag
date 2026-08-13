import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentConfigurationInput,
  AgentConfigurationTestResult,
  ApiResult,
  AppConfig,
  DashboardSnapshot,
  DaemonStatus
} from '../shared/contracts'
import {
  assertAgentConfigurationInput,
  assertAgentRuntimeKind,
  assertAppConfig,
  assertDemoWorkflowRequirementCreateInput,
  assertDemoWorkflowRequirementInput
} from '../shared/validation'
import { LuckyTagService } from '../main/core/service'
import {
  AgentRuntimeRegistry,
  IsolatedAgentRunner,
  MacKeychainCredentialStore,
  type AgentCredentialScope,
  type CredentialStore
} from './agent-runtime'
import {
  DAEMON_NATIVE_APPROVAL,
  DAEMON_NATIVE_APPROVAL_HEADER,
  DAEMON_PROTOCOL_VERSION,
  OrderedAsyncDispatcher
} from './protocol'

const MAX_BODY_BYTES = 1024 * 1024
const SSE_HEARTBEAT_INTERVAL_MS = 15_000
export const AGENT_CONFIGURATION_TEST_COOLDOWN_MS = 30_000
const startedAt = new Date().toISOString()

export class AgentConfigurationTestGate {
  private inFlight = false
  private nextAllowedAt = 0

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly cooldownMs = AGENT_CONFIGURATION_TEST_COOLDOWN_MS
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      throw codedError('AGENT_CONFIGURATION_TEST_IN_PROGRESS', 'Agent 配置测试正在运行，请等待当前测试完成')
    }
    if (this.now() < this.nextAllowedAt) {
      throw codedError('AGENT_CONFIGURATION_TEST_COOLDOWN', 'Agent 配置测试冷却中，请稍后重试')
    }
    this.inFlight = true
    try {
      return await operation()
    } finally {
      this.inFlight = false
      this.nextAllowedAt = this.now() + this.cooldownMs
    }
  }
}

interface DaemonOptions {
  dataRoot: string
  socketPath: string
  tokenPath: string
  buildIdentity: string
}

const main = async (): Promise<void> => {
  const options = daemonOptions()
  const daemonRoot = dirname(options.socketPath)
  await mkdir(daemonRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(daemonRoot, 0o700)
  const daemonLock = await acquireDaemonLock(join(daemonRoot, 'daemon.lock'), options.socketPath)
  if (!daemonLock) return
  let daemonStarted = false

  try {
    const token = await readInstallToken(options.tokenPath)
    if (await socketAcceptsConnections(options.socketPath)) return
    await removeStaleSocket(options.socketPath)

    const credentials = new MacKeychainCredentialStore()
    const runtimes = new AgentRuntimeRegistry()
    const agentRunner = new IsolatedAgentRunner(options.dataRoot)
    const agentTestGate = new AgentConfigurationTestGate()
    const configurationMutations = new OrderedAsyncDispatcher()
    const subscribers = new Set<ServerResponse>()
    let publishUpdate: (snapshot: DashboardSnapshot) => void = () => undefined
    const service = new LuckyTagService({
      dataRoot: options.dataRoot,
      onUpdate: (snapshot) => publishUpdate(snapshot)
    })
    await service.initialize()

    const daemonStatus: DaemonStatus = {
      connected: true,
      pid: process.pid,
      startedAt,
      transport: 'unix-socket',
      endpoint: options.socketPath
    }

    const decorateSnapshot = async (snapshot: DashboardSnapshot): Promise<DashboardSnapshot> => {
      const apiKeyConfigured = snapshot.config.agent.mode === 'custom-model' &&
        snapshot.config.agent.model.authentication === 'api-key'
        ? await credentials.has(credentialScope(snapshot.config.agent.runtime, snapshot.config.agent.model.baseUrl))
        : false
      const config: AppConfig = {
        ...snapshot.config,
        agent: {
          ...snapshot.config.agent,
          model: { ...snapshot.config.agent.model, apiKeyConfigured }
        }
      }
      return {
        ...snapshot,
        config,
        agentRuntime: await runtimes.probe(config.agent.runtime),
        daemon: daemonStatus
      }
    }

    const updateQueue = new OrderedAsyncDispatcher()
    publishUpdate = (snapshot) => {
      updateQueue.enqueue(async () => {
        broadcastEvent(subscribers, await decorateSnapshot(snapshot))
      })
    }

    const server = createServer((request, response) => {
      void routeRequest({
        request,
        response,
        token,
        service,
        credentials,
        runtimes,
        agentRunner,
        agentTestGate,
        configurationMutations,
        daemonStatus,
        buildIdentity: options.buildIdentity,
        decorateSnapshot,
        updateQueue,
        requestShutdown: () => process.kill(process.pid, 'SIGTERM'),
        subscribers
      }).catch((error: unknown) => writeFailure(response, error))
    })
    // Limits slow request uploads; long-running commands have their own CLI and
    // desktop deadlines and do not stream request bodies.
    server.requestTimeout = 60_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.maxRequestsPerSocket = 100

    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(options.socketPath, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
    await chmod(options.socketPath, 0o600)

    const heartbeat = setInterval(() => {
      for (const subscriber of subscribers) writeEventChunk(subscribers, subscriber, ': heartbeat\n\n')
    }, SSE_HEARTBEAT_INTERVAL_MS)
    heartbeat.unref()

    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      clearInterval(heartbeat)
      for (const subscriber of subscribers) subscriber.end()
      subscribers.clear()
      // Start terminating detached Agent process groups immediately. Waiting
      // until server.close() would deadlock on an in-flight /agent/test request.
      const runnerShutdown = agentRunner.shutdown().catch(() => undefined)
      server.close(() => {
        void runnerShutdown
          .then(() => service.shutdown())
          .catch(() => undefined)
          .then(() => cleanupDaemonFiles(options.socketPath, daemonLock))
          .finally(() => process.exit(0))
      })
      // launchd needs a finite stop deadline during upgrades, but normally the
      // graceful path above checkpoints SQLite and preserves Worker intent.
      setTimeout(() => process.exit(0), 10_000).unref()
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    daemonStarted = true
  } finally {
    if (!daemonStarted) await releaseDaemonLock(daemonLock)
  }
}

interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  token: string
  service: LuckyTagService
  credentials: CredentialStore
  runtimes: AgentRuntimeRegistry
  agentRunner: IsolatedAgentRunner
  agentTestGate: AgentConfigurationTestGate
  configurationMutations: OrderedAsyncDispatcher
  daemonStatus: DaemonStatus
  buildIdentity: string
  decorateSnapshot(snapshot: DashboardSnapshot): Promise<DashboardSnapshot>
  updateQueue: OrderedAsyncDispatcher
  requestShutdown(): void
  subscribers: Set<ServerResponse>
}

const routeRequest = async (context: RouteContext): Promise<void> => {
  const { request, response, service } = context
  assertAuthorized(request, context.token)
  const method = request.method || 'GET'
  const path = new URL(request.url || '/', 'http://luckytag.local').pathname

  if (method === 'GET' && path === '/v1/health') {
    writeSuccess(response, {
      ...context.daemonStatus,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      buildIdentity: context.buildIdentity
    })
    return
  }
  if (method === 'GET' && path === '/v1/events') {
    await context.updateQueue.run(async () => {
      if (request.destroyed || response.destroyed) return
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no'
      })
      response.write(': LuckyTag daemon event stream\n\n')
      context.subscribers.add(response)
      request.once('close', () => context.subscribers.delete(response))
      writeEventChunk(
        context.subscribers,
        response,
        `data: ${JSON.stringify(await context.decorateSnapshot(await service.getSnapshot()))}\n\n`
      )
    })
    return
  }
  if (method === 'GET' && path === '/v1/snapshot') {
    writeSuccess(response, await context.decorateSnapshot(await service.getSnapshot()))
    return
  }
  if (method === 'PUT' && path === '/v1/config') {
    const proposed = assertAppConfig(await readJsonBody(request))
    writeSuccess(response, await context.configurationMutations.run(() =>
      saveApplicationConfiguration(
        context,
        proposed,
        nativeApprovalHeader(request)
      )
    ))
    return
  }
  if (method === 'PUT' && path === '/v1/agent/configuration') {
    const input = assertAgentConfigurationInput(await readJsonBody(request))
    const saved = await context.configurationMutations.run(() =>
      saveAgentConfiguration(context, input)
    )
    writeSuccess(response, saved)
    return
  }
  if (method === 'POST' && path === '/v1/agent/probe') {
    const body = await readJsonBody(request)
    const runtime = assertAgentRuntimeKind(recordString(body, 'runtime'))
    writeSuccess(response, await context.runtimes.probe(runtime, true))
    return
  }
  if (method === 'POST' && path === '/v1/agent/test') {
    writeSuccess(response, await context.agentTestGate.run(() => testAgentConfiguration(context)))
    return
  }
  if (method === 'POST' && path === '/v1/admin/shutdown') {
    writeSuccess(response, null)
    setImmediate(context.requestShutdown)
    return
  }
  if (method === 'POST' && path === '/v1/knowledge/sync') {
    writeSuccess(response, await service.syncKnowledge())
    return
  }
  if (method === 'POST' && path === '/v1/connections/probe') {
    writeSuccess(response, await service.probeConnections())
    return
  }
  if (method === 'POST' && path === '/v1/connections/authenticate') {
    const body = await readJsonBody(request)
    const kind = recordString(body, 'kind')
    if (kind !== 'sampleMessaging' && kind !== 'sampleLibrary' && kind !== 'sampleauth') {
      throw codedError('UNSUPPORTED_AUTH_CONNECTOR', '不支持的认证连接器')
    }
    writeSuccess(response, await service.authenticate(kind))
    return
  }
  if (method === 'POST' && path === '/v1/connections/sampleauth/disconnect') {
    assertNativeApproval(request, DAEMON_NATIVE_APPROVAL.disconnectSampleAuth)
    writeSuccess(response, await context.decorateSnapshot(await service.disconnectSampleAuth()))
    return
  }
  if (method === 'POST' && path === '/v1/worker/start') {
    if (allowsLiveSending((await service.getSnapshot()).config)) {
      assertNativeApproval(request, DAEMON_NATIVE_APPROVAL.enableLiveSending)
    }
    writeSuccess(response, await service.startWorker())
    return
  }
  if (method === 'POST' && path === '/v1/worker/stop') {
    writeSuccess(response, await service.stopWorker())
    return
  }
  if (method === 'POST' && path === '/v1/worker/run-once') {
    if (allowsLiveSending((await service.getSnapshot()).config)) {
      assertNativeApproval(request, DAEMON_NATIVE_APPROVAL.enableLiveSending)
    }
    writeSuccess(response, await service.runOnce())
    return
  }
  if (method === 'POST' && path === '/v1/demoWorkflow/preview') {
    writeSuccess(response, await service.previewDemoWorkflowRequirement(assertDemoWorkflowRequirementInput(await readJsonBody(request))))
    return
  }
  if (method === 'POST' && path === '/v1/demoWorkflow/create') {
    writeSuccess(response, await service.createDemoWorkflowRequirement(assertDemoWorkflowRequirementCreateInput(await readJsonBody(request))))
    return
  }
  throw codedError('DAEMON_ROUTE_NOT_FOUND', `不支持的本机服务路由：${method} ${path}`)
}

export interface AgentConfigurationSaveContext {
  service: Pick<LuckyTagService, 'getSnapshot' | 'saveConfig'>
  credentials: CredentialStore
  decorateSnapshot(snapshot: DashboardSnapshot): Promise<DashboardSnapshot>
}

export const saveApplicationConfiguration = async (
  context: AgentConfigurationSaveContext,
  proposed: AppConfig,
  nativeApproval?: string
): Promise<DashboardSnapshot> => {
  const current = await context.service.getSnapshot()
  if (!allowsLiveSending(current.config) && allowsLiveSending(proposed)) {
    assertNativeApprovalValue(nativeApproval, DAEMON_NATIVE_APPROVAL.enableLiveSending)
  }
  const saved = await context.service.saveConfig({ ...proposed, agent: current.config.agent })
  return context.decorateSnapshot(saved)
}

export const saveAgentConfiguration = async (
  context: AgentConfigurationSaveContext,
  input: AgentConfigurationInput
): Promise<DashboardSnapshot> => {
  const current = await context.service.getSnapshot()
  if (input.mode === 'runtime-default' && (input.apiKey || input.clearApiKey)) {
    throw codedError('AGENT_CREDENTIAL_NOT_ALLOWED', 'Runtime 默认配置模式不接收 LuckyTag 模型 Key')
  }
  const scope = credentialScope(input.runtime, input.baseUrl)
  const requiresApiKey = input.mode === 'custom-model' && input.authentication === 'api-key'
  const sameCredentialScope = current.config.agent.mode === 'custom-model' &&
    current.config.agent.model.authentication === 'api-key' &&
    requiresApiKey &&
    current.config.agent.runtime === input.runtime &&
    normalizeEndpoint(current.config.agent.model.baseUrl) === normalizeEndpoint(input.baseUrl)
  if (input.enabled && requiresApiKey && !input.apiKey && !sameCredentialScope) {
    throw codedError('AGENT_API_KEY_REENTRY_REQUIRED', '切换 Runtime 或模型 URL 后必须重新输入 Key')
  }
  const previousCredential = input.mode === 'custom-model'
    ? await context.credentials.get(scope)
    : null
  let credentialChanged = false
  try {
    if (input.apiKey) {
      await context.credentials.set(scope, input.apiKey)
      credentialChanged = true
    }
    if (input.clearApiKey) {
      await context.credentials.delete(scope)
      credentialChanged = true
    }
    if (input.mode === 'custom-model' && input.authentication === 'none' && previousCredential) {
      await context.credentials.delete(scope)
      credentialChanged = true
    }
    if (
      requiresApiKey &&
      !input.apiKey &&
      !input.clearApiKey &&
      !sameCredentialScope &&
      previousCredential
    ) {
      await context.credentials.delete(scope)
      credentialChanged = true
    }
  } catch {
    await restoreCredential(context.credentials, scope, previousCredential)
    throw codedError('AGENT_CREDENTIAL_UPDATE_FAILED', '无法安全更新 Agent 模型凭据')
  }

  try {
    const apiKeyConfigured = requiresApiKey
      ? await context.credentials.has(scope)
      : false
    if (input.enabled && requiresApiKey && !apiKeyConfigured) {
      throw codedError('AGENT_API_KEY_REQUIRED', '启用自定义模型前必须配置 Key')
    }
    const saved = await context.service.saveConfig({
      ...current.config,
      agent: {
        enabled: input.enabled,
        runtime: input.runtime,
        mode: input.mode,
        model: {
          provider: input.provider,
          protocol: input.protocol,
          authentication: input.authentication,
          name: input.modelName,
          baseUrl: input.baseUrl,
          apiKeyConfigured
        }
      }
    })
    return await context.decorateSnapshot(saved)
  } catch (error) {
    if (credentialChanged) {
      await restoreCredential(context.credentials, scope, previousCredential)
    }
    // saveConfig performs multiple durable steps. Restore the prior canonical
    // configuration as well in case a later snapshot/decorating step failed.
    await context.service.saveConfig(current.config).catch(() => undefined)
    throw error
  }
}

const restoreCredential = async (
  credentials: CredentialStore,
  scope: AgentCredentialScope,
  previousCredential: string | null
): Promise<void> => {
  if (previousCredential) await credentials.set(scope, previousCredential).catch(() => undefined)
  else await credentials.delete(scope).catch(() => undefined)
}

export interface AgentConfigurationTestContext {
  service: Pick<LuckyTagService, 'getSnapshot'>
  credentials: CredentialStore
  runtimes: Pick<AgentRuntimeRegistry, 'probe'>
  agentRunner: Pick<IsolatedAgentRunner, 'run'>
}

export const testAgentConfiguration = async (
  context: AgentConfigurationTestContext
): Promise<AgentConfigurationTestResult> => {
  const configuration = (await context.service.getSnapshot()).config.agent
  if (!configuration.enabled) {
    throw codedError('AGENT_CONFIGURATION_DISABLED', '请先保存并启用 Agent 配置')
  }
  const runtimeStatus = await context.runtimes.probe(configuration.runtime, true)
  if (!runtimeStatus.available) {
    throw codedError('AGENT_RUNTIME_UNAVAILABLE', 'Agent Runtime 尚未安装或当前不可用')
  }

  const apiKey = configuration.mode === 'custom-model' && configuration.model.authentication === 'api-key'
    ? await context.credentials.get(credentialScope(configuration.runtime, configuration.model.baseUrl))
    : undefined
  if (configuration.mode === 'custom-model' && configuration.model.authentication === 'api-key' && !apiKey) {
    throw codedError('AGENT_API_KEY_NOT_CONFIGURED', '尚未为自定义模型配置 Key')
  }

  const started = Date.now()
  try {
    const result = await context.agentRunner.run({
      sessionId: `configuration-test-${randomUUID()}`,
      prompt: 'Reply with exactly: LUCKYTAG_OK',
      configuration,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: 60_000
    })
    if (!result.output.includes('LUCKYTAG_OK')) throw new Error('Agent did not return the expected marker')
  } catch {
    throw codedError(
      'AGENT_CONFIGURATION_TEST_FAILED',
      'Agent 配置测试失败，请检查 Runtime、模型名称、URL、网络与凭据后重试'
    )
  }
  return {
    runtime: configuration.runtime,
    mode: configuration.mode,
    status: 'succeeded',
    testedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    detail: 'Agent Runtime 与模型连接测试成功',
    ...(runtimeStatus.version ? { runtimeVersion: runtimeStatus.version } : {})
  }
}

const credentialScope = (
  runtime: AgentConfigurationInput['runtime'],
  baseUrl: string
): AgentCredentialScope => ({ runtime, baseUrl: normalizeEndpoint(baseUrl) })

const normalizeEndpoint = (value: string): string => {
  try {
    return new URL(value.trim()).toString()
  } catch {
    return value.trim()
  }
}

const allowsLiveSending = (config: AppConfig): boolean =>
  config.replyPolicy.enabled && !config.replyPolicy.dryRun

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) throw codedError('REQUEST_TOO_LARGE', '请求体超过 1 MiB 限制')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw codedError('INVALID_JSON_BODY', '请求体不是有效 JSON')
  }
}

const assertAuthorized = (request: IncomingMessage, token: string): void => {
  const authorization = request.headers.authorization || ''
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const expectedBuffer = Buffer.from(token)
  const providedBuffer = Buffer.from(provided)
  if (
    expectedBuffer.length === 0 ||
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) throw codedError('DAEMON_UNAUTHORIZED', '本机服务认证失败')
}

export const assertNativeApproval = (
  request: Pick<IncomingMessage, 'headers'>,
  expected: string
): void => assertNativeApprovalValue(nativeApprovalHeader(request), expected)

const nativeApprovalHeader = (request: Pick<IncomingMessage, 'headers'>): string | undefined => {
  const provided = request.headers[DAEMON_NATIVE_APPROVAL_HEADER]
  return typeof provided === 'string' ? provided : undefined
}

const assertNativeApprovalValue = (provided: string | undefined, expected: string): void => {
  if (typeof provided !== 'string' || provided !== expected) {
    throw codedError('NATIVE_APPROVAL_REQUIRED', '此敏感操作必须先通过 LuckyTag 原生确认')
  }
}

const writeSuccess = <T>(response: ServerResponse, data: T): void => {
  writeJson(response, 200, { ok: true, data })
}

const writeFailure = (response: ServerResponse, error: unknown): void => {
  if (response.headersSent) {
    response.end()
    return
  }
  const message = error instanceof Error ? error.message : '本机服务发生未知错误'
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'DAEMON_ERROR'
  const status = code === 'DAEMON_UNAUTHORIZED' ? 401 : code === 'DAEMON_ROUTE_NOT_FOUND' ? 404 : 400
  writeJson(response, status, { ok: false, error: { code, message } } satisfies ApiResult<never>)
}

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(`${JSON.stringify(value)}\n`)
}

const daemonOptions = (): DaemonOptions => {
  const dataRoot = process.env['LUCKYTAG_DATA_ROOT']?.trim()
  const socketPath = process.env['LUCKYTAG_DAEMON_SOCKET']?.trim()
  const tokenPath = process.env['LUCKYTAG_DAEMON_TOKEN_PATH']?.trim()
  const buildIdentity = process.env['LUCKYTAG_DAEMON_BUILD_IDENTITY']?.trim()
  if (!dataRoot || !socketPath || !tokenPath || !buildIdentity) {
    throw new Error('Daemon 缺少数据目录、Socket、令牌或构建标识')
  }
  if (![dataRoot, socketPath, tokenPath].every(isAbsolute)) {
    throw new Error('Daemon 数据、Socket 与令牌路径必须是绝对路径')
  }
  const expectedDaemonRoot = resolve(dataRoot, 'daemon')
  if (
    resolve(dirname(socketPath)) !== expectedDaemonRoot ||
    resolve(dirname(tokenPath)) !== expectedDaemonRoot
  ) {
    throw new Error('Daemon Socket 与令牌必须位于专用数据目录')
  }
  if (!/^[a-f0-9]{64}$/u.test(buildIdentity)) throw new Error('Daemon 构建标识无效')
  return {
    dataRoot: resolve(dataRoot),
    socketPath: resolve(socketPath),
    tokenPath: resolve(tokenPath),
    buildIdentity
  }
}

const readInstallToken = async (tokenPath: string): Promise<string> => {
  const metadata = await lstat(tokenPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Daemon 安装令牌必须是普通文件')
  }
  if (process.platform !== 'win32') await chmod(tokenPath, 0o600)
  const token = (await readFile(tokenPath, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{43,}$/u.test(token)) throw new Error('Daemon 安装令牌无效')
  return token
}

interface DaemonLock {
  path: string
  handle: FileHandle
  device: bigint
  inode: bigint
}

const acquireDaemonLock = async (
  lockPath: string,
  socketPath: string
): Promise<DaemonLock | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid}:${randomUUID()}:${Date.now()}\n`, 'utf8')
      await handle.sync()
      const metadata = await handle.stat({ bigint: true })
      return { path: lockPath, handle, device: metadata.dev, inode: metadata.ino }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      const owner = await readLockOwner(lockPath)
      if (owner && isProcessAlive(owner.pid)) {
        if (await socketAcceptsConnections(socketPath)) return null
        // Allow a real daemon a bounded startup window. After that, an absent
        // socket makes the lock stale even if the PID has been reused by an
        // unrelated process after a crash.
        if (Date.now() - owner.createdAt < 30_000) return null
      }
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if (!isNodeError(unlinkError) || unlinkError.code !== 'ENOENT') throw unlinkError
      })
    }
  }
  throw codedError('DAEMON_LOCK_FAILED', '无法取得 LuckyTag 本机服务单实例锁')
}

const readLockOwner = async (
  lockPath: string
): Promise<{ pid: number; createdAt: number } | null> => {
  try {
    const value = await readFile(lockPath, 'utf8')
    const parts = value.trim().split(':')
    const pid = Number.parseInt(parts[0] || '', 10)
    const createdAt = Number.parseInt(parts[2] || '', 10)
    return Number.isSafeInteger(pid) && pid > 0
      ? { pid, createdAt: Number.isSafeInteger(createdAt) ? createdAt : 0 }
      : null
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    return null
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM'
  }
}

const releaseDaemonLock = async (lock: DaemonLock): Promise<void> => {
  try {
    const metadata = await lstat(lock.path, { bigint: true })
    if (metadata.dev === lock.device && metadata.ino === lock.inode) {
      await unlink(lock.path).catch(() => undefined)
    }
  } catch {
    // A replacement daemon may already own a new lock at this path.
  } finally {
    await lock.handle.close().catch(() => undefined)
  }
}

const removeStaleSocket = async (socketPath: string): Promise<void> => {
  try {
    const metadata = await lstat(socketPath)
    if (!metadata.isSocket()) {
      throw codedError('UNSAFE_DAEMON_SOCKET_PATH', 'Daemon Socket 路径被非 Socket 文件占用')
    }
    await unlink(socketPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
}

const cleanupDaemonFiles = async (socketPath: string, lock: DaemonLock): Promise<void> => {
  await unlink(socketPath).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  })
  await releaseDaemonLock(lock)
}

const broadcastEvent = (
  subscribers: Set<ServerResponse>,
  snapshot: DashboardSnapshot
): void => {
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`
  for (const subscriber of subscribers) writeEventChunk(subscribers, subscriber, payload)
}

const writeEventChunk = (
  subscribers: Set<ServerResponse>,
  subscriber: ServerResponse,
  payload: string
): void => {
  if (subscriber.destroyed || subscriber.writableEnded || !subscriber.write(payload)) {
    subscribers.delete(subscriber)
    subscriber.end()
  }
}

const socketAcceptsConnections = (socketPath: string): Promise<boolean> => new Promise((resolve) => {
  const socket = createConnection(socketPath)
  const finish = (connected: boolean): void => {
    socket.removeAllListeners()
    socket.destroy()
    resolve(connected)
  }
  socket.setTimeout(500)
  socket.once('connect', () => finish(true))
  socket.once('error', () => finish(false))
  socket.once('timeout', () => finish(false))
})

const recordString = (value: unknown, key: string): string => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const selected = (value as Record<string, unknown>)[key]
  return typeof selected === 'string' ? selected : ''
}

const codedError = (code: string, message: string): Error => Object.assign(new Error(message), { code })
const isNodeError = (value: unknown): value is NodeJS.ErrnoException => value instanceof Error && 'code' in value

export const startDaemon = main

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    process.stderr.write(`[LuckyTag Daemon] ${message}\n`)
    process.exit(1)
  })
}

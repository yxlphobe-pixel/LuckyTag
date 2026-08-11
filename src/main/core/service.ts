import { randomUUID } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppConfig,
  ConnectionKind,
  ConnectionStatus,
  DashboardSnapshot,
  DimaRequirementCreateInput,
  DimaRequirementInput,
  DimaRequirementPreview,
  DimaRequirementResult,
  ReplyRecord,
  RunSummary,
  RuntimeStatus,
  SyncSummary
} from '../../shared/contracts'
import { DEFAULT_CONFIG } from '../../shared/contracts'
import { assertAppConfig, isAppConfig, migrateAppConfig } from '../../shared/validation'
import { OpenAuthCliAdapter } from '../identity/openauth-cli-adapter'
import { OpenAuthCliError, type OpenAuthSessionView } from '../identity/contracts'
import { CliExecutionError, CliRunner, type JsonCliRunner } from './cli-runner'
import { DwsAdapter } from './dws-adapter'
import { DimaAdapter, type DimaGateway } from './dima-adapter'
import { DimaRequirementWorkflow } from './dima-requirement'
import { DwsRequirementAdapter, type RequirementChatReader } from './dws-requirement-adapter'
import { isKnowledgeSnapshotFile, KnowledgeSynchronizer } from './knowledge-sync'
import type { JsonStore } from './json-store'
import { KnowledgeIndex } from './retrieval'
import { SqliteCoreStateStore, SqliteDatabase, SqliteJsonStore } from './sqlite-storage'
import { createCoreState, isCoreStateFile } from './state'
import type {
  CoreStateFile,
  DwsClient,
  KnowledgeSnapshotFile,
  YuqueAuthStatus,
  YuqueClient
} from './types'
import { EMPTY_KNOWLEDGE_SNAPSHOT } from './types'
import { errorMessage } from './value-utils'
import { WorkerEngine } from './worker'
import { YuqueAdapter } from './yuque-adapter'

type ProbedConnectionKind = 'dingtalk' | 'yuque' | 'openauth'

export interface LuckyTagDwsClient extends DwsClient {
  probe(): Promise<{ authenticated: boolean; detail: string; version?: string }>
  authenticate(): Promise<{ authenticated: boolean; detail: string; version?: string }>
}

export interface LuckyTagOpenAuthClient {
  probe(): Promise<OpenAuthSessionView>
  authenticate(): Promise<OpenAuthSessionView>
  logout(): Promise<void>
}

export interface LuckyTagServiceOptions {
  dataRoot: string
  onUpdate?: (snapshot: DashboardSnapshot) => void
  runner?: JsonCliRunner
  dws?: LuckyTagDwsClient
  yuque?: YuqueClient
  openauth?: LuckyTagOpenAuthClient
  requirementChat?: RequirementChatReader
  dima?: DimaGateway
  now?: () => Date
}

export class LuckyTagService {
  private readonly runtimeFolder: string
  private readonly onUpdate: ((snapshot: DashboardSnapshot) => void) | undefined
  private readonly now: () => Date
  private readonly database: SqliteDatabase
  private readonly configStore: JsonStore<AppConfig>
  private readonly stateStore: JsonStore<CoreStateFile>
  private readonly knowledgeStore: JsonStore<KnowledgeSnapshotFile>
  private readonly dws: LuckyTagDwsClient
  private readonly yuque: YuqueClient
  private readonly openauth: LuckyTagOpenAuthClient
  private readonly synchronizer: KnowledgeSynchronizer
  private readonly dimaRequirements: DimaRequirementWorkflow
  private readonly worker: WorkerEngine
  private index = new KnowledgeIndex([])
  private currentConfig: AppConfig = structuredClone(DEFAULT_CONFIG)
  private initialized = false
  private shutdownPromise: Promise<void> | undefined
  private updateGeneration = 0
  private connections: ConnectionStatus[] = initialConnections()
  private readonly connectionGenerations: Record<ProbedConnectionKind, number> = {
    dingtalk: 0,
    yuque: 0,
    openauth: 0
  }

  constructor(options: LuckyTagServiceOptions) {
    if (!options.dataRoot.trim()) throw new Error('LuckyTag dataRoot 不能为空')
    this.runtimeFolder = join(options.dataRoot, 'runtime')
    this.onUpdate = options.onUpdate
    this.now = options.now ?? (() => new Date())
    const runner = options.runner ?? new CliRunner()
    this.dws = options.dws ?? new DwsAdapter(runner)
    this.yuque = options.yuque ?? new YuqueAdapter(runner)
    this.openauth = options.openauth ?? new OpenAuthCliAdapter()
    this.dimaRequirements = new DimaRequirementWorkflow({
      chat: options.requirementChat ?? new DwsRequirementAdapter(runner),
      dima: options.dima ?? new DimaAdapter(runner),
      now: this.now
    })
    const instanceId = randomUUID()

    this.database = new SqliteDatabase({
      filePath: join(this.runtimeFolder, 'luckytag.sqlite3'),
      now: this.now
    })
    this.configStore = new SqliteJsonStore({
      database: this.database,
      documentKey: 'config',
      legacyFilePath: join(this.runtimeFolder, 'config.json'),
      createDefault: () => structuredClone(DEFAULT_CONFIG),
      validate: isAppConfig,
      migrate: migrateAppConfig
    })
    this.stateStore = new SqliteCoreStateStore({
      database: this.database,
      legacyFilePath: join(this.runtimeFolder, 'state.json'),
      createDefault: () => createCoreState(instanceId),
      validate: isCoreStateFile
    })
    this.knowledgeStore = new SqliteJsonStore({
      database: this.database,
      documentKey: 'knowledge',
      legacyFilePath: join(this.runtimeFolder, 'knowledge', 'snapshot.json'),
      createDefault: () => structuredClone(EMPTY_KNOWLEDGE_SNAPSHOT),
      validate: isKnowledgeSnapshotFile
    })
    this.synchronizer = new KnowledgeSynchronizer(this.knowledgeStore, this.yuque, this.now)
    this.worker = new WorkerEngine({
      stateStore: this.stateStore,
      dws: this.dws,
      getConfig: () => this.configStore.read(),
      getCurrentConfig: () => this.currentConfig,
      getIndex: () => this.index,
      now: this.now,
      instanceId,
      onUpdate: () => {
        void this.emitUpdate()
      }
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const knowledgeFolder = join(this.runtimeFolder, 'knowledge')
    await mkdir(knowledgeFolder, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      await Promise.all([chmod(this.runtimeFolder, 0o700), chmod(knowledgeFolder, 0o700)])
    }
    const [config, snapshot] = await Promise.all([
      this.configStore.read(),
      this.knowledgeStore.read()
    ])
    this.currentConfig = structuredClone(config)
    this.dws.setAllowlistedGroups(
      config.replyPolicy.enabled
        ? config.groups.filter((group) => group.enabled).map((group) => group.id)
        : []
    )
    this.index = new KnowledgeIndex(filterKnowledgeSnapshot(snapshot, config))
    await this.worker.initialize()
    this.initialized = true
    await this.emitUpdate()
  }

  async getSnapshot(): Promise<DashboardSnapshot> {
    await this.ensureInitialized()
    const [config, storedKnowledge, runtime, persistedReplies] = await Promise.all([
      this.configStore.read(),
      this.knowledgeStore.read(),
      this.worker.getRuntimeStatus(),
      this.worker.getRecentReplies(100)
    ])
    const knowledge = filterKnowledgeSnapshot(storedKnowledge, config)
    const recentReplies: ReplyRecord[] = persistedReplies.map((reply) => stripInternalReplyFields(reply))
    return {
      config,
      connections: structuredClone(this.connections),
      knowledge: {
        documentCount: knowledge.documents.length,
        chunkCount: knowledge.chunks.length,
        ...(knowledge.generatedAt ? { lastSyncedAt: knowledge.generatedAt } : {}),
        sourceErrors: structuredClone(knowledge.sourceErrors)
      },
      runtime,
      recentReplies
    }
  }

  async saveConfig(value: AppConfig): Promise<DashboardSnapshot> {
    await this.ensureInitialized()
    const config = assertAppConfig(value)
    const previous = await this.configStore.read()
    const previouslyEnabledGroups = new Set(
      previous.groups.filter((group) => group.enabled).map((group) => group.id)
    )
    const newlyEnabledGroups = config.groups
      .filter((group) => group.enabled && !previouslyEnabledGroups.has(group.id))
      .map((group) => group.id)
    if (newlyEnabledGroups.length > 0) {
      const reset = new Set(newlyEnabledGroups)
      await this.stateStore.update((state) => ({
        ...state,
        initializedGroups: state.initializedGroups.filter((groupId) => !reset.has(groupId)),
        replies: state.replies.map((reply) => {
          if (
            !reset.has(reply.groupId) ||
            (reply.status !== 'pending' && reply.status !== 'sending')
          ) return reply
          const { leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = reply
          return {
            ...withoutLease,
            status: 'needs_manual',
            reason: '群聊已重新授权；为避免处理停用期间的历史消息，未完成记录已转交人工',
            updatedAt: this.now().toISOString()
          }
        })
      }))
    }

    const priorCurrentConfig = this.currentConfig
    const priorIndex = this.index
    const knowledgeSourcesChanged =
      JSON.stringify(previous.knowledgeSources) !== JSON.stringify(config.knowledgeSources)
    this.currentConfig = structuredClone(config)
    // The synchronous config view is used by the Worker's final pre-send guard.
    // If source authorization changed, fail closed immediately while persistence and
    // index reconstruction are still in flight so old evidence cannot be sent.
    if (knowledgeSourcesChanged) this.index = new KnowledgeIndex([])
    try {
      await this.configStore.write(config)
    } catch (error) {
      this.currentConfig = priorCurrentConfig
      if (knowledgeSourcesChanged) this.index = priorIndex
      throw error
    }
    this.dws.setAllowlistedGroups(
      config.replyPolicy.enabled
        ? config.groups.filter((group) => group.enabled).map((group) => group.id)
        : []
    )
    const storedKnowledge = await this.knowledgeStore.read()
    const configuredSourceIds = new Set(config.knowledgeSources.map((source) => source.id))
    const prunedKnowledge = selectKnowledgeSources(storedKnowledge, configuredSourceIds)
    if (
      prunedKnowledge.documents.length !== storedKnowledge.documents.length ||
      prunedKnowledge.chunks.length !== storedKnowledge.chunks.length ||
      prunedKnowledge.sourceErrors.length !== storedKnowledge.sourceErrors.length
    ) {
      await this.knowledgeStore.write(prunedKnowledge)
    }
    this.index = new KnowledgeIndex(filterKnowledgeSnapshot(prunedKnowledge, config))
    const enabledGroupCount = config.groups.filter((group) => group.enabled).length
    if (
      previous.replyPolicy.enabled &&
      (!config.replyPolicy.enabled || enabledGroupCount === 0)
    ) {
      await this.worker.stop()
    } else if (
      previous.replyPolicy.pollIntervalSeconds !== config.replyPolicy.pollIntervalSeconds
    ) {
      await this.worker.reschedule()
    }
    await this.emitUpdate()
    return this.getSnapshot()
  }

  async syncKnowledge(): Promise<SyncSummary> {
    await this.ensureInitialized()
    const config = await this.configStore.read()
    const summary = await this.synchronizer.sync(config.knowledgeSources)
    const latestConfig = await this.configStore.read()
    this.currentConfig = structuredClone(latestConfig)
    const storedKnowledge = await this.knowledgeStore.read()
    const configuredSourceIds = new Set(latestConfig.knowledgeSources.map((source) => source.id))
    const retainedKnowledge = selectKnowledgeSources(storedKnowledge, configuredSourceIds)
    if (
      retainedKnowledge.documents.length !== storedKnowledge.documents.length ||
      retainedKnowledge.chunks.length !== storedKnowledge.chunks.length ||
      retainedKnowledge.sourceErrors.length !== storedKnowledge.sourceErrors.length
    ) {
      await this.knowledgeStore.write(retainedKnowledge)
    }
    const activeKnowledge = filterKnowledgeSnapshot(retainedKnowledge, latestConfig)
    this.index = new KnowledgeIndex(activeKnowledge)
    await this.emitUpdate()
    return {
      ...summary,
      documentCount: activeKnowledge.documents.length,
      chunkCount: activeKnowledge.chunks.length,
      sourceErrors: structuredClone(activeKnowledge.sourceErrors)
    }
  }

  async probeConnections(): Promise<ConnectionStatus[]> {
    await this.ensureInitialized()
    const checkingAt = this.now().toISOString()
    const generations = {
      dingtalk: this.beginConnectionOperation('dingtalk'),
      yuque: this.beginConnectionOperation('yuque'),
      openauth: this.beginConnectionOperation('openauth')
    }
    this.connections = this.connections.map((connection) =>
      connection.kind === 'dingtalk' ||
      connection.kind === 'yuque' ||
      connection.kind === 'openauth'
        ? { ...connection, state: 'checking', detail: '正在检查本地 CLI…', checkedAt: checkingAt }
        : connection
    )
    await this.emitUpdate()

    const [dingtalk, yuque, openauth] = await Promise.all([
      this.probeDingtalk(),
      this.probeYuque(),
      this.probeOpenAuth()
    ])
    this.replaceConnectionIfCurrent(dingtalk, generations.dingtalk)
    this.replaceConnectionIfCurrent(yuque, generations.yuque)
    this.replaceConnectionIfCurrent(openauth, generations.openauth)
    await this.emitUpdate()
    return structuredClone(this.connections)
  }

  async authenticate(kind: 'dingtalk' | 'yuque' | 'openauth'): Promise<ConnectionStatus> {
    await this.ensureInitialized()
    const generation = this.beginConnectionOperation(kind)
    const label =
      kind === 'dingtalk' ? '钉钉 DWS' : kind === 'yuque' ? '语雀 CLI' : 'OpenAuth'
    this.replaceConnection({
      kind,
      state: 'checking',
      label,
      detail: kind === 'openauth' ? '正在等待统一身份认证…' : '正在等待本地 CLI 认证…',
      checkedAt: this.now().toISOString()
    })
    await this.emitUpdate()

    try {
      if (kind === 'openauth') {
        const status = await this.openauth.authenticate()
        if (!status.authenticated) {
          throw Object.assign(new Error('OpenAuth 认证未成功'), {
            code: 'AUTHENTICATION_NOT_CONFIRMED'
          })
        }
        const connection = openAuthConnection(status, this.now().toISOString())
        this.replaceConnectionIfCurrent(connection, generation)
        await this.emitUpdate()
        return this.connectionFor(kind)
      }

      const status =
        kind === 'dingtalk' ? await this.dws.authenticate() : await this.yuque.authenticate()
      if (!status.authenticated) {
        throw Object.assign(new Error(`${kind === 'dingtalk' ? '钉钉 DWS' : '语雀'}认证未成功：${status.detail}`), {
          code: 'AUTHENTICATION_NOT_CONFIRMED'
        })
      }
      const connection = authConnection(kind, status, this.now().toISOString())
      this.replaceConnectionIfCurrent(connection, generation)
      await this.emitUpdate()
      return this.connectionFor(kind)
    } catch (error) {
      this.replaceConnectionIfCurrent(
        kind === 'openauth'
          ? failedOpenAuthConnection(error, this.now().toISOString(), 'authenticate')
          : failedConnection(kind, label, error, this.now().toISOString()),
        generation
      )
      await this.emitUpdate()
      throw error
    }
  }

  async disconnectOpenAuth(): Promise<DashboardSnapshot> {
    await this.ensureInitialized()
    const generation = this.beginConnectionOperation('openauth')
    this.replaceConnection({
      kind: 'openauth',
      state: 'checking',
      label: 'OpenAuth',
      detail: '正在退出统一身份并清理 OpenAuth 会话…',
      checkedAt: this.now().toISOString()
    })
    await this.emitUpdate()

    try {
      await this.openauth.logout()
      this.replaceConnectionIfCurrent({
        kind: 'openauth',
        state: 'disconnected',
        label: 'OpenAuth',
        detail: '统一身份已退出；OpenAuth 本地技能会话已清理',
        checkedAt: this.now().toISOString()
      }, generation)
      await this.emitUpdate()
      return this.getSnapshot()
    } catch (error) {
      this.replaceConnectionIfCurrent(
        failedOpenAuthConnection(error, this.now().toISOString(), 'authenticate'),
        generation
      )
      await this.emitUpdate()
      throw error
    }
  }

  async startWorker(): Promise<RuntimeStatus> {
    await this.ensureInitialized()
    const status = await this.worker.start()
    await this.emitUpdate()
    return status
  }

  async stopWorker(): Promise<RuntimeStatus> {
    await this.ensureInitialized()
    const status = await this.worker.stop()
    await this.emitUpdate()
    return status
  }

  async runOnce(): Promise<RunSummary> {
    await this.ensureInitialized()
    const summary = await this.worker.runOnce()
    await this.emitUpdate()
    return summary
  }

  /** Stops durable work before releasing the daemon-owned SQLite connection. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  async previewDimaRequirement(input: DimaRequirementInput): Promise<DimaRequirementPreview> {
    await this.ensureInitialized()
    return this.dimaRequirements.previewRequirement(input)
  }

  async createDimaRequirement(input: DimaRequirementCreateInput): Promise<DimaRequirementResult> {
    await this.ensureInitialized()
    return this.dimaRequirements.createRequirement(input)
  }

  getRuntimeFolder(): string {
    return this.runtimeFolder
  }

  private async performShutdown(): Promise<void> {
    try {
      if (this.initialized) await this.worker.suspendForShutdown()
    } finally {
      this.initialized = false
      await this.database.close()
    }
  }

  private async probeDingtalk(): Promise<ConnectionStatus> {
    try {
      return authConnection('dingtalk', await this.dws.probe(), this.now().toISOString())
    } catch (error) {
      return failedConnection('dingtalk', '钉钉 DWS', error, this.now().toISOString())
    }
  }

  private async probeYuque(): Promise<ConnectionStatus> {
    try {
      return authConnection('yuque', await this.yuque.probe(), this.now().toISOString())
    } catch (error) {
      return failedConnection('yuque', '语雀 CLI', error, this.now().toISOString())
    }
  }

  private async probeOpenAuth(): Promise<ConnectionStatus> {
    try {
      return openAuthConnection(await this.openauth.probe(), this.now().toISOString())
    } catch (error) {
      return failedOpenAuthConnection(error, this.now().toISOString(), 'probe')
    }
  }

  private replaceConnection(status: ConnectionStatus): void {
    this.connections = this.connections.map((connection) =>
      connection.kind === status.kind ? status : connection
    )
  }

  private beginConnectionOperation(kind: ProbedConnectionKind): number {
    this.connectionGenerations[kind] += 1
    return this.connectionGenerations[kind]
  }

  private replaceConnectionIfCurrent(status: ConnectionStatus, generation: number): void {
    if (
      status.kind === 'ding-a1' ||
      this.connectionGenerations[status.kind] !== generation
    ) return
    this.replaceConnection(status)
  }

  private connectionFor(kind: ProbedConnectionKind): ConnectionStatus {
    const connection = this.connections.find((item) => item.kind === kind)
    if (!connection) throw new Error(`找不到连接状态：${kind}`)
    return structuredClone(connection)
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }

  private async emitUpdate(): Promise<void> {
    if (!this.initialized || !this.onUpdate) return
    const generation = ++this.updateGeneration
    try {
      const snapshot = await this.getSnapshot()
      if (generation !== this.updateGeneration) return
      this.onUpdate(snapshot)
    } catch {
      // UI listeners must never break persistence or worker processing.
    }
  }
}

const initialConnections = (): ConnectionStatus[] => [
  {
    kind: 'dingtalk',
    state: 'disconnected',
    label: '钉钉 DWS',
    detail: '尚未检查认证状态'
  },
  {
    kind: 'yuque',
    state: 'disconnected',
    label: '语雀 CLI',
    detail: '尚未检查认证状态'
  },
  {
    kind: 'openauth',
    state: 'disconnected',
    label: 'OpenAuth',
    detail: '尚未检查统一身份状态'
  },
  {
    kind: 'ding-a1',
    state: 'unavailable',
    label: '钉 A1',
    detail: '一期预留，尚未启用'
  }
]

const authConnection = (
  kind: 'dingtalk' | 'yuque',
  status: YuqueAuthStatus,
  checkedAt: string
): ConnectionStatus => ({
  kind,
  state: status.authenticated === true ? 'connected' : 'disconnected',
  label: kind === 'dingtalk' ? '钉钉 DWS' : '语雀 CLI',
  detail: status.detail,
  checkedAt,
  ...(status.version ? { version: status.version } : {})
})

const failedConnection = (
  kind: ConnectionKind,
  label: string,
  error: unknown,
  checkedAt: string
): ConnectionStatus => {
  const missingBinary = error instanceof CliExecutionError && error.exitCode === 'ENOENT'
  const message = errorMessage(error)
  const authenticationFailure =
    /auth|login|token|401|403|认证|登录|授权|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH/iu.test(message)
  return {
    kind,
    state: missingBinary ? 'unavailable' : authenticationFailure ? 'disconnected' : 'unavailable',
    label,
    detail: message,
    checkedAt
  }
}

const openAuthConnection = (
  status: OpenAuthSessionView,
  checkedAt: string
): ConnectionStatus => {
  if (!status.authenticated) {
    return {
      kind: 'openauth',
      state: 'disconnected',
      label: 'OpenAuth',
      detail: '尚未登录蚂蚁统一身份',
      checkedAt
    }
  }

  const identity =
    status.displayName && status.employeeNumber
      ? `${status.displayName}（${status.employeeNumber}）`
      : (status.displayName ?? status.employeeNumber ?? '身份已验证')
  const expiry = status.expiresAt
    ? `，IAM 身份有效至 ${new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false })}`
    : ''

  return {
    kind: 'openauth',
    state: 'connected',
    label: 'OpenAuth',
    detail: `已连接：${identity}${expiry}`,
    checkedAt
  }
}

const failedOpenAuthConnection = (
  error: unknown,
  checkedAt: string,
  phase: 'probe' | 'authenticate'
): ConnectionStatus => {
  const unavailable =
    phase === 'probe' ||
    (error instanceof OpenAuthCliError &&
      (error.code === 'OPENAUTH_UNAVAILABLE' || error.code === 'OPENAUTH_PROTOCOL'))
  return {
    kind: 'openauth',
    state: unavailable ? 'unavailable' : 'disconnected',
    label: 'OpenAuth',
    detail: errorMessage(error),
    checkedAt
  }
}

const stripInternalReplyFields = (reply: CoreStateFile['replies'][number]): ReplyRecord => {
  const {
    attemptCount: _attemptCount,
    idempotencyUuid: _idempotencyUuid,
    senderId: _senderId,
    followUpClosedAt: _followUpClosedAt,
    followUpCloseReason: _followUpCloseReason,
    ...publicRecord
  } = reply
  return publicRecord
}

const filterKnowledgeSnapshot = (
  snapshot: KnowledgeSnapshotFile,
  config: AppConfig
): KnowledgeSnapshotFile => {
  const enabledSourceIds = new Set(
    config.knowledgeSources.filter((source) => source.enabled).map((source) => source.id)
  )
  return selectKnowledgeSources(snapshot, enabledSourceIds)
}

const selectKnowledgeSources = (
  snapshot: KnowledgeSnapshotFile,
  sourceIds: ReadonlySet<string>
): KnowledgeSnapshotFile => {
  const documents = snapshot.documents.filter((document) => sourceIds.has(document.sourceId))
  const documentIds = new Set(documents.map((document) => document.id))
  return {
    ...snapshot,
    documents,
    chunks: snapshot.chunks.filter(
      (chunk) => sourceIds.has(chunk.sourceId) && documentIds.has(chunk.documentId)
    ),
    sourceErrors: snapshot.sourceErrors.filter((error) => sourceIds.has(error.sourceId))
  }
}

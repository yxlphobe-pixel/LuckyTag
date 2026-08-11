import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig, DashboardSnapshot } from '../../src/shared/contracts'
import {
  LuckyTagService,
  type LuckyTagDwsClient,
  type LuckyTagOpenAuthClient
} from '../../src/main/core/service'
import type {
  DwsMentionPage,
  DwsMessage,
  DwsSendResult,
  YuqueAuthStatus,
  YuqueClient,
  YuqueDocument
} from '../../src/main/core/types'
import { OpenAuthCliError, type OpenAuthSessionView } from '../../src/main/identity/contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

class FakeDws implements LuckyTagDwsClient {
  allowlist = new Set<string>()
  mentions: DwsMessage[] = []
  history: DwsMessage[] = []
  sendCalls = 0
  setAllowlistedGroups(groupIds: Iterable<string>): void {
    this.allowlist = new Set(groupIds)
  }
  async probe(): Promise<YuqueAuthStatus> {
    return { authenticated: false, detail: 'DWS 未登录' }
  }
  async authenticate(): Promise<YuqueAuthStatus> {
    return { authenticated: true, detail: 'DWS 已登录' }
  }
  async listMentions(input: { groupId: string }): Promise<DwsMentionPage> {
    return {
      messages: this.mentions.filter((message) => message.groupId === input.groupId),
      hasMore: false
    }
  }
  async listConversationMessages(input: { groupId: string }): Promise<DwsMessage[]> {
    return this.history.filter((message) => message.groupId === input.groupId)
  }
  async sendMessage(): Promise<DwsSendResult> {
    this.sendCalls += 1
    return { deduplicated: false, platformTaskId: `task-${this.sendCalls}` }
  }
}

class FakeYuque implements YuqueClient {
  async probe(): Promise<YuqueAuthStatus> {
    return { authenticated: false, detail: '语雀未登录' }
  }
  async authenticate(): Promise<YuqueAuthStatus> {
    return { authenticated: true, detail: '语雀已登录' }
  }
  async resolve(input: string): Promise<string> {
    return input
  }
  async listDocuments(): Promise<Array<{ route: string; title?: string }>> {
    return []
  }
  async showDocument(route: string): Promise<YuqueDocument> {
    return { route, title: route, body: 'test' }
  }
}

class FakeOpenAuth implements LuckyTagOpenAuthClient {
  probeResult: OpenAuthSessionView = { authenticated: false }
  authenticateResult: OpenAuthSessionView = { authenticated: false }
  probeError: unknown
  authenticateError: unknown
  logoutError: unknown
  probeCalls = 0
  authenticateCalls = 0
  logoutCalls = 0
  probeHandler: (() => Promise<OpenAuthSessionView>) | undefined

  async probe(): Promise<OpenAuthSessionView> {
    this.probeCalls += 1
    if (this.probeHandler) return this.probeHandler()
    if (this.probeError) throw this.probeError
    return structuredClone(this.probeResult)
  }

  async authenticate(): Promise<OpenAuthSessionView> {
    this.authenticateCalls += 1
    if (this.authenticateError) throw this.authenticateError
    return structuredClone(this.authenticateResult)
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1
    if (this.logoutError) throw this.logoutError
  }
}

const createService = async (
  openauth: FakeOpenAuth,
  dws: FakeDws = new FakeDws(),
  onUpdate?: (snapshot: DashboardSnapshot) => void
): Promise<LuckyTagService> => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'luckytag-service-openauth-'))
  temporaryDirectories.push(dataRoot)
  const service = new LuckyTagService({
    dataRoot,
    dws,
    yuque: new FakeYuque(),
    openauth,
    now: () => new Date('2026-07-18T02:00:00.000Z'),
    ...(onUpdate ? { onUpdate } : {})
  })
  await service.initialize()
  return service
}

describe('LuckyTagService OpenAuth integration', () => {
  it('shuts down idempotently while preserving the daemon restart intent', async () => {
    const service = await createService(new FakeOpenAuth())
    const initial = await service.getSnapshot()
    await service.saveConfig({
      ...initial.config,
      groups: [{ id: 'group-1', label: '测试群', enabled: true }],
      replyPolicy: { ...initial.config.replyPolicy, enabled: true }
    })
    await service.startWorker()

    await expect(Promise.all([service.shutdown(), service.shutdown()])).resolves.toEqual([
      undefined,
      undefined
    ])

    const database = new DatabaseSync(join(service.getRuntimeFolder(), 'luckytag.sqlite3'), {
      readOnly: true
    })
    try {
      const row = database.prepare(`
        SELECT value_json FROM json_documents WHERE document_key = 'state'
      `).get() as unknown as { value_json: string }
      const state = JSON.parse(row.value_json) as { runtime: { running: boolean; processing: boolean } }
      expect(state.runtime).toMatchObject({ running: true, processing: false })
    } finally {
      database.close()
    }
  })

  it('probes OpenAuth with a renderer-safe identity projection', async () => {
    const openauth = new FakeOpenAuth()
    openauth.probeResult = {
      authenticated: true,
      displayName: 'Lucky',
      employeeNumber: '012345',
      expiresAt: '2026-07-19T02:00:00.000Z'
    }
    const service = await createService(openauth)

    const connections = await service.probeConnections()
    const identity = connections.find((connection) => connection.kind === 'openauth')

    expect(identity).toMatchObject({
      state: 'connected',
      label: 'OpenAuth'
    })
    expect(identity?.detail).toContain('Lucky（012345）')
    expect(openauth.probeCalls).toBe(1)
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(/accessToken|ssoTicket/iu)
  })

  it('authenticates through only the narrow OpenAuth client', async () => {
    const openauth = new FakeOpenAuth()
    openauth.authenticateResult = {
      authenticated: true,
      displayName: 'Lucky',
      employeeNumber: '012345',
      subject: 'iam:person:012345'
    }
    const service = await createService(openauth)

    await expect(service.authenticate('openauth')).resolves.toMatchObject({
      kind: 'openauth',
      state: 'connected'
    })
    expect(openauth.authenticateCalls).toBe(1)
  })

  it('does not let an older probe overwrite a newer successful authentication', async () => {
    const openauth = new FakeOpenAuth()
    let resolveProbe: ((value: OpenAuthSessionView) => void) | undefined
    let markProbeStarted: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    openauth.probeHandler = () => new Promise<OpenAuthSessionView>((resolve) => {
      resolveProbe = resolve
      markProbeStarted?.()
    })
    openauth.authenticateResult = { authenticated: true, displayName: 'Lucky' }
    const service = await createService(openauth)

    const olderProbe = service.probeConnections()
    await probeStarted
    await expect(service.authenticate('openauth')).resolves.toMatchObject({ state: 'connected' })
    resolveProbe?.({ authenticated: false })
    await olderProbe

    expect(
      (await service.getSnapshot()).connections.find((item) => item.kind === 'openauth')
    ).toMatchObject({ state: 'connected' })
  })

  it('does not broadcast an older snapshot after a newer snapshot has completed', async () => {
    const updates: DashboardSnapshot[] = []
    const service = await createService(new FakeOpenAuth(), new FakeDws(), (snapshot) => {
      updates.push(snapshot)
    })
    updates.length = 0
    const baseline = await service.getSnapshot()
    let releaseOld: (() => void) | undefined
    let markOldStarted: (() => void) | undefined
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve
    })
    let snapshotCall = 0
    Object.defineProperty(service, 'getSnapshot', {
      configurable: true,
      value: async (): Promise<DashboardSnapshot> => {
        snapshotCall += 1
        if (snapshotCall === 1) {
          markOldStarted?.()
          await oldGate
          return {
            ...baseline,
            runtime: { ...baseline.runtime, lastError: '旧快照' }
          }
        }
        return {
          ...baseline,
          runtime: { ...baseline.runtime, lastError: '新快照' }
        }
      }
    })
    const emitter = service as unknown as { emitUpdate(): Promise<void> }

    const oldEmission = emitter.emitUpdate()
    await oldStarted
    await emitter.emitUpdate()
    releaseOld?.()
    await oldEmission

    expect(updates.map((snapshot) => snapshot.runtime.lastError)).toEqual(['新快照'])
  })

  it('fails closed when the OpenAuth CLI is unavailable', async () => {
    const openauth = new FakeOpenAuth()
    openauth.authenticateError = new OpenAuthCliError(
      'OPENAUTH_UNAVAILABLE',
      '未找到 OpenAuth CLI'
    )
    const service = await createService(openauth)

    await expect(service.authenticate('openauth')).rejects.toMatchObject({
      code: 'OPENAUTH_UNAVAILABLE'
    })
    const connection = (await service.getSnapshot()).connections.find(
      (item) => item.kind === 'openauth'
    )
    expect(connection).toMatchObject({ state: 'unavailable' })
  })

  it('logs out through OpenAuth and returns a disconnected dashboard snapshot', async () => {
    const openauth = new FakeOpenAuth()
    openauth.authenticateResult = { authenticated: true, displayName: 'Lucky' }
    const service = await createService(openauth)
    await service.authenticate('openauth')

    const snapshot = await service.disconnectOpenAuth()

    expect(openauth.logoutCalls).toBe(1)
    expect(snapshot.connections.find((item) => item.kind === 'openauth')).toMatchObject({
      state: 'disconnected'
    })
  })

  it('removes a disabled knowledge source from active stats immediately without another sync', async () => {
    const openauth = new FakeOpenAuth()
    const service = await createService(openauth)
    const sourceRoot = await mkdtemp(join(tmpdir(), 'luckytag-disabled-source-'))
    temporaryDirectories.push(sourceRoot)
    await mkdir(join(sourceRoot, 'docs'))
    await writeFile(join(sourceRoot, 'docs', 'secret.md'), '# 资料\n\n仅用于来源停用测试。', 'utf8')
    const initial = await service.getSnapshot()
    const source = {
      id: 'local-source',
      type: 'local-directory' as const,
      label: '本地测试',
      path: join(sourceRoot, 'docs'),
      enabled: true
    }
    await service.saveConfig({
      ...initial.config,
      knowledgeSources: [source]
    })
    await service.syncKnowledge()
    expect((await service.getSnapshot()).knowledge.documentCount).toBe(1)

    await service.saveConfig({
      ...(await service.getSnapshot()).config,
      knowledgeSources: [{ ...source, enabled: false }]
    })

    expect((await service.getSnapshot()).knowledge).toMatchObject({
      documentCount: 0,
      chunkCount: 0
    })
  })

  it('fails closed while a knowledge-source authorization change is being persisted', async () => {
    const dws = new FakeDws()
    const service = await createService(new FakeOpenAuth(), dws)
    const sourceRoot = await mkdtemp(join(tmpdir(), 'luckytag-source-race-'))
    temporaryDirectories.push(sourceRoot)
    await writeFile(
      join(sourceRoot, 'secret.md'),
      '# 配置资料\n\n钉钉自动回复必须先配置群白名单，并开启预演模式验证。',
      'utf8'
    )
    const initial = await service.getSnapshot()
    const source = {
      id: 'race-source',
      type: 'local-directory' as const,
      label: '并发测试来源',
      path: sourceRoot,
      enabled: true
    }
    await service.saveConfig({
      ...initial.config,
      knowledgeSources: [source],
      groups: [{ id: 'group-1', label: '测试群', enabled: true }],
      replyPolicy: {
        ...initial.config.replyPolicy,
        enabled: true,
        dryRun: false,
        markExistingIgnored: false,
        confidenceThreshold: 0.1
      }
    })
    await service.syncKnowledge()
    const question: DwsMessage = {
      id: 'source-race-message',
      groupId: 'group-1',
      text: '钉钉自动回复怎么配置？',
      createdAt: '2026-07-18T01:59:50.000Z',
      recalled: false,
      isSelf: false,
      senderId: 'user-1'
    }
    dws.mentions = [question]
    dws.history = [question]

    const internal = service as unknown as {
      configStore: { write(value: AppConfig): Promise<void> }
    }
    const originalWrite = internal.configStore.write.bind(internal.configStore)
    let releaseWrite: (() => void) | undefined
    let markWriteStarted: (() => void) | undefined
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    internal.configStore.write = async (value: AppConfig): Promise<void> => {
      markWriteStarted?.()
      await writeGate
      return originalWrite(value)
    }

    const disabling = service.saveConfig({
      ...(await service.getSnapshot()).config,
      knowledgeSources: [{ ...source, enabled: false }]
    })
    await writeStarted
    const summary = await service.runOnce()
    releaseWrite?.()
    await disabling

    expect(summary).toMatchObject({ sent: 0, needsManual: 1 })
    expect(dws.sendCalls).toBe(0)
  })

  it('reschedules a running worker after the polling interval changes', async () => {
    const openauth = new FakeOpenAuth()
    const service = await createService(openauth)
    const initial = await service.getSnapshot()
    await service.saveConfig({
      ...initial.config,
      groups: [{ id: 'group-1', label: '测试群', enabled: true }],
      replyPolicy: {
        ...initial.config.replyPolicy,
        enabled: true,
        pollIntervalSeconds: 300
      }
    })
    await service.startWorker()

    await service.saveConfig({
      ...(await service.getSnapshot()).config,
      replyPolicy: {
        ...(await service.getSnapshot()).config.replyPolicy,
        pollIntervalSeconds: 60
      }
    })

    expect((await service.getSnapshot()).runtime.nextRunAt).toBe('2026-07-18T02:01:00.000Z')
    await service.stopWorker()
  })

  it('re-establishes the first-scan safety baseline when a group is re-enabled', async () => {
    const openauth = new FakeOpenAuth()
    const dws = new FakeDws()
    const service = await createService(openauth, dws)
    const initial = await service.getSnapshot()
    const enabledConfig = {
      ...initial.config,
      groups: [{ id: 'group-1', label: '测试群', enabled: true }],
      replyPolicy: {
        ...initial.config.replyPolicy,
        enabled: true,
        dryRun: true,
        markExistingIgnored: true
      }
    }
    await service.saveConfig(enabledConfig)
    await service.runOnce()
    await service.saveConfig({
      ...enabledConfig,
      groups: [{ id: 'group-1', label: '测试群', enabled: false }]
    })
    const oldMention: DwsMessage = {
      id: 'disabled-period-message',
      groupId: 'group-1',
      text: '停用期间的问题',
      createdAt: '2026-07-18T01:59:00.000Z',
      recalled: false,
      isSelf: false,
      senderId: 'user-1'
    }
    dws.mentions = [oldMention]
    dws.history = [oldMention]
    await service.saveConfig(enabledConfig)

    const summary = await service.runOnce()

    expect(summary).toMatchObject({ ignored: 1, sent: 0, previews: 0 })
    expect(dws.sendCalls).toBe(0)
    expect((await service.getSnapshot()).recentReplies[0]?.reason).toContain('首次运行安全策略')
  })
})

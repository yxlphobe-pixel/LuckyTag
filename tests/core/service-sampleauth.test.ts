import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig, DashboardSnapshot } from '../../src/shared/contracts'
import {
  LuckyTagService,
  type LuckyTagDemoMessageClient,
  type LuckyTagSampleAuthClient
} from '../../src/main/core/service'
import type {
  DemoMessageMentionPage,
  DemoMessageMessage,
  DemoMessageSendResult,
  SampleLibraryAuthStatus,
  SampleLibraryClient,
  SampleLibraryDocument
} from '../../src/main/core/types'
import { SampleAuthCliError, type SampleAuthSessionView } from '../../src/main/identity/contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

class FakeDemoMessage implements LuckyTagDemoMessageClient {
  allowlist = new Set<string>()
  mentions: DemoMessageMessage[] = []
  history: DemoMessageMessage[] = []
  sendCalls = 0
  setAllowlistedGroups(groupIds: Iterable<string>): void {
    this.allowlist = new Set(groupIds)
  }
  async probe(): Promise<SampleLibraryAuthStatus> {
    return { authenticated: false, detail: 'DEMO_MESSAGE 未登录' }
  }
  async authenticate(): Promise<SampleLibraryAuthStatus> {
    return { authenticated: true, detail: 'DEMO_MESSAGE 已登录' }
  }
  async listMentions(input: { groupId: string }): Promise<DemoMessageMentionPage> {
    return {
      messages: this.mentions.filter((message) => message.groupId === input.groupId),
      hasMore: false
    }
  }
  async listConversationMessages(input: { groupId: string }): Promise<DemoMessageMessage[]> {
    return this.history.filter((message) => message.groupId === input.groupId)
  }
  async sendMessage(): Promise<DemoMessageSendResult> {
    this.sendCalls += 1
    return { deduplicated: false, platformTaskId: `task-${this.sendCalls}` }
  }
}

class FakeSampleLibrary implements SampleLibraryClient {
  async probe(): Promise<SampleLibraryAuthStatus> {
    return { authenticated: false, detail: '示例知识库未登录' }
  }
  async authenticate(): Promise<SampleLibraryAuthStatus> {
    return { authenticated: true, detail: '示例知识库已登录' }
  }
  async resolve(input: string): Promise<string> {
    return input
  }
  async listDocuments(): Promise<Array<{ route: string; title?: string }>> {
    return []
  }
  async showDocument(route: string): Promise<SampleLibraryDocument> {
    return { route, title: route, body: 'test' }
  }
}

class FakeSampleAuth implements LuckyTagSampleAuthClient {
  probeResult: SampleAuthSessionView = { authenticated: false }
  authenticateResult: SampleAuthSessionView = { authenticated: false }
  probeError: unknown
  authenticateError: unknown
  logoutError: unknown
  probeCalls = 0
  authenticateCalls = 0
  logoutCalls = 0
  probeHandler: (() => Promise<SampleAuthSessionView>) | undefined

  async probe(): Promise<SampleAuthSessionView> {
    this.probeCalls += 1
    if (this.probeHandler) return this.probeHandler()
    if (this.probeError) throw this.probeError
    return structuredClone(this.probeResult)
  }

  async authenticate(): Promise<SampleAuthSessionView> {
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
  sampleauth: FakeSampleAuth,
  demoMessage: FakeDemoMessage = new FakeDemoMessage(),
  onUpdate?: (snapshot: DashboardSnapshot) => void
): Promise<LuckyTagService> => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'luckytag-service-sampleauth-'))
  temporaryDirectories.push(dataRoot)
  const service = new LuckyTagService({
    dataRoot,
    demoMessage,
    sampleLibrary: new FakeSampleLibrary(),
    sampleauth,
    now: () => new Date('2026-07-18T02:00:00.000Z'),
    ...(onUpdate ? { onUpdate } : {})
  })
  await service.initialize()
  return service
}

describe('LuckyTagService SampleAuth integration', () => {
  it('shuts down idempotently while preserving the daemon restart intent', async () => {
    const service = await createService(new FakeSampleAuth())
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

  it('probes SampleAuth with a renderer-safe identity projection', async () => {
    const sampleauth = new FakeSampleAuth()
    sampleauth.probeResult = {
      authenticated: true,
      displayName: 'Lucky',
      accountNumber: '012345',
      expiresAt: '2026-07-19T02:00:00.000Z'
    }
    const service = await createService(sampleauth)

    const connections = await service.probeConnections()
    const identity = connections.find((connection) => connection.kind === 'sampleauth')

    expect(identity).toMatchObject({
      state: 'connected',
      label: 'SampleAuth'
    })
    expect(identity?.detail).toContain('Lucky（012345）')
    expect(sampleauth.probeCalls).toBe(1)
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(/accessToken|renewalToken/iu)
  })

  it('authenticates through only the narrow SampleAuth client', async () => {
    const sampleauth = new FakeSampleAuth()
    sampleauth.authenticateResult = {
      authenticated: true,
      displayName: 'Lucky',
      accountNumber: '012345',
      subject: 'sample:account:012345'
    }
    const service = await createService(sampleauth)

    await expect(service.authenticate('sampleauth')).resolves.toMatchObject({
      kind: 'sampleauth',
      state: 'connected'
    })
    expect(sampleauth.authenticateCalls).toBe(1)
  })

  it('does not let an older probe overwrite a newer successful authentication', async () => {
    const sampleauth = new FakeSampleAuth()
    let resolveProbe: ((value: SampleAuthSessionView) => void) | undefined
    let markProbeStarted: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    sampleauth.probeHandler = () => new Promise<SampleAuthSessionView>((resolve) => {
      resolveProbe = resolve
      markProbeStarted?.()
    })
    sampleauth.authenticateResult = { authenticated: true, displayName: 'Lucky' }
    const service = await createService(sampleauth)

    const olderProbe = service.probeConnections()
    await probeStarted
    await expect(service.authenticate('sampleauth')).resolves.toMatchObject({ state: 'connected' })
    resolveProbe?.({ authenticated: false })
    await olderProbe

    expect(
      (await service.getSnapshot()).connections.find((item) => item.kind === 'sampleauth')
    ).toMatchObject({ state: 'connected' })
  })

  it('does not broadcast an older snapshot after a newer snapshot has completed', async () => {
    const updates: DashboardSnapshot[] = []
    const service = await createService(new FakeSampleAuth(), new FakeDemoMessage(), (snapshot) => {
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

  it('fails closed when the SampleAuth CLI is unavailable', async () => {
    const sampleauth = new FakeSampleAuth()
    sampleauth.authenticateError = new SampleAuthCliError(
      'SAMPLE_AUTH_UNAVAILABLE',
      '未找到 SampleAuth CLI'
    )
    const service = await createService(sampleauth)

    await expect(service.authenticate('sampleauth')).rejects.toMatchObject({
      code: 'SAMPLE_AUTH_UNAVAILABLE'
    })
    const connection = (await service.getSnapshot()).connections.find(
      (item) => item.kind === 'sampleauth'
    )
    expect(connection).toMatchObject({ state: 'unavailable' })
  })

  it('logs out through SampleAuth and returns a disconnected dashboard snapshot', async () => {
    const sampleauth = new FakeSampleAuth()
    sampleauth.authenticateResult = { authenticated: true, displayName: 'Lucky' }
    const service = await createService(sampleauth)
    await service.authenticate('sampleauth')

    const snapshot = await service.disconnectSampleAuth()

    expect(sampleauth.logoutCalls).toBe(1)
    expect(snapshot.connections.find((item) => item.kind === 'sampleauth')).toMatchObject({
      state: 'disconnected'
    })
  })

  it('removes a disabled knowledge source from active stats immediately without another sync', async () => {
    const sampleauth = new FakeSampleAuth()
    const service = await createService(sampleauth)
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
    const demoMessage = new FakeDemoMessage()
    const service = await createService(new FakeSampleAuth(), demoMessage)
    const sourceRoot = await mkdtemp(join(tmpdir(), 'luckytag-source-race-'))
    temporaryDirectories.push(sourceRoot)
    await writeFile(
      join(sourceRoot, 'secret.md'),
      '# 配置资料\n\n示例消息自动回复必须先配置群白名单，并开启预演模式验证。',
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
    const question: DemoMessageMessage = {
      id: 'source-race-message',
      groupId: 'group-1',
      text: '示例消息自动回复怎么配置？',
      createdAt: '2026-07-18T01:59:50.000Z',
      recalled: false,
      isSelf: false,
      senderId: 'user-1'
    }
    demoMessage.mentions = [question]
    demoMessage.history = [question]

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
    expect(demoMessage.sendCalls).toBe(0)
  })

  it('reschedules a running worker after the polling interval changes', async () => {
    const sampleauth = new FakeSampleAuth()
    const service = await createService(sampleauth)
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
    const sampleauth = new FakeSampleAuth()
    const demoMessage = new FakeDemoMessage()
    const service = await createService(sampleauth, demoMessage)
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
    const oldMention: DemoMessageMessage = {
      id: 'disabled-period-message',
      groupId: 'group-1',
      text: '停用期间的问题',
      createdAt: '2026-07-18T01:59:00.000Z',
      recalled: false,
      isSelf: false,
      senderId: 'user-1'
    }
    demoMessage.mentions = [oldMention]
    demoMessage.history = [oldMention]
    await service.saveConfig(enabledConfig)

    const summary = await service.runOnce()

    expect(summary).toMatchObject({ ignored: 1, sent: 0, previews: 0 })
    expect(demoMessage.sendCalls).toBe(0)
    expect((await service.getSnapshot()).recentReplies[0]?.reason).toContain('首次运行安全策略')
  })
})

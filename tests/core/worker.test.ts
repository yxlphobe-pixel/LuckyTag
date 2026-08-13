import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig, type ReplyStatus } from '../../src/shared/contracts'
import { AtomicJsonStore } from '../../src/main/core/atomic-json-store'
import { KnowledgeIndex } from '../../src/main/core/retrieval'
import { createCoreState, isCoreStateFile } from '../../src/main/core/state'
import type {
  CoreStateFile,
  DemoMessageClient,
  DemoMessageMentionPage,
  DemoMessageMessage,
  DemoMessageSendResult,
  KnowledgeChunk,
  PersistedReplyRecord
} from '../../src/main/core/types'
import { WorkerEngine } from '../../src/main/core/worker'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeDemoMessage implements DemoMessageClient {
  allowlist = new Set<string>()
  mentions: DemoMessageMessage[] = []
  history: DemoMessageMessage[] = []
  historyResponses: DemoMessageMessage[][] = []
  historyCalls = 0
  onHistoryCall: ((callNumber: number) => void) | undefined
  sendCalls: Array<{ groupId: string; text: string; uuid: string }> = []
  failuresRemaining = 0

  setAllowlistedGroups(groupIds: Iterable<string>): void {
    this.allowlist = new Set(groupIds)
  }

  async listMentions(input: { groupId: string }): Promise<DemoMessageMentionPage> {
    if (!this.allowlist.has(input.groupId)) throw new Error('not allowlisted')
    return {
      messages: this.mentions.filter((message) => message.groupId === input.groupId),
      hasMore: false
    }
  }

  async listConversationMessages(input: { groupId: string }): Promise<DemoMessageMessage[]> {
    if (!this.allowlist.has(input.groupId)) throw new Error('not allowlisted')
    this.historyCalls += 1
    this.onHistoryCall?.(this.historyCalls)
    const selected = this.historyResponses.shift() ?? this.history
    return selected.filter((message) => message.groupId === input.groupId)
  }

  async sendMessage(input: { groupId: string; text: string; uuid: string }): Promise<DemoMessageSendResult> {
    this.sendCalls.push(input)
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('ambiguous network failure')
    }
    return { platformTaskId: `task-${this.sendCalls.length}`, deduplicated: this.sendCalls.length > 1 }
  }
}

const knowledgeChunks: KnowledgeChunk[] = [
  {
    id: 'chunk-1',
    documentId: 'doc-1',
    sourceId: 'source-1',
    sourceLabel: '配置手册',
    title: '示例消息自动回复配置',
    text: '示例消息自动回复必须先配置群白名单，并建议先开启 dry-run 观察预览。',
    position: 0
  }
]

const baseMessage = (overrides: Partial<DemoMessageMessage> = {}): DemoMessageMessage => ({
  id: 'msg-1',
  groupId: 'group-1',
  text: '示例消息自动回复怎么配置？',
  createdAt: '2026-07-17T02:00:00.000Z',
  recalled: false,
  isSelf: false,
  senderId: 'user-1',
  senderLabel: '小明',
  ...overrides
})

const persistedReply = (
  id: string,
  status: ReplyStatus,
  updatedAt: string,
  overrides: Partial<PersistedReplyRecord> = {}
): PersistedReplyRecord => ({
  id,
  messageId: `message-${id}`,
  groupId: 'retention-group',
  groupLabel: '保留策略测试群',
  question: `question-${id}`,
  status,
  createdAt: updatedAt,
  updatedAt,
  evidence: [],
  attemptCount: status === 'sending' ? 1 : 0,
  idempotencyUuid: `uuid-${id}`,
  ...overrides
})

const createHarness = async (overrides: Partial<AppConfig['replyPolicy']> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'luckytag-worker-'))
  temporaryDirectories.push(directory)
  let currentTime = new Date('2026-07-17T02:00:10.000Z')
  const config: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    groups: [{ id: 'group-1', label: '测试群', enabled: true }],
    replyPolicy: {
      ...structuredClone(DEFAULT_CONFIG.replyPolicy),
      enabled: true,
      dryRun: false,
      markExistingIgnored: false,
      confidenceThreshold: 0.1,
      ...overrides
    }
  }
  const store = new AtomicJsonStore<CoreStateFile>({
    filePath: join(directory, 'state.json'),
    createDefault: () => createCoreState('test-instance'),
    validate: isCoreStateFile
  })
  const demoMessage = new FakeDemoMessage()
  let currentKnowledgeChunks = knowledgeChunks
  const worker = new WorkerEngine({
    stateStore: store,
    demoMessage,
    getConfig: async () => structuredClone(config),
    getCurrentConfig: () => structuredClone(config),
    getIndex: () => new KnowledgeIndex(currentKnowledgeChunks),
    now: () => new Date(currentTime),
    instanceId: 'test-instance'
  })
  await worker.initialize()
  return {
    worker,
    store,
    demoMessage,
    config,
    setTime: (value: string) => {
      currentTime = new Date(value)
    },
    setKnowledgeChunks: (value: KnowledgeChunk[]) => {
      currentKnowledgeChunks = value
    }
  }
}

describe('WorkerEngine safety state machine', () => {
  it('serializes concurrent starts so only one polling timer is installed', async () => {
    const harness = await createHarness()
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')

    await Promise.all([harness.worker.start(), harness.worker.start()])

    expect(intervalSpy).toHaveBeenCalledTimes(1)
    await harness.worker.stop()
    expect((await harness.worker.getRuntimeStatus()).running).toBe(false)
  })

  it('serializes a stop racing with start and leaves the worker stopped', async () => {
    const harness = await createHarness()

    await Promise.all([harness.worker.start(), harness.worker.stop()])

    expect((await harness.worker.getRuntimeStatus()).running).toBe(false)
  })

  it('rebuilds the polling timer when the interval changes at runtime', async () => {
    const harness = await createHarness({ pollIntervalSeconds: 300 })
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    await harness.worker.start()

    harness.config.replyPolicy.pollIntervalSeconds = 60
    await harness.worker.reschedule()

    expect(intervalSpy).toHaveBeenCalledTimes(2)
    expect(intervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 60_000)
    await harness.worker.stop()
  })

  it('does no polling or sending while the global policy switch is disabled', async () => {
    const harness = await createHarness({ enabled: false })
    harness.demoMessage.mentions = [baseMessage()]
    harness.demoMessage.history = [baseMessage()]

    const summary = await harness.worker.runOnce()

    expect(summary.note).toContain('总开关已关闭')
    expect(harness.demoMessage.allowlist.size).toBe(0)
    expect(harness.demoMessage.historyCalls).toBe(0)
    expect((await harness.store.read()).replies).toHaveLength(0)
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('marks all existing mentions ignored on the first scan', async () => {
    const harness = await createHarness({ markExistingIgnored: true })
    const message = baseMessage()
    harness.demoMessage.mentions = [message]
    harness.demoMessage.history = [message]

    const summary = await harness.worker.runOnce()
    const state = await harness.store.read()

    expect(summary).toMatchObject({ discovered: 1, ignored: 1, sent: 0 })
    expect(state.initializedGroups).toContain('group-1')
    expect(state.replies[0]?.status).toBe('ignored')
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('does not redeliver the same mention and uses a stable DEMO_MESSAGE UUID', async () => {
    const harness = await createHarness()
    const message = baseMessage()
    harness.demoMessage.mentions = [message]
    harness.demoMessage.history = [message]

    expect((await harness.worker.runOnce()).sent).toBe(1)
    expect((await harness.worker.runOnce()).sent).toBe(0)

    expect(harness.demoMessage.sendCalls).toHaveLength(1)
    expect(harness.demoMessage.sendCalls[0]?.uuid).toMatch(/^[0-9a-f-]{36}$/u)
    expect((await harness.store.read()).replies[0]?.status).toBe('sent')
  })

  it('retries an ambiguous send only after lease expiry with the exact same UUID', async () => {
    const harness = await createHarness()
    const message = baseMessage()
    harness.demoMessage.mentions = [message]
    harness.demoMessage.history = [message]
    harness.demoMessage.failuresRemaining = 1

    expect((await harness.worker.runOnce()).failed).toBe(1)
    expect((await harness.store.read()).replies[0]?.status).toBe('sending')
    expect((await harness.worker.runOnce()).sent).toBe(0)
    expect(harness.demoMessage.sendCalls).toHaveLength(1)

    harness.setTime('2026-07-17T02:03:00.000Z')
    expect((await harness.worker.runOnce()).sent).toBe(1)
    expect(harness.demoMessage.sendCalls).toHaveLength(2)
    expect(harness.demoMessage.sendCalls[0]?.uuid).toBe(harness.demoMessage.sendCalls[1]?.uuid)
  })

  it('recovers an expired ambiguous send even after the mention leaves the lookback window', async () => {
    const harness = await createHarness({ lookbackMinutes: 15 })
    const message = baseMessage()
    harness.demoMessage.mentions = [message]
    harness.demoMessage.history = [message]
    harness.demoMessage.failuresRemaining = 1
    await harness.worker.runOnce()

    harness.demoMessage.mentions = []
    harness.setTime('2026-07-17T02:20:00.000Z')
    expect((await harness.worker.runOnce()).sent).toBe(1)

    expect(harness.demoMessage.sendCalls).toHaveLength(2)
    expect(harness.demoMessage.sendCalls[0]?.uuid).toBe(harness.demoMessage.sendCalls[1]?.uuid)
    expect((await harness.store.read()).replies[0]?.status).toBe('sent')
  })

  it('fails closed when recovery history identifies a persisted pending message as self-authored', async () => {
    const harness = await createHarness()
    const ownMessage = baseMessage({ isSelf: true })
    await harness.store.update((state) => ({
      ...state,
      replies: [
        {
          id: 'reply-pending-self',
          messageId: ownMessage.id,
          groupId: ownMessage.groupId,
          groupLabel: '测试群',
          question: ownMessage.text,
          createdAt: ownMessage.createdAt,
          updatedAt: ownMessage.createdAt,
          status: 'pending',
          evidence: [],
          attemptCount: 0,
          idempotencyUuid: '11111111-1111-4111-8111-111111111111',
          ...(ownMessage.senderId ? { senderId: ownMessage.senderId } : {}),
          ...(ownMessage.senderLabel ? { senderLabel: ownMessage.senderLabel } : {})
        }
      ]
    }))
    harness.demoMessage.history = [ownMessage]

    expect((await harness.worker.runOnce()).ignored).toBe(1)
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
    expect((await harness.store.read()).replies[0]?.reason).toContain('回环保护')
  })

  it('hands stale unfinished sends to a human after the 24-hour idempotency window', async () => {
    const harness = await createHarness()
    const message = baseMessage()
    harness.demoMessage.mentions = [message]
    harness.demoMessage.history = [message]
    harness.demoMessage.failuresRemaining = 1
    await harness.worker.runOnce()

    harness.demoMessage.mentions = []
    harness.setTime('2026-07-18T02:03:00.000Z')
    expect((await harness.worker.runOnce()).needsManual).toBe(1)

    expect(harness.demoMessage.sendCalls).toHaveLength(1)
    expect((await harness.store.read()).replies[0]?.reason).toContain('24 小时幂等窗口')
  })

  it('keeps an expired ambiguous send auditable when it is older than the follow-up window', async () => {
    const harness = await createHarness({ followUpHours: 6 })
    const message = baseMessage()
    harness.demoMessage.mentions = [message]
    harness.demoMessage.history = [message]
    harness.demoMessage.failuresRemaining = 1
    await harness.worker.runOnce()

    harness.demoMessage.mentions = []
    harness.setTime('2026-07-17T09:00:00.000Z')
    expect((await harness.worker.runOnce()).needsManual).toBe(1)

    const reply = (await harness.store.read()).replies[0]
    expect(reply?.status).toBe('needs_manual')
    expect(reply?.reason).toContain('发送结果不确定')
    expect(harness.demoMessage.sendCalls).toHaveLength(1)
  })

  it('hands off conservatively when another human has spoken after the question', async () => {
    const harness = await createHarness()
    const question = baseMessage()
    const interruption = baseMessage({
      id: 'msg-2',
      senderId: 'user-2',
      senderLabel: '小红',
      text: '我来回答这个问题',
      createdAt: '2026-07-17T02:00:05.000Z'
    })
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question, interruption]

    expect((await harness.worker.runOnce()).needsManual).toBe(1)
    expect((await harness.store.read()).replies[0]?.reason).toContain('人工插话')
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('records an original message missing from history as recalled', async () => {
    const harness = await createHarness()
    harness.demoMessage.mentions = [baseMessage()]
    harness.demoMessage.history = []

    expect((await harness.worker.runOnce()).recalled).toBe(1)
    expect((await harness.store.read()).replies[0]?.status).toBe('recalled')
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('rechecks immediately before sending and cancels on a TOCTOU human interruption', async () => {
    const harness = await createHarness()
    const question = baseMessage()
    const interruption = baseMessage({
      id: 'late-human',
      senderId: 'user-2',
      text: '我刚刚已经人工回复了',
      createdAt: '2026-07-17T02:00:05.000Z'
    })
    harness.demoMessage.mentions = [question]
    harness.demoMessage.historyResponses = [[question], [question, interruption]]

    expect((await harness.worker.runOnce()).needsManual).toBe(1)
    expect((await harness.store.read()).replies[0]?.reason).toContain('二次回查')
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('honors a switch back to dry-run during the final pre-send history check', async () => {
    const harness = await createHarness({ dryRun: false })
    const question = baseMessage()
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question]
    harness.demoMessage.onHistoryCall = (callNumber) => {
      if (callNumber === 2) harness.config.replyPolicy.dryRun = true
    }

    const summary = await harness.worker.runOnce()

    expect(summary).toMatchObject({ sent: 0, previews: 1 })
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
    expect((await harness.store.read()).replies[0]?.status).toBe('dry_run')
  })

  it('cancels sending when the active knowledge index is cleared during the final history check', async () => {
    const harness = await createHarness()
    const question = baseMessage()
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question]
    harness.demoMessage.onHistoryCall = (callNumber) => {
      if (callNumber === 2) harness.setKnowledgeChunks([])
    }

    expect((await harness.worker.runOnce()).needsManual).toBe(1)
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
    expect((await harness.store.read()).replies[0]?.reason).toContain('最终知识')
  })

  it('counts ambiguous sends against the hourly budget while allowing same-record retries', async () => {
    const harness = await createHarness({ maxRepliesPerHour: 1 })
    const first = baseMessage({ id: 'msg-1' })
    const second = baseMessage({
      id: 'msg-2',
      createdAt: '2026-07-17T02:00:01.000Z',
      text: 'dry-run 应该怎么配置？'
    })
    harness.demoMessage.mentions = [first, second]
    harness.demoMessage.historyResponses = [[first], [first], [second], [second]]
    harness.demoMessage.failuresRemaining = 1

    const summary = await harness.worker.runOnce()
    const state = await harness.store.read()

    expect(summary).toMatchObject({ failed: 1, needsManual: 1, sent: 0 })
    expect(harness.demoMessage.sendCalls).toHaveLength(1)
    expect(state.replies.find((reply) => reply.messageId === 'msg-1')?.status).toBe('sending')
    expect(state.replies.find((reply) => reply.messageId === 'msg-2')?.status).toBe('needs_manual')
  })

  it('keeps unfinished work and recent sends while evicting the oldest terminal audit records', async () => {
    const harness = await createHarness({ markExistingIgnored: true, maxRepliesPerHour: 1 })
    const terminalHistory = Array.from({ length: 5_000 }, (_, index) =>
      persistedReply(
        `terminal-${index}`,
        'dry_run',
        index === 0 ? '2026-07-17T00:00:00.000Z' : '2026-07-17T01:30:00.000Z'
      )
    )
    await harness.store.update((state) => ({
      ...state,
      replies: [
        ...terminalHistory,
        persistedReply('pending-old', 'pending', '2025-01-01T00:00:00.000Z'),
        persistedReply('sending-old', 'sending', '2025-01-01T00:00:01.000Z'),
        // Only one second inside the hourly window and older than nearly all
        // ordinary terminal records, so recency sorting alone would discard it.
        persistedReply('sent-rate-limit', 'sent', '2026-07-17T01:00:11.000Z')
      ]
    }))
    harness.demoMessage.mentions = [baseMessage({ id: 'first-scan-trigger' })]

    await harness.worker.runOnce()
    const retained = (await harness.store.read()).replies
    const retainedIds = new Set(retained.map((reply) => reply.id))

    expect(retained).toHaveLength(5_002)
    expect(retained.filter((reply) => reply.status !== 'pending' && reply.status !== 'sending')).toHaveLength(
      5_000
    )
    expect(retainedIds).toContain('pending-old')
    expect(retainedIds).toContain('sending-old')
    expect(retainedIds).toContain('sent-rate-limit')
    expect(retainedIds).not.toContain('terminal-0')

    // The protected sent record must still reserve the hourly budget after
    // trimming; otherwise the next message could be sent unsafely.
    harness.config.replyPolicy.markExistingIgnored = false
    const nextQuestion = baseMessage({ id: 'after-retention' })
    harness.demoMessage.mentions = [nextQuestion]
    harness.demoMessage.history = [nextQuestion]

    expect((await harness.worker.runOnce()).needsManual).toBe(1)
    const afterRateLimit = (await harness.store.read()).replies
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
    expect(
      afterRateLimit.find((reply) => reply.messageId === nextQuestion.id)?.reason
    ).toContain('每小时自动回复上限')
    expect(afterRateLimit).toHaveLength(5_002)
    expect(
      afterRateLimit.filter((reply) => reply.status !== 'pending' && reply.status !== 'sending')
    ).toHaveLength(5_000)
  })

  it('allows the outbox to exceed 5000 rather than dropping pending or sending records', async () => {
    const harness = await createHarness({ markExistingIgnored: true })
    const unfinished = Array.from({ length: 5_001 }, (_, index) =>
      persistedReply(
        `unfinished-${index}`,
        index % 2 === 0 ? 'pending' : 'sending',
        '2025-01-01T00:00:00.000Z'
      )
    )
    await harness.store.update((state) => ({
      ...state,
      replies: [
        ...unfinished,
        persistedReply('sent-within-hour', 'sent', '2026-07-17T01:30:00.000Z'),
        ...Array.from({ length: 8 }, (_, index) =>
          persistedReply(`audit-${index}`, 'ignored', '2026-07-16T00:00:00.000Z')
        )
      ]
    }))
    harness.demoMessage.mentions = [baseMessage({ id: 'overflow-trigger' })]

    await harness.worker.runOnce()
    const retained = (await harness.store.read()).replies
    const retainedIds = new Set(retained.map((reply) => reply.id))

    expect(retained.length).toBeGreaterThan(5_000)
    expect(retained.filter((reply) => reply.status === 'pending' || reply.status === 'sending')).toHaveLength(
      unfinished.length
    )
    expect(unfinished.every((reply) => retainedIds.has(reply.id))).toBe(true)
    expect(retainedIds).toContain('sent-within-hour')
  })

  it('hands non-text or empty-content mentions to a human', async () => {
    const harness = await createHarness()
    const attachment = baseMessage({ text: '' })
    harness.demoMessage.mentions = [attachment]

    expect((await harness.worker.runOnce()).needsManual).toBe(1)
    expect((await harness.store.read()).replies[0]?.reason).toContain('图片、附件或语音')
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('stops after three ambiguous sends and hands the record to a human', async () => {
    const harness = await createHarness()
    const question = baseMessage()
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question]
    harness.demoMessage.failuresRemaining = 3

    await harness.worker.runOnce()
    harness.setTime('2026-07-17T02:03:00.000Z')
    await harness.worker.runOnce()
    harness.setTime('2026-07-17T02:06:00.000Z')
    expect((await harness.worker.runOnce()).needsManual).toBe(1)

    const state = await harness.store.read()
    expect(state.replies[0]?.status).toBe('needs_manual')
    expect(harness.demoMessage.sendCalls).toHaveLength(3)
    expect(new Set(harness.demoMessage.sendCalls.map((call) => call.uuid)).size).toBe(1)
  })

  it('ignores looped-back messages sent by the current account', async () => {
    const harness = await createHarness()
    const ownMessage = baseMessage({ isSelf: true })
    harness.demoMessage.mentions = [ownMessage]
    harness.demoMessage.history = [ownMessage]

    expect((await harness.worker.runOnce()).ignored).toBe(1)
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })

  it('continues a sent reply for the same sender within the follow-up window', async () => {
    const harness = await createHarness({ followUpHours: 6 })
    const question = baseMessage()
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question]
    await harness.worker.runOnce()

    harness.setTime('2026-07-17T02:01:10.000Z')
    const followUp = baseMessage({
      id: 'follow-up-1',
      text: '那 dry-run 要在哪里开启？',
      createdAt: '2026-07-17T02:01:00.000Z'
    })
    harness.demoMessage.history = [question, followUp]
    const summary = await harness.worker.runOnce()
    const state = await harness.store.read()

    expect(summary.sent).toBe(1)
    expect(harness.demoMessage.sendCalls).toHaveLength(2)
    expect(state.replies.find((reply) => reply.messageId === 'follow-up-1')?.status).toBe('sent')
    expect(state.replies.find((reply) => reply.messageId === 'msg-1')?.followUpClosedAt).toBeTruthy()
  })

  it('closes a follow-up window when another person speaks first', async () => {
    const harness = await createHarness({ followUpHours: 6 })
    const question = baseMessage()
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question]
    await harness.worker.runOnce()

    harness.setTime('2026-07-17T02:01:10.000Z')
    harness.demoMessage.history = [
      question,
      baseMessage({
        id: 'other-person',
        senderId: 'user-2',
        text: '补充一个信息',
        createdAt: '2026-07-17T02:01:00.000Z'
      })
    ]
    await harness.worker.runOnce()
    const state = await harness.store.read()

    expect(harness.demoMessage.sendCalls).toHaveLength(1)
    expect(state.replies.find((reply) => reply.messageId === 'msg-1')?.followUpCloseReason).toContain(
      '其他人'
    )
  })

  it('does not open follow-up windows for dry-run previews', async () => {
    const harness = await createHarness({ dryRun: true, followUpHours: 6 })
    const question = baseMessage()
    harness.demoMessage.mentions = [question]
    harness.demoMessage.history = [question]
    await harness.worker.runOnce()

    harness.setTime('2026-07-17T02:01:10.000Z')
    harness.demoMessage.history = [
      question,
      baseMessage({ id: 'follow-up', createdAt: '2026-07-17T02:01:00.000Z' })
    ]
    await harness.worker.runOnce()
    const state = await harness.store.read()

    expect(state.replies).toHaveLength(1)
    expect(state.replies[0]?.status).toBe('dry_run')
    expect(harness.demoMessage.sendCalls).toHaveLength(0)
  })
})

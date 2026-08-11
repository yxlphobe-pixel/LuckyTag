import { createHash, randomUUID } from 'node:crypto'
import type {
  AllowlistedGroup,
  AppConfig,
  ReplyEvidence,
  ReplyStatus,
  RunSummary,
  RuntimeStatus
} from '../../shared/contracts'
import type { JsonStore } from './json-store'
import { composeKnowledgeReply, KnowledgeIndex } from './retrieval'
import type { CoreStateFile, DwsClient, DwsMessage, PersistedReplyRecord } from './types'
import { errorMessage } from './value-utils'

export interface WorkerEngineOptions {
  stateStore: JsonStore<CoreStateFile>
  dws: DwsClient
  getConfig: () => Promise<AppConfig>
  getCurrentConfig?: () => AppConfig
  getIndex: () => KnowledgeIndex
  now?: () => Date
  onUpdate?: () => void
  instanceId?: string
}

type TerminalOutcome = 'sent' | 'dry_run' | 'ignored' | 'needs_manual' | 'recalled' | 'failed'

const TERMINAL_REPLY_RETENTION = 5_000
const HOURLY_RATE_LIMIT_WINDOW_MS = 60 * 60_000

export class WorkerEngine {
  private readonly stateStore: JsonStore<CoreStateFile>
  private readonly dws: DwsClient
  private readonly getConfig: () => Promise<AppConfig>
  private readonly getCurrentConfig: (() => AppConfig) | undefined
  private readonly getIndex: () => KnowledgeIndex
  private readonly now: () => Date
  private readonly onUpdate: (() => void) | undefined
  private readonly instanceId: string
  private timer: NodeJS.Timeout | undefined
  private activeRun: Promise<RunSummary> | undefined
  private lifecycleQueue: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(options: WorkerEngineOptions) {
    this.stateStore = options.stateStore
    this.dws = options.dws
    this.getConfig = options.getConfig
    this.getCurrentConfig = options.getCurrentConfig
    this.getIndex = options.getIndex
    this.now = options.now ?? (() => new Date())
    this.onUpdate = options.onUpdate
    this.instanceId = options.instanceId ?? randomUUID()
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    let shouldResume = false
    await this.stateStore.update((state) => ({
      ...state,
      runtime: (() => {
        shouldResume = state.runtime.running
        return {
          running: false,
          processing: false,
          instanceId: this.instanceId,
          ...(state.runtime.lastRunAt ? { lastRunAt: state.runtime.lastRunAt } : {}),
          ...(state.runtime.lastError ? { lastError: state.runtime.lastError } : {})
        }
      })()
    }))
    this.initialized = true
    this.notify()
    if (shouldResume) {
      try {
        await this.start()
      } catch (error) {
        await this.updateRuntime({
          running: false,
          processing: false,
          lastError: `Daemon 恢复自动运行失败：${errorMessage(error)}`
        })
      }
    }
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    await this.initialize()
    return (await this.stateStore.read()).runtime
  }

  async getRecentReplies(limit = 100): Promise<PersistedReplyRecord[]> {
    await this.initialize()
    const state = await this.stateStore.read()
    return [...state.replies]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, limit))
  }

  start(): Promise<RuntimeStatus> {
    return this.withLifecycleLock(async () => {
      await this.initialize()
      if (this.timer) return this.getRuntimeStatus()
      const config = await this.getConfig()
      const groups = enabledGroups(config)
      if (!config.replyPolicy.enabled) throw new Error('请先启用自动回复开关')
      if (groups.length === 0) throw new Error('至少需要启用一个群白名单')

      const intervalMs = config.replyPolicy.pollIntervalSeconds * 1000
      await this.updateRuntime({
        running: true,
        processing: false,
        nextRunAt: new Date(this.now().getTime() + intervalMs).toISOString()
      })
      this.installTimer(intervalMs)
      void this.runOnce().catch(() => undefined)
      return this.getRuntimeStatus()
    })
  }

  stop(): Promise<RuntimeStatus> {
    return this.withLifecycleLock(async () => {
      this.clearTimer()
      if (this.activeRun) await this.activeRun.catch(() => undefined)
      await this.initialize()
      await this.updateRuntime({ running: false, processing: false })
      return this.getRuntimeStatus()
    })
  }

  /**
   * Quiesces this process without clearing the persisted "should run" intent.
   * The replacement daemon can therefore resume the scheduler after an upgrade
   * or a launchd restart, while an explicit stop() remains durable.
   */
  async suspendForShutdown(): Promise<void> {
    await this.initialize()
    return this.withLifecycleLock(async () => {
      this.clearTimer()
      if (this.activeRun) await this.activeRun.catch(() => undefined)
      const runtime = await this.getRuntimeStatus()
      await this.updateRuntime({
        running: runtime.running,
        processing: false,
        ...(runtime.lastRunAt ? { lastRunAt: runtime.lastRunAt } : {}),
        lastError: runtime.lastError ?? null
      })
    })
  }

  reschedule(): Promise<RuntimeStatus> {
    return this.withLifecycleLock(async () => {
      await this.initialize()
      if (!this.timer) return this.getRuntimeStatus()

      const config = await this.getConfig()
      if (!config.replyPolicy.enabled || enabledGroups(config).length === 0) {
        this.clearTimer()
        if (this.activeRun) await this.activeRun.catch(() => undefined)
        await this.updateRuntime({ running: false, processing: false })
        return this.getRuntimeStatus()
      }

      const intervalMs = config.replyPolicy.pollIntervalSeconds * 1000
      const current = await this.getRuntimeStatus()
      this.clearTimer()
      this.installTimer(intervalMs)
      await this.updateRuntime({
        running: true,
        processing: current.processing,
        nextRunAt: new Date(this.now().getTime() + intervalMs).toISOString()
      })
      return this.getRuntimeStatus()
    })
  }

  runOnce(): Promise<RunSummary> {
    if (this.activeRun) return this.activeRun
    const run = this.executeRun().finally(() => {
      if (this.activeRun === run) this.activeRun = undefined
    })
    this.activeRun = run
    return run
  }

  private async executeRun(): Promise<RunSummary> {
    await this.initialize()
    const startedAt = this.now().toISOString()
    const counters = {
      discovered: 0,
      sent: 0,
      previews: 0,
      ignored: 0,
      needsManual: 0,
      recalled: 0,
      failed: 0
    }
    const notes: string[] = []
    await this.updateRuntime({ running: await this.isRunning(), processing: true })

    try {
      const config = await this.getConfig()
      const groups = config.replyPolicy.enabled ? enabledGroups(config) : []
      this.dws.setAllowlistedGroups(groups.map((group) => group.id))
      if (!config.replyPolicy.enabled) notes.push('自动回复总开关已关闭，本轮未读取或发送任何消息')
      if (config.replyPolicy.enabled && groups.length === 0) {
        notes.push('群白名单为空，未读取或发送任何消息')
      }

      const end = this.now()
      const start = new Date(end.getTime() - config.replyPolicy.lookbackMinutes * 60_000)
      for (const group of groups) {
        try {
          const messages = await this.fetchMentions(group.id, start.toISOString(), end.toISOString())
          const state = await this.stateStore.read()
          const firstScan = !state.initializedGroups.includes(group.id)
          if (firstScan && config.replyPolicy.markExistingIgnored) {
            const added = await this.markInitialMessagesIgnored(messages, group)
            counters.discovered += added
            counters.ignored += added
            await this.markGroupInitialized(group.id)
            continue
          }
          if (firstScan) await this.markGroupInitialized(group.id)

          const recoveryOutcomes = await this.processRecoverableRecords(group, config)
          for (const outcome of recoveryOutcomes) incrementOutcome(counters, outcome)

          for (const message of messages) {
            if (message.groupId !== group.id) {
              counters.ignored += 1
              continue
            }
            const { isNew, record } = await this.ensurePendingRecord(message, group)
            if (isNew) counters.discovered += 1
            const outcome = await this.processRecord(record, message, group, config)
            incrementOutcome(counters, outcome)
          }

          const followUpOutcomes = await this.processOpenFollowUps(group, config)
          for (const outcome of followUpOutcomes) incrementOutcome(counters, outcome)
        } catch (error) {
          counters.failed += 1
          notes.push(`${group.label}：${errorMessage(error)}`)
        }
      }
    } catch (error) {
      counters.failed += 1
      notes.push(errorMessage(error))
    }

    const finishedAt = this.now().toISOString()
    const running = await this.isRunning()
    const config = await this.getConfig().catch(() => undefined)
    const intervalMs = (config?.replyPolicy.pollIntervalSeconds ?? 300) * 1000
    await this.updateRuntime({
      running,
      processing: false,
      lastRunAt: finishedAt,
      ...(running ? { nextRunAt: new Date(this.now().getTime() + intervalMs).toISOString() } : {}),
      lastError: notes.length > 0 ? notes.join('；') : null
    })
    return {
      startedAt,
      finishedAt,
      ...counters,
      ...(notes.length > 0 ? { note: notes.join('；') } : {})
    }
  }

  private async fetchMentions(groupId: string, start: string, end: string): Promise<DwsMessage[]> {
    const messages = new Map<string, DwsMessage>()
    const visitedCursors = new Set<string>()
    let cursor = '0'
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      if (visitedCursors.has(cursor)) break
      visitedCursors.add(cursor)
      const page = await this.dws.listMentions({ groupId, start, end, limit: 30, cursor })
      for (const message of page.messages) messages.set(message.id, message)
      if (!page.hasMore || !page.nextCursor) break
      cursor = page.nextCursor
    }
    return [...messages.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  private async markInitialMessagesIgnored(
    messages: readonly DwsMessage[],
    group: AllowlistedGroup
  ): Promise<number> {
    let added = 0
    await this.stateStore.update((state) => {
      const known = new Set(state.replies.map((reply) => `${reply.groupId}\0${reply.messageId}`))
      const replies = [...state.replies]
      for (const message of messages) {
        const messageKey = `${group.id}\0${message.id}`
        if (known.has(messageKey) || message.groupId !== group.id) continue
        const record = createReplyRecord(message, group, this.now())
        replies.push({
          ...record,
          status: 'ignored',
          reason: '首次运行安全策略：仅记录已有消息，不自动回复',
          updatedAt: this.now().toISOString()
        })
        known.add(messageKey)
        added += 1
      }
      return { ...state, replies: trimReplies(replies, this.now()) }
    })
    if (added > 0) this.notify()
    return added
  }

  private async markGroupInitialized(groupId: string): Promise<void> {
    await this.stateStore.update((state) => ({
      ...state,
      initializedGroups: [...new Set([...state.initializedGroups, groupId])]
    }))
    this.notify()
  }

  private async processOpenFollowUps(
    group: AllowlistedGroup,
    config: AppConfig
  ): Promise<Array<TerminalOutcome | undefined>> {
    const state = await this.stateStore.read()
    const threshold = this.now().getTime() - config.replyPolicy.followUpHours * 60 * 60_000
    const windows = state.replies
      .filter(
        (reply) =>
          reply.groupId === group.id &&
          reply.status === 'sent' &&
          Boolean(reply.senderId) &&
          !reply.followUpClosedAt &&
          new Date(reply.updatedAt).getTime() >= threshold
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

    // Only the newest reply to a given sender can own the active window.
    const newestBySender = new Map<string, PersistedReplyRecord>()
    for (const window of windows) {
      const senderId = window.senderId
      if (senderId && !newestBySender.has(senderId)) newestBySender.set(senderId, window)
    }

    const outcomes: Array<TerminalOutcome | undefined> = []
    for (const window of [...newestBySender.values()].slice(0, 10)) {
      const history = await this.dws.listConversationMessages({
        groupId: group.id,
        time: window.updatedAt,
        forward: true,
        limit: 30
      })
      const windowOpenedAt = new Date(window.updatedAt).getTime()
      const firstHumanMessage = history
        .filter(
          (message) =>
            !message.isSelf &&
            !message.recalled &&
            message.text.trim().length > 0 &&
            new Date(message.createdAt).getTime() > windowOpenedAt + 500
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
      if (!firstHumanMessage) continue

      if (!firstHumanMessage.senderId || firstHumanMessage.senderId !== window.senderId) {
        await this.closeFollowUpWindow(window.id, '其他人先发言，续问窗口已关闭')
        continue
      }

      await this.closeFollowUpWindow(window.id, '同一发送者已发起续问')
      const { record } = await this.ensurePendingRecord(firstHumanMessage, group)
      outcomes.push(await this.processRecord(record, firstHumanMessage, group, config))
    }
    return outcomes
  }

  private async processRecoverableRecords(
    group: AllowlistedGroup,
    config: AppConfig
  ): Promise<Array<TerminalOutcome | undefined>> {
    const state = await this.stateStore.read()
    const now = this.now().getTime()
    const records = state.replies
      .filter((reply) => {
        if (reply.groupId !== group.id || (reply.status !== 'pending' && reply.status !== 'sending')) {
          return false
        }
        if (reply.status === 'pending') return true
        const leaseExpiresAt = reply.leaseExpiresAt ? new Date(reply.leaseExpiresAt).getTime() : 0
        return !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, 50)

    const outcomes: Array<TerminalOutcome | undefined> = []
    for (const record of records) {
      if (now - new Date(record.updatedAt).getTime() >= 24 * 60 * 60_000) {
        await this.setStatus(record.id, 'needs_manual', {
          reason: '未完成发送已超过 DWS 24 小时幂等窗口，为避免重复消息已转交人工'
        })
        outcomes.push('needs_manual')
        continue
      }

      outcomes.push(await this.processRecord(
        record,
        {
          id: record.messageId,
          groupId: record.groupId,
          text: record.question,
          createdAt: record.createdAt,
          recalled: false,
          isSelf: false,
          ...(record.senderId ? { senderId: record.senderId } : {}),
          ...(record.senderLabel ? { senderLabel: record.senderLabel } : {})
        },
        group,
        config
      ))
    }
    return outcomes
  }

  private async closeFollowUpWindow(recordId: string, reason: string): Promise<void> {
    await this.stateStore.update((state) => ({
      ...state,
      replies: state.replies.map((reply) =>
        reply.id === recordId
          ? {
              ...reply,
              followUpClosedAt: this.now().toISOString(),
              followUpCloseReason: reason
            }
          : reply
      )
    }))
    this.notify()
  }

  private async ensurePendingRecord(
    message: DwsMessage,
    group: AllowlistedGroup
  ): Promise<{ isNew: boolean; record: PersistedReplyRecord }> {
    let isNew = false
    let selected: PersistedReplyRecord | undefined
    await this.stateStore.update((state) => {
      selected = state.replies.find(
        (reply) => reply.groupId === group.id && reply.messageId === message.id
      )
      if (selected) return state
      selected = createReplyRecord(message, group, this.now())
      isNew = true
      return { ...state, replies: trimReplies([...state.replies, selected], this.now()) }
    })
    if (!selected) throw new Error('无法创建消息处理记录')
    if (isNew) this.notify()
    return { isNew, record: selected }
  }

  private async processRecord(
    initialRecord: PersistedReplyRecord,
    mention: DwsMessage,
    group: AllowlistedGroup,
    config: AppConfig
  ): Promise<TerminalOutcome | undefined> {
    let record = initialRecord
    if (isTerminal(record.status)) return undefined
    const hadUncertainSend = record.status === 'sending' && record.attemptCount > 0
    const stopWithoutRetry = async (
      fallbackStatus: 'dry_run' | 'ignored' | 'recalled',
      reason: string,
      patch: Partial<PersistedReplyRecord> = {}
    ): Promise<'dry_run' | 'ignored' | 'recalled' | 'needs_manual'> => {
      if (hadUncertainSend) {
        await this.setStatus(record.id, 'needs_manual', {
          ...patch,
          reason: `此前 DWS 发送结果不确定，不能确认消息是否已送达；${reason}，请人工核对`
        })
        return 'needs_manual'
      }
      await this.setStatus(record.id, fallbackStatus, { ...patch, reason })
      return fallbackStatus
    }
    if (record.status === 'sending') {
      const leaseExpiresAt = record.leaseExpiresAt ? new Date(record.leaseExpiresAt).getTime() : 0
      if (leaseExpiresAt > this.now().getTime()) return undefined
    }

    if (mention.recalled) {
      return stopWithoutRetry('recalled', '原消息已撤回')
    }
    if (mention.isSelf) {
      return stopWithoutRetry('ignored', '回环保护：当前账号发出的消息不应自动回复')
    }
    if (!mention.text.trim()) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: '消息没有可安全自动处理的文本内容，可能包含图片、附件或语音，已转交人工'
      })
      return 'needs_manual'
    }

    const ageMs = this.now().getTime() - new Date(mention.createdAt).getTime()
    if (ageMs > config.replyPolicy.followUpHours * 60 * 60_000) {
      return stopWithoutRetry('ignored', '消息已超过安全跟进时限，不再自动重试')
    }

    let history: DwsMessage[]
    try {
      const historyStart = new Date(new Date(mention.createdAt).getTime() - 2 * 60_000)
      history = await this.dws.listConversationMessages({
        groupId: group.id,
        time: historyStart.toISOString(),
        forward: true,
        limit: 30
      })
    } catch (error) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: `原消息回查失败，为避免误回复已交给人工：${errorMessage(error)}`
      })
      return 'needs_manual'
    }

    const original = history.find((message) => message.id === mention.id)
    if (!original) {
      return stopWithoutRetry('recalled', '原消息已不在会话历史中，按撤回处理')
    }
    if (original.recalled) {
      return stopWithoutRetry('recalled', '回查确认原消息已撤回')
    }
    if (original.isSelf) {
      return stopWithoutRetry('ignored', '回查确认是当前账号发出的消息，回环保护已停止自动回复')
    }

    const originalTime = new Date(original.createdAt).getTime()
    const humanInterruption = history.find(
      (message) =>
        message.id !== original.id &&
        !message.isSelf &&
        new Date(message.createdAt).getTime() > originalTime + 500
    )
    if (humanInterruption) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: '检测到原消息后已有人工插话，已保守停止自动接管'
      })
      return 'needs_manual'
    }

    const question = original.text.trim() || mention.text.trim()
    let evidence = this.getIndex().search(question, 5)
    let bestScore = evidence[0]?.score ?? 0
    if (evidence.length === 0 || bestScore < config.replyPolicy.confidenceThreshold) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: `知识库证据置信度不足（${bestScore.toFixed(3)} < ${config.replyPolicy.confidenceThreshold.toFixed(3)}）`,
        evidence
      })
      return 'needs_manual'
    }

    let reply = composeKnowledgeReply(evidence, config.replyPolicy.maxReplyLength)
    if (!reply) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: '无法从证据片段拼装安全回复',
        evidence
      })
      return 'needs_manual'
    }

    if (config.replyPolicy.dryRun) {
      return stopWithoutRetry('dry_run', 'Dry-run：已生成预览，没有发送到钉钉', {
        reply,
        evidence
      })
    }

    const latestConfig = await this.getConfig()
    const groupStillAllowed = latestConfig.groups.some(
      (configuredGroup) => configuredGroup.enabled && configuredGroup.id === group.id
    )
    if (!latestConfig.replyPolicy.enabled || !groupStillAllowed) {
      return stopWithoutRetry('ignored', '发送前配置已关闭自动回复或移出群白名单，已取消发送', {
        reply,
        evidence
      })
    }
    const latestBestScore = evidence[0]?.score ?? 0
    if (latestBestScore < latestConfig.replyPolicy.confidenceThreshold) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: `发送前策略已提高知识置信度要求（${latestBestScore.toFixed(3)} < ${latestConfig.replyPolicy.confidenceThreshold.toFixed(3)}）`,
        evidence
      })
      return 'needs_manual'
    }

    reply = composeKnowledgeReply(evidence, latestConfig.replyPolicy.maxReplyLength)
    if (!reply) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: '发送前无法按最新策略拼装安全回复',
        evidence
      })
      return 'needs_manual'
    }
    if (latestConfig.replyPolicy.dryRun) {
      return stopWithoutRetry('dry_run', '发送前已切换为预演模式；已生成预览，没有发送到钉钉', {
        reply,
        evidence
      })
    }

    // Close the gap between retrieval/rate-limit work and the irreversible send.
    // Any recall or human response during that interval must cancel automation.
    let finalHistory: DwsMessage[]
    try {
      const finalHistoryStart = new Date(new Date(mention.createdAt).getTime() - 2 * 60_000)
      finalHistory = await this.dws.listConversationMessages({
        groupId: group.id,
        time: finalHistoryStart.toISOString(),
        forward: true,
        limit: 30
      })
    } catch (error) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: `发送前二次回查失败，已取消自动发送：${errorMessage(error)}`,
        reply,
        evidence
      })
      return 'needs_manual'
    }
    const finalOriginal = finalHistory.find((message) => message.id === mention.id)
    if (!finalOriginal || finalOriginal.recalled) {
      return stopWithoutRetry('recalled', '发送前二次回查发现原消息已撤回', {
        evidence
      })
    }
    const finalOriginalTime = new Date(finalOriginal.createdAt).getTime()
    const finalHumanInterruption = finalHistory.find(
      (message) =>
        message.id !== finalOriginal.id &&
        !message.isSelf &&
        new Date(message.createdAt).getTime() > finalOriginalTime + 500
    )
    if (finalHumanInterruption) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: '发送前二次回查检测到人工插话，已取消自动发送',
        reply,
        evidence
      })
      return 'needs_manual'
    }

    const finalConfig = await this.getConfig()
    const finalGroupAllowed = finalConfig.groups.some(
      (configuredGroup) => configuredGroup.enabled && configuredGroup.id === group.id
    )
    if (!finalConfig.replyPolicy.enabled || !finalGroupAllowed) {
      return stopWithoutRetry('ignored', '发送前最终配置检查发现自动回复已关闭或群已移出白名单', {
        reply,
        evidence
      })
    }
    if (finalConfig.replyPolicy.dryRun) {
      reply = composeKnowledgeReply(evidence, finalConfig.replyPolicy.maxReplyLength)
      return stopWithoutRetry('dry_run', '发送前最终检查已切换为预演模式；没有发送到钉钉', {
        reply,
        evidence
      })
    }

    // Knowledge can be disabled or replaced while the history check is in flight.
    // Re-retrieve from the current active index before composing the irreversible send.
    evidence = this.getIndex().search(question, 5)
    bestScore = evidence[0]?.score ?? 0
    if (evidence.length === 0 || bestScore < finalConfig.replyPolicy.confidenceThreshold) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: `发送前最终知识与策略检查未通过（${bestScore.toFixed(3)} < ${finalConfig.replyPolicy.confidenceThreshold.toFixed(3)}）`,
        evidence
      })
      return 'needs_manual'
    }
    reply = composeKnowledgeReply(evidence, finalConfig.replyPolicy.maxReplyLength)
    const reservedInLastHour = await this.countReservedInLastHour(record.id)
    if (reservedInLastHour >= finalConfig.replyPolicy.maxRepliesPerHour) {
      await this.setStatus(record.id, 'needs_manual', {
        reason: '已达到每小时自动回复上限（含发送结果不确定的保守预留），转交人工处理',
        reply,
        evidence
      })
      return 'needs_manual'
    }

    const leaseExpiresAt = new Date(this.now().getTime() + 2 * 60_000).toISOString()
    record = await this.setStatus(record.id, 'sending', {
      reason: '正在通过 DWS 幂等发送',
      reply,
      evidence,
      leaseExpiresAt,
      attemptCount: record.attemptCount + 1
    })
    try {
      const immediateConfig = this.getCurrentConfig?.()
      if (immediateConfig) {
        const immediateGroupAllowed = immediateConfig.groups.some(
          (configuredGroup) => configuredGroup.enabled && configuredGroup.id === group.id
        )
        if (!immediateConfig.replyPolicy.enabled || !immediateGroupAllowed) {
          return stopWithoutRetry(
            'ignored',
            '调用 DWS 前检测到自动回复已关闭或群已移出白名单，已取消发送'
          )
        }
        if (immediateConfig.replyPolicy.dryRun) {
          return stopWithoutRetry(
            'dry_run',
            '调用 DWS 前检测到已切换为预演模式；没有发送到钉钉'
          )
        }
        const immediateEvidence = this.getIndex().search(question, 5)
        const immediateBestScore = immediateEvidence[0]?.score ?? 0
        const immediateReply = composeKnowledgeReply(
          immediateEvidence,
          immediateConfig.replyPolicy.maxReplyLength
        )
        if (
          immediateEvidence.length === 0 ||
          immediateBestScore < immediateConfig.replyPolicy.confidenceThreshold ||
          !immediateReply ||
          immediateReply !== reply
        ) {
          await this.setStatus(record.id, 'needs_manual', {
            reason: '调用 DWS 前检测到知识来源或最新策略已变化，已取消发送',
            evidence: immediateEvidence
          })
          return 'needs_manual'
        }
        if (reservedInLastHour >= immediateConfig.replyPolicy.maxRepliesPerHour) {
          await this.setStatus(record.id, 'needs_manual', {
            reason: '调用 DWS 前检测到最新每小时额度不足，已取消发送'
          })
          return 'needs_manual'
        }
      }
      // There is intentionally no await between the synchronous final guards above
      // and starting the DWS call, so config/index mutations cannot interleave here.
      const sendPromise = this.dws.sendMessage({
        groupId: group.id,
        text: reply,
        uuid: record.idempotencyUuid
      })
      const result = await sendPromise
      await this.setStatus(record.id, 'sent', {
        reason: result.deduplicated ? 'DWS 幂等键命中，发送结果已确认' : '已发送',
        ...(result.platformTaskId ? { platformTaskId: result.platformTaskId } : {})
      })
      return 'sent'
    } catch (error) {
      if (record.attemptCount >= 3) {
        await this.setStatus(record.id, 'needs_manual', {
          reason: `发送结果连续 ${record.attemptCount} 次不确定，已停止重试并转交人工：${errorMessage(error)}`
        })
        return 'needs_manual'
      } else {
        await this.setStatus(record.id, 'sending', {
          reason: `发送结果不确定，将在租约到期后用同一 UUID 重试：${errorMessage(error)}`,
          leaseExpiresAt
        })
      }
      return 'failed'
    }
  }

  private async countReservedInLastHour(excludeRecordId: string): Promise<number> {
    const threshold = this.now().getTime() - HOURLY_RATE_LIMIT_WINDOW_MS
    const state = await this.stateStore.read()
    return state.replies.filter(
      (reply) =>
        reply.id !== excludeRecordId &&
        reservesHourlyReplyCapacity(reply, threshold)
    ).length
  }

  private installTimer(intervalMs: number): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined)
    }, intervalMs)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async setStatus(
    recordId: string,
    status: ReplyStatus,
    patch: Partial<PersistedReplyRecord>
  ): Promise<PersistedReplyRecord> {
    let selected: PersistedReplyRecord | undefined
    await this.stateStore.update((state) => {
      const updatedAt = this.now()
      const replies = state.replies.map((record) => {
        if (record.id !== recordId) return record
        assertTransition(record.status, status)
        const { leaseExpiresAt: _oldLease, ...withoutLease } = record
        const base = status === 'sending' ? record : withoutLease
        selected = {
          ...base,
          ...patch,
          status,
          updatedAt: updatedAt.toISOString()
        } as PersistedReplyRecord
        return selected
      })
      return { ...state, replies: trimReplies(replies, updatedAt) }
    })
    if (!selected) throw new Error(`找不到回复状态记录：${recordId}`)
    this.notify()
    return selected
  }

  private async isRunning(): Promise<boolean> {
    return (await this.stateStore.read()).runtime.running
  }

  private async updateRuntime(input: {
    running: boolean
    processing: boolean
    lastRunAt?: string
    nextRunAt?: string
    lastError?: string | null
  }): Promise<void> {
    await this.stateStore.update((state) => {
      const lastRunAt = input.lastRunAt ?? state.runtime.lastRunAt
      const lastError = input.lastError === undefined ? state.runtime.lastError : input.lastError ?? undefined
      return {
        ...state,
        runtime: {
          running: input.running,
          processing: input.processing,
          instanceId: this.instanceId,
          ...(lastRunAt ? { lastRunAt } : {}),
          ...(input.nextRunAt ? { nextRunAt: input.nextRunAt } : {}),
          ...(lastError ? { lastError } : {})
        }
      }
    })
    this.notify()
  }

  private notify(): void {
    this.onUpdate?.()
  }
}

const createReplyRecord = (
  message: DwsMessage,
  group: AllowlistedGroup,
  now: Date
): PersistedReplyRecord => {
  const timestamp = now.toISOString()
  const recordId = createHash('sha256').update(`${group.id}\0${message.id}`).digest('hex').slice(0, 32)
  return {
    id: recordId,
    messageId: message.id,
    groupId: group.id,
    groupLabel: group.label,
    ...(message.senderLabel ? { senderLabel: message.senderLabel } : {}),
    ...(message.senderId ? { senderId: message.senderId } : {}),
    question: message.text,
    status: 'pending',
    createdAt: message.createdAt || timestamp,
    updatedAt: timestamp,
    evidence: [],
    attemptCount: 0,
    idempotencyUuid: stableUuid(`${group.id}\0${message.id}`)
  }
}

export const stableUuid = (value: string): string => {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const isTerminal = (status: ReplyStatus): boolean =>
  ['sent', 'ignored', 'needs_manual', 'recalled', 'dry_run', 'failed'].includes(status)

const assertTransition = (from: ReplyStatus, to: ReplyStatus): void => {
  const allowed: Record<ReplyStatus, readonly ReplyStatus[]> = {
    pending: ['pending', 'sending', 'ignored', 'needs_manual', 'recalled', 'dry_run', 'failed'],
    sending: ['sending', 'sent', 'ignored', 'needs_manual', 'recalled', 'dry_run', 'failed'],
    sent: ['sent'],
    ignored: ['ignored'],
    needs_manual: ['needs_manual'],
    recalled: ['recalled'],
    dry_run: ['dry_run'],
    failed: ['failed']
  }
  if (!allowed[from].includes(to)) throw new Error(`非法回复状态迁移：${from} -> ${to}`)
}

const enabledGroups = (config: AppConfig): AllowlistedGroup[] =>
  config.groups.filter((group) => group.enabled && group.id.trim().length > 0)

const trimReplies = (
  replies: readonly PersistedReplyRecord[],
  now: Date
): PersistedReplyRecord[] => {
  const hourlyThreshold = now.getTime() - HOURLY_RATE_LIMIT_WINDOW_MS
  const unfinished: PersistedReplyRecord[] = []
  const protectedTerminal: PersistedReplyRecord[] = []
  const evictableTerminal: PersistedReplyRecord[] = []

  for (const reply of replies) {
    // Capacity pressure must never erase unfinished work: pending records are
    // needed for recovery, while sending records carry the idempotency UUID and
    // ambiguous-send lease. Recent sends are equally mandatory because dropping
    // one would under-count the hourly safety budget.
    if (!isTerminal(reply.status)) {
      unfinished.push(reply)
    } else if (reservesHourlyReplyCapacity(reply, hourlyThreshold)) {
      protectedTerminal.push(reply)
    } else {
      evictableTerminal.push(reply)
    }
  }

  const remainingCapacity = Math.max(0, TERMINAL_REPLY_RETENTION - protectedTerminal.length)
  const retainedTerminal = evictableTerminal
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, remainingCapacity)

  // Unfinished work does not consume the terminal audit-history budget. The
  // outbox can therefore exceed 5,000 records: losing recoverability is less
  // safe than allowing temporary growth while work remains unresolved.
  return [...unfinished, ...protectedTerminal, ...retainedTerminal].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )
}

const reservesHourlyReplyCapacity = (
  reply: PersistedReplyRecord,
  threshold: number
): boolean => {
  if (reply.status !== 'sent' && reply.status !== 'sending') return false
  const updatedAt = new Date(reply.updatedAt).getTime()
  // A malformed timestamp is treated as recent. Failing closed here avoids
  // silently freeing rate-limit capacity for a record whose age is unknown.
  return !Number.isFinite(updatedAt) || updatedAt >= threshold
}

const incrementOutcome = (
  counters: {
    sent: number
    previews: number
    ignored: number
    needsManual: number
    recalled: number
    failed: number
  },
  outcome: TerminalOutcome | undefined
): void => {
  if (outcome === 'sent') counters.sent += 1
  if (outcome === 'dry_run') counters.previews += 1
  if (outcome === 'ignored') counters.ignored += 1
  if (outcome === 'needs_manual') counters.needsManual += 1
  if (outcome === 'recalled') counters.recalled += 1
  if (outcome === 'failed') counters.failed += 1
}

export type { ReplyEvidence }

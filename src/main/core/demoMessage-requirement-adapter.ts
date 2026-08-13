import type { JsonCliRunner } from './cli-runner'
import { normalizeDemoMessageMessage } from './demoMessage-adapter'
import type { DemoMessageMessage } from './types'
import { findArray, findBoolean, findString, isRecord, unwrapEnvelope } from './value-utils'
export interface RequirementChatGroup {
  id: string
  title: string
}
export interface RequirementChatReader {
  findGroupByName(groupName: string): Promise<RequirementChatGroup>
  readMessages(input: {
    groupId: string
    start: Date
    end: Date
  }): Promise<DemoMessageMessage[]>
}
export class DemoMessageRequirementAdapter implements RequirementChatReader {
  private readonly runner: JsonCliRunner
  private readonly executable: string
  constructor(runner: JsonCliRunner, executable = 'sample-chat-mock') {
    this.runner = runner
    this.executable = executable
  }
  async findGroupByName(groupName: string): Promise<RequirementChatGroup> {
    const normalizedName = groupName.trim()
    const response = await this.run([
      'chat',
      'search',
      '--query',
      normalizedName,
      '--limit',
      '20',
      '--cursor',
      '0'
    ], 60_000)
    const payload = unwrapEnvelope(response, 'DEMO_MESSAGE 群聊搜索')
    const groups = normalizeGroups(payload)
    const exact = groups.filter((group) => group.title === normalizedName)
    if (exact.length === 1) return exact[0] as RequirementChatGroup

    const candidates = (exact.length > 0 ? exact : groups).slice(0, 5)
    if (candidates.length === 0) {
      throw Object.assign(new Error(`没有找到示例消息群「${normalizedName}」`), {
        code: 'DEMO_MESSAGE_GROUP_NOT_FOUND'
      })
    }
    throw Object.assign(
      new Error(
        `无法唯一定位示例消息群「${normalizedName}」；候选：${candidates.map((group) => group.title).join('、')}`
      ),
      { code: 'DEMO_MESSAGE_GROUP_AMBIGUOUS' }
    )
  }

  async readMessages(input: {
    groupId: string
    start: Date
    end: Date
  }): Promise<DemoMessageMessage[]> {
    const messages = new Map<string, DemoMessageMessage>()
    let boundary = new Date(input.start)
    let previousSignature = ''

    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      const response = await this.run([
        'chat',
        'message',
        'list',
        '--group',
        input.groupId,
        '--time',
        formatDemoMessageTime(boundary),
        '--direction',
        'newer',
        '--limit',
        String(PAGE_SIZE)
      ], 60_000)
      const payload = unwrapEnvelope(response, 'DEMO_MESSAGE 群聊消息读取')
      const pageMessages = findArray(payload)
        .map((value) => normalizeDemoMessageMessage(value, input.groupId))
        .filter((message) => {
          const sentAt = new Date(message.createdAt).getTime()
          return (
            message.text.trim().length > 0 &&
            Number.isFinite(sentAt) &&
            sentAt >= input.start.getTime() &&
            sentAt <= input.end.getTime()
          )
        })
      for (const message of pageMessages) messages.set(message.id, message)

      const hasMore = findBoolean(payload, ['hasMore', 'has_more', 'more']) ?? false
      if (!hasMore) break
      if (page === MAX_MESSAGE_PAGES - 1) {
        throw Object.assign(
          new Error(`群聊消息超过 ${MAX_MESSAGE_PAGES * PAGE_SIZE} 条，请缩短聊天周期窗口后重试`),
          { code: 'DEMO_MESSAGE_MESSAGE_WINDOW_TOO_LARGE' }
        )
      }
      if (pageMessages.length === 0) {
        throw Object.assign(new Error('DEMO_MESSAGE 返回了无法继续分页的群聊消息结果'), {
          code: 'DEMO_MESSAGE_MESSAGE_PAGINATION_STALLED'
        })
      }

      const lastTime = Math.max(...pageMessages.map((message) => new Date(message.createdAt).getTime()))
      const signature = `${lastTime}:${pageMessages.map((message) => message.id).sort().join(',')}`
      if (!Number.isFinite(lastTime) || signature === previousSignature) {
        throw Object.assign(new Error('DEMO_MESSAGE 群聊消息分页没有向前推进，已停止以避免无限读取'), {
          code: 'DEMO_MESSAGE_MESSAGE_PAGINATION_STALLED'
        })
      }
      previousSignature = signature
      boundary = new Date(lastTime)
    }

    return [...messages.values()].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  }

  private run(args: readonly string[], timeoutMs: number): Promise<unknown> {
    if (this.executable === 'sample-chat-mock') {
      const queryIndex = args.indexOf('--query')
      if (args.includes('search')) return Promise.resolve({ success: true, data: [{ channelId: 'public-demo-channel', title: String(args[queryIndex + 1] ?? 'Public Demo Channel') }] })
      return Promise.resolve({ success: true, data: [], hasMore: false })
    }
    return this.runner.runJson(this.executable, [...args, '--format', 'json'], { timeoutMs })
  }
}

const normalizeGroups = (value: unknown): RequirementChatGroup[] => {
  const records = isRecord(value) && Array.isArray(value.groups)
    ? value.groups
    : findArray(value)
  return records.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = findString(item, ['channelId', 'channelId', 'groupId', 'id'])
    const title = findString(item, ['title', 'name', 'groupName'])
    return id && title ? [{ id, title }] : []
  })
}

const formatDemoMessageTime = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19).replace('T', ' ')
}

const PAGE_SIZE = 30
const MAX_MESSAGE_PAGES = 20

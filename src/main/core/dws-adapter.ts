import { createHash } from 'node:crypto'
import type { JsonCliRunner } from './cli-runner'
import type {
  DwsAuthStatus,
  DwsClient,
  DwsMentionPage,
  DwsMessage,
  DwsSendResult
} from './types'
import {
  findArray,
  findBoolean,
  findString,
  isRecord,
  toIsoDate,
  unwrapEnvelope
} from './value-utils'

export class DwsAdapter implements DwsClient {
  private readonly runner: JsonCliRunner
  private readonly executable: string
  private allowlistedGroups = new Set<string>()

  constructor(runner: JsonCliRunner, executable = 'dws') {
    this.runner = runner
    this.executable = executable
  }

  setAllowlistedGroups(groupIds: Iterable<string>): void {
    this.allowlistedGroups = new Set(
      [...groupIds].map((value) => value.trim()).filter((value) => value.length > 0)
    )
  }

  async probe(): Promise<DwsAuthStatus> {
    const response = await this.run(['auth', 'status'])
    return normalizeAuthStatus(response, '钉钉 DWS 已连接')
  }

  async authenticate(): Promise<DwsAuthStatus> {
    try {
      await this.run(['auth', 'login'], 120_000)
      // A successful login command only proves the command completed. Confirm the
      // actual session through the same authoritative status contract used by probe.
      return this.probe()
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'INVALID_CLI_JSON') {
        throw Object.assign(
          new Error('DWS auth login 未返回可验证 JSON；为安全起见无法确认认证成功，请完成登录后重新检查连接'),
          { code: 'DWS_AUTH_JSON_REQUIRED', cause: error }
        )
      }
      throw error
    }
  }

  async listMentions(input: {
    groupId: string
    start: string
    end: string
    limit?: number
    cursor?: string
  }): Promise<DwsMentionPage> {
    this.assertGroupAllowed(input.groupId)
    const limit = clampLimit(input.limit)
    const response = await this.run([
      'chat',
      'message',
      'list-mentions',
      '--group',
      input.groupId,
      '--start',
      input.start,
      '--end',
      input.end,
      '--limit',
      String(limit),
      '--cursor',
      input.cursor ?? '0'
    ])
    const payload = unwrapEnvelope(response, 'DWS list-mentions')
    const messages = findArray(payload).map((item) => normalizeMessage(item, input.groupId))
    const hasMore = findBoolean(payload, ['hasMore', 'has_more', 'more']) ?? false
    const nextCursor = findString(payload, ['nextCursor', 'next_cursor', 'cursor'])
    return {
      messages,
      hasMore,
      ...(nextCursor ? { nextCursor } : {})
    }
  }

  async listConversationMessages(input: {
    groupId: string
    time: string
    forward?: boolean
    limit?: number
  }): Promise<DwsMessage[]> {
    this.assertGroupAllowed(input.groupId)
    const response = await this.run([
      'chat',
      'message',
      'list',
      '--group',
      input.groupId,
      '--time',
      formatDwsTime(input.time),
      '--forward',
      String(input.forward ?? true),
      '--limit',
      String(clampLimit(input.limit))
    ])
    const payload = unwrapEnvelope(response, 'DWS message list')
    return findArray(payload).map((item) => normalizeMessage(item, input.groupId))
  }

  async sendMessage(input: {
    groupId: string
    text: string
    uuid: string
  }): Promise<DwsSendResult> {
    this.assertGroupAllowed(input.groupId)
    if (!input.text.trim()) throw new Error('拒绝发送空消息')
    if (!UUID_PATTERN.test(input.uuid)) throw new Error('DWS 幂等 UUID 格式不合法')

    const response = await this.run([
      'chat',
      'message',
      'send',
      '--group',
      input.groupId,
      '--text',
      input.text,
      '--uuid',
      input.uuid
    ])
    const payload = unwrapEnvelope(response, 'DWS message send')
    const platformTaskId = findString(payload, ['openTaskId'])
    const messageId = findString(payload, ['openMessageId', 'messageId'])
    const deduplicated = findBoolean(payload, ['deduplicated'])
    if (!platformTaskId && !messageId && deduplicated !== true) {
      throw Object.assign(
        new Error('DWS 发送命令未返回可确认回执；为避免把未知结果误报为发送成功，已停止处理'),
        { code: 'DWS_SEND_RECEIPT_UNCONFIRMED' }
      )
    }
    return {
      deduplicated: deduplicated === true,
      ...(platformTaskId ? { platformTaskId } : {}),
      ...(messageId ? { messageId } : {})
    }
  }

  private assertGroupAllowed(groupId: string): void {
    if (!this.allowlistedGroups.has(groupId)) {
      throw Object.assign(new Error(`群聊不在 LuckyTag 白名单中：${groupId}`), {
        code: 'GROUP_NOT_ALLOWLISTED'
      })
    }
  }

  private run(args: readonly string[], timeoutMs?: number): Promise<unknown> {
    return this.runner.runJson(this.executable, [...args, '--format', 'json'], {
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })
  }
}

const normalizeAuthStatus = (response: unknown, defaultDetail: string): DwsAuthStatus => {
  const payload = unwrapEnvelope(response, 'DWS auth status')
  const explicit =
    findBoolean(response, ['authenticated', 'loggedIn', 'connected', 'valid']) ??
    findBoolean(payload, ['authenticated', 'loggedIn', 'connected', 'valid'])
  // `success:true` and generic `status:ok` mean only that the CLI command ran.
  // DWS is connected only when the status response explicitly confirms identity.
  const authenticated = explicit === true
  const detail =
    findString(response, ['detail', 'message', 'userName', 'name']) ??
    findString(payload, ['detail', 'message', 'userName', 'name']) ??
    (authenticated ? defaultDetail : '钉钉 DWS 尚未认证')
  const version =
    findString(response, ['version', 'cliVersion']) ??
    findString(payload, ['version', 'cliVersion'])
  return { authenticated, detail, ...(version ? { version } : {}) }
}

const normalizeMessage = (value: unknown, fallbackGroupId: string): DwsMessage => {
  const record = isRecord(value) ? value : {}
  const groupId =
    findString(record, ['openConversationId', 'conversationId', 'groupId', 'openCid']) ??
    fallbackGroupId
  const createdAt = toIsoDate(
    record.createTime ?? record.createdAt ?? record.sendTime ?? record.timestamp,
    new Date(0)
  )
  const senderId = findString(record, [
    'senderUserId',
    'senderOpenDingTalkId',
    'senderId',
    'userId',
    'openDingTalkId'
  ])
  const senderLabel = findString(record, ['senderName', 'nick', 'nickname', 'displayName', 'name'])
  const text = extractMessageText(record)
  const suppliedId = findString(record, ['openMessageId', 'messageId', 'msgId', 'id'])
  const id =
    suppliedId ??
    `generated-${createHash('sha256')
      .update(`${groupId}\0${createdAt}\0${senderId ?? ''}\0${text}`)
      .digest('hex')
      .slice(0, 32)}`
  const status = findString(record, ['status', 'messageStatus', 'recallStatus'])?.toLowerCase()
  const recalled =
    findBoolean(record, ['recalled', 'isRecalled', 'isRecall', 'withdrawn']) ??
    Boolean(status && ['recalled', 'withdrawn', 'deleted'].includes(status))
  const direction = findString(record, ['direction', 'flow'])?.toLowerCase()
  const isSelf =
    findBoolean(record, ['isSelf', 'self', 'isMine', 'sendByMe', 'sentByMe']) ??
    Boolean(direction && ['out', 'outgoing', 'sent'].includes(direction))
  return {
    id,
    groupId,
    text,
    createdAt,
    recalled,
    isSelf,
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {})
  }
}

const extractMessageText = (record: Record<string, unknown>): string => {
  const direct = findString(record, ['text', 'msgText', 'message'])
  if (direct) return direct
  const content = record.content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed) return ''
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        return findString(parsed, ['text', 'content', 'title']) ?? trimmed
      } catch {
        return trimmed
      }
    }
    return trimmed
  }
  return findString(content, ['text', 'content', 'title', 'markdown']) ?? ''
}

const clampLimit = (limit: number | undefined): number =>
  Math.max(1, Math.min(30, Number.isInteger(limit) ? (limit ?? 30) : 30))

const formatDwsTime = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19).replace('T', ' ')
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export { normalizeMessage as normalizeDwsMessage }

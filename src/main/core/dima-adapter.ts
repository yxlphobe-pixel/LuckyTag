import type { JsonCliRunner } from './cli-runner'
import { findArray, findString, isRecord, unwrapEnvelope } from './value-utils'

export interface DimaTemplate {
  workItemId: string
  title: string
  spaceId: string
  spaceName: string
  workItemTypeId: string
  priorityId?: string
  processor?: DimaTemplateUser
  members: DimaTemplateUser[]
  verifiers: DimaTemplateUser[]
  tags: string[]
}

export interface DimaTemplateUser {
  value: string
  label: string
}

export interface DimaSprint {
  id: string
  name: string
  spaceId: string
}

export interface DimaCreateRequest {
  title: string
  description: string
  spaceId: string
  workItemTypeId: string
  priorityId?: string
  processor?: string
  members: string[]
  verifiers: string[]
  tags: string[]
  sprintId?: string
}

export interface DimaCreatedWorkItem {
  workItemId: string
  url: string
}

export interface DimaGateway {
  resolveSpace(input: string): Promise<{ id: string; name: string }>
  getTemplate(workItemId: string): Promise<DimaTemplate>
  resolveSprint(spaceId: string, input: string): Promise<DimaSprint>
  createRequirement(input: DimaCreateRequest): Promise<DimaCreatedWorkItem>
}

export class DimaAdapter implements DimaGateway {
  private readonly runner: JsonCliRunner
  private readonly executable: string

  constructor(runner: JsonCliRunner, executable = 'dima') {
    this.runner = runner
    this.executable = executable
  }

  async resolveSpace(input: string): Promise<{ id: string; name: string }> {
    const directId = extractSpaceId(input)
    if (directId) return { id: directId, name: directId }

    const response = await this.run(['space', 'list', '--member', '--all', '-o', 'json'], 60_000)
    const spaces = findArray(response).flatMap((value) => {
      if (!isRecord(value)) return []
      const id = findString(value, ['workspaceId', 'spaceId', 'id'])
      const name = findString(value, ['workspaceName', 'spaceName', 'name', 'title'])
      return id && name && SPACE_ID_PATTERN.test(id) ? [{ id, name }] : []
    })
    const exact = spaces.filter((space) => space.name === input.trim())
    if (exact.length === 1) return exact[0] as { id: string; name: string }
    if (exact.length === 0) {
      throw Object.assign(
        new Error(`没有在当前用户参与的 Dima 空间中找到「${input.trim()}」，请改用 W 开头的空间 ID 或空间链接`),
        { code: 'DIMA_SPACE_NOT_FOUND' }
      )
    }
    throw Object.assign(new Error(`Dima 空间名称「${input.trim()}」不唯一，请改用空间 ID 或空间链接`), {
      code: 'DIMA_SPACE_AMBIGUOUS'
    })
  }

  async getTemplate(workItemId: string): Promise<DimaTemplate> {
    const response = await this.run([
      'workitem',
      'get',
      workItemId,
      '--with-custom-fields',
      '--with-tags',
      '-o',
      'json'
    ], 90_000)
    const payload = unwrapEnvelope(response, 'Dima 模板读取')
    if (!isRecord(payload)) throw invalidDimaResponse('Dima 模板返回格式不完整')
    const normalizedId = findString(payload, ['workItemId', 'workitemId', 'id'])
    const title = findString(payload, ['subject', 'title', 'name'])
    const spaceId = findString(payload, ['workspaceId', 'spaceId'])
    const spaceName = findString(payload, ['workspace', 'workspaceName', 'spaceName']) ?? spaceId
    const workItemTypeId = findString(payload, ['workItemTypeId', 'workitemTypeId'])
    const category = findString(payload, ['workItemCategory', 'category'])
    if (!normalizedId || !WORK_ITEM_ID_PATTERN.test(normalizedId) || !title || !spaceId || !workItemTypeId) {
      throw invalidDimaResponse('Dima 模板缺少工作项 ID、标题、空间或模板类型')
    }
    if (category && category !== 'Req') {
      throw Object.assign(new Error('所选 Dima 模板不是需求类型'), { code: 'DIMA_TEMPLATE_NOT_REQUIREMENT' })
    }

    const customFieldMap = isRecord(payload.customFieldMap) ? payload.customFieldMap : {}
    const processor = normalizeUsers(payload.processors)[0]
    const priorityId = findString(payload, ['priorityId'])
    return {
      workItemId: normalizedId,
      title,
      spaceId,
      spaceName: spaceName ?? spaceId,
      workItemTypeId,
      ...(priorityId ? { priorityId } : {}),
      ...(processor ? { processor } : {}),
      members: normalizeUsers(isRecord(customFieldMap.member) ? customFieldMap.member.users : undefined),
      verifiers: normalizeUsers(isRecord(customFieldMap.verifier) ? customFieldMap.verifier.users : undefined),
      tags: normalizeTags(payload.tags)
    }
  }

  async resolveSprint(spaceId: string, input: string): Promise<DimaSprint> {
    const directId = extractSprintId(input)
    if (directId) {
      const response = await this.run(['sprint', 'get', directId, '-o', 'json'], 60_000)
      return normalizeSprint(unwrapEnvelope(response, 'Dima 迭代读取'), spaceId)
    }

    const response = await this.run([
      'sprint',
      'search',
      '-s',
      spaceId,
      '-k',
      input.trim(),
      '--page',
      '1',
      '--page-size',
      '30',
      '-o',
      'json'
    ], 60_000)
    const sprints = findArray(response).map((value) => normalizeSprint(value, spaceId, false)).filter(isDimaSprint)
    const exact = sprints.filter((sprint) => sprint.name === input.trim())
    if (exact.length === 1) return exact[0] as DimaSprint
    if (exact.length === 0) {
      throw Object.assign(new Error(`在 Dima 空间 ${spaceId} 中没有找到迭代「${input.trim()}」`), {
        code: 'DIMA_SPRINT_NOT_FOUND'
      })
    }
    throw Object.assign(new Error(`迭代名称「${input.trim()}」不唯一，请改用 S 开头的迭代 ID 或迭代链接`), {
      code: 'DIMA_SPRINT_AMBIGUOUS'
    })
  }

  async createRequirement(input: DimaCreateRequest): Promise<DimaCreatedWorkItem> {
    const args = [
      'workitem',
      'create',
      input.title,
      '-s',
      input.spaceId,
      '--work-item-category',
      'Req',
      '--work-item-type-id',
      input.workItemTypeId,
      '--description',
      input.description
    ]
    if (input.priorityId) args.push('--priority-id', input.priorityId)
    if (input.processor) args.push('--processor', input.processor)
    if (input.members.length > 0) args.push('--member', input.members.join(','))
    if (input.verifiers.length > 0) args.push('--verifier', input.verifiers.join(','))
    if (input.sprintId) args.push('--sprint-id', input.sprintId)
    for (const tag of input.tags) args.push('--tag', tag)
    args.push('-o', 'json')

    const response = await this.run(args, 120_000)
    const payload = unwrapEnvelope(response, 'Dima 需求创建')
    const workItemId = recursiveString(payload, ['workItemId', 'workitemId', 'id'])
    const reportedUrl = recursiveString(payload, ['url', 'workItemUrl', 'workitemUrl'])
    if (!workItemId || !WORK_ITEM_ID_PATTERN.test(workItemId)) {
      throw invalidDimaResponse('Dima 创建命令没有返回可确认的工作项 ID')
    }
    const url = reportedUrl && isDimaUrl(reportedUrl)
      ? reportedUrl
      : `https://project.alipay.com/workItem?workItemId=${encodeURIComponent(workItemId)}`
    return { workItemId, url }
  }

  private run(args: readonly string[], timeoutMs: number): Promise<unknown> {
    return this.runner.runJson(this.executable, args, { timeoutMs, maxBufferBytes: 12 * 1024 * 1024 })
  }
}

export const extractTemplateWorkItemId = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw Object.assign(new Error('Dima 需求模板链接不合法'), { code: 'INVALID_DIMA_TEMPLATE_URL' })
  }
  const id = url.searchParams.get('openWorkItemId') ?? url.searchParams.get('workItemId') ?? ''
  if (url.protocol !== 'https:' || url.hostname !== 'project.alipay.com' || !WORK_ITEM_ID_PATTERN.test(id)) {
    throw Object.assign(new Error('Dima 需求模板链接缺少有效的 openWorkItemId'), {
      code: 'INVALID_DIMA_TEMPLATE_URL'
    })
  }
  return id
}

const extractSpaceId = (value: string): string | undefined => {
  const normalized = value.trim()
  if (SPACE_ID_PATTERN.test(normalized)) return normalized
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || url.hostname !== 'project.alipay.com') return undefined
    const fromQuery = url.searchParams.get('spaceId')
    if (fromQuery && SPACE_ID_PATTERN.test(fromQuery)) return fromQuery
    const fromPath = url.pathname.match(/\/space\/(W\d+)/u)?.[1]
    return fromPath && SPACE_ID_PATTERN.test(fromPath) ? fromPath : undefined
  } catch {
    return undefined
  }
}

const extractSprintId = (value: string): string | undefined => {
  const normalized = value.trim()
  if (SPRINT_ID_PATTERN.test(normalized)) return normalized
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || url.hostname !== 'project.alipay.com') return undefined
    const id = url.searchParams.get('sprintId') ?? ''
    return SPRINT_ID_PATTERN.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

const normalizeSprint = (value: unknown, expectedSpaceId: string, strict = true): DimaSprint => {
  if (!isRecord(value)) {
    if (strict) throw invalidDimaResponse('Dima 迭代返回格式不完整')
    return { id: '', name: '', spaceId: '' }
  }
  const id = findString(value, ['sprintId', 'id']) ?? ''
  const name = findString(value, ['name', 'title']) ?? ''
  const spaceId = findString(value, ['targetId', 'workspaceId', 'spaceId']) ?? expectedSpaceId
  if (!SPRINT_ID_PATTERN.test(id) || !name || spaceId !== expectedSpaceId) {
    if (strict) throw Object.assign(new Error('所选迭代不属于目标 Dima 空间'), { code: 'DIMA_SPRINT_SPACE_MISMATCH' })
    return { id: '', name: '', spaceId: '' }
  }
  return { id, name, spaceId }
}

const isDimaSprint = (value: DimaSprint): boolean => Boolean(value.id && value.name && value.spaceId)

const normalizeUsers = (value: unknown): DimaTemplateUser[] => {
  if (!Array.isArray(value)) return []
  const users = value.flatMap((user) => {
    if (!isRecord(user)) return []
    const identity = findString(user, ['staffId', 'nickName', 'nickname', 'displayName', 'showName'])
    const label = findString(user, ['nickName', 'nickname', 'displayName', 'showName', 'staffId'])
    return identity && label ? [{ value: identity, label }] : []
  })
  return users.filter((user, index) => users.findIndex((candidate) => candidate.value === user.value) === index)
}

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((tag) => {
    if (typeof tag === 'string' && tag.trim()) return [tag.trim()]
    if (!isRecord(tag)) return []
    const name = findString(tag, ['name', 'label', 'tagName', 'id'])
    return name ? [name] : []
  }))]
}

const recursiveString = (value: unknown, keys: readonly string[], depth = 0): string | undefined => {
  if (!isRecord(value) || depth > 4) return undefined
  const direct = findString(value, keys)
  if (direct) return direct
  for (const nested of Object.values(value)) {
    const found = recursiveString(nested, keys, depth + 1)
    if (found) return found
  }
  return undefined
}

const isDimaUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'project.alipay.com'
  } catch {
    return false
  }
}

const invalidDimaResponse = (message: string): Error =>
  Object.assign(new Error(message), { code: 'INVALID_DIMA_RESPONSE' })

const SPACE_ID_PATTERN = /^W\d{6,30}$/u
const SPRINT_ID_PATTERN = /^S\d{6,30}$/u
const WORK_ITEM_ID_PATTERN = /^\d{10,32}$/u

import type { JsonCliRunner } from './cli-runner'
import { findArray, findString, isRecord, unwrapEnvelope } from './value-utils'
export interface DemoWorkflowTemplate {
  recordId: string
  title: string
  projectId: string
  projectName: string
  recordTypeId: string
  priorityId?: string
  processor?: DemoWorkflowTemplateUser
  members: DemoWorkflowTemplateUser[]
  verifiers: DemoWorkflowTemplateUser[]
  tags: string[]
}
export interface DemoWorkflowTemplateUser {
  value: string
  label: string
}
export interface DemoWorkflowCycle {
  id: string
  name: string
  projectId: string
}
export interface DemoWorkflowCreateRequest {
  title: string
  description: string
  projectId: string
  recordTypeId: string
  priorityId?: string
  processor?: string
  members: string[]
  verifiers: string[]
  tags: string[]
  cycleId?: string
}
export interface DemoWorkflowCreatedRecord {
  recordId: string
  url: string
}
export interface DemoWorkflowGateway {
  resolveSpace(input: string): Promise<{ id: string; name: string }>
  getTemplate(recordId: string): Promise<DemoWorkflowTemplate>
  resolveCycle(projectId: string, input: string): Promise<DemoWorkflowCycle>
  createRequirement(input: DemoWorkflowCreateRequest): Promise<DemoWorkflowCreatedRecord>
}

export class DemoWorkflowAdapter implements DemoWorkflowGateway {
  private readonly runner: JsonCliRunner
  private readonly executable: string

  constructor(runner: JsonCliRunner, executable = 'sample-workflow-mock') {
    this.runner = runner
    this.executable = executable
  }

  async resolveSpace(input: string): Promise<{ id: string; name: string }> {
    const directId = extractSpaceId(input)
    if (directId) return { id: directId, name: directId }

    const response = await this.run(['space', 'list', '--member', '--all', '-o', 'json'], 60_000)
    const spaces = findArray(response).flatMap((value) => {
      if (!isRecord(value)) return []
      const id = findString(value, ['projectId', 'projectId', 'id'])
      const name = findString(value, ['projectName', 'projectName', 'name', 'title'])
      return id && name && SPACE_ID_PATTERN.test(id) ? [{ id, name }] : []
    })
    const exact = spaces.filter((space) => space.name === input.trim())
    if (exact.length === 1) return exact[0] as { id: string; name: string }
    if (exact.length === 0) {
      throw Object.assign(
        new Error(`没有在当前用户参与的 DemoWorkflow 空间中找到「${input.trim()}」，请改用 P 开头的空间 ID 或空间链接`),
        { code: 'DEMO_WORKFLOW_SPACE_NOT_FOUND' }
      )
    }
    throw Object.assign(new Error(`DemoWorkflow 空间名称「${input.trim()}」不唯一，请改用空间 ID 或空间链接`), {
      code: 'DEMO_WORKFLOW_SPACE_AMBIGUOUS'
    })
  }

  async getTemplate(recordId: string): Promise<DemoWorkflowTemplate> {
    const response = await this.run([
      'record',
      'get',
      recordId,
      '--with-custom-fields',
      '--with-tags',
      '-o',
      'json'
    ], 90_000)
    const payload = unwrapEnvelope(response, 'DemoWorkflow 模板读取')
    if (!isRecord(payload)) throw invalidDemoWorkflowResponse('DemoWorkflow 模板返回格式不完整')
    const normalizedId = findString(payload, ['recordId', 'recordId', 'id'])
    const title = findString(payload, ['subject', 'title', 'name'])
    const projectId = findString(payload, ['projectId', 'projectId'])
    const projectName = findString(payload, ['workspace', 'projectName', 'projectName']) ?? projectId
    const recordTypeId = findString(payload, ['recordTypeId', 'recordTypeId'])
    const category = findString(payload, ['recordCategory', 'category'])
    if (!normalizedId || !RECORD_ID_PATTERN.test(normalizedId) || !title || !projectId || !recordTypeId) {
      throw invalidDemoWorkflowResponse('DemoWorkflow 模板缺少工作项 ID、标题、空间或模板类型')
    }
    if (category && category !== 'Req') {
      throw Object.assign(new Error('所选 DemoWorkflow 模板不是需求类型'), { code: 'DEMO_WORKFLOW_TEMPLATE_NOT_REQUIREMENT' })
    }

    const customFieldMap = isRecord(payload.customFieldMap) ? payload.customFieldMap : {}
    const processor = normalizeUsers(payload.processors)[0]
    const priorityId = findString(payload, ['priorityId'])
    return {
      recordId: normalizedId,
      title,
      projectId,
      projectName: projectName ?? projectId,
      recordTypeId,
      ...(priorityId ? { priorityId } : {}),
      ...(processor ? { processor } : {}),
      members: normalizeUsers(isRecord(customFieldMap.member) ? customFieldMap.member.users : undefined),
      verifiers: normalizeUsers(isRecord(customFieldMap.verifier) ? customFieldMap.verifier.users : undefined),
      tags: normalizeTags(payload.tags)
    }
  }

  async resolveCycle(projectId: string, input: string): Promise<DemoWorkflowCycle> {
    const directId = extractCycleId(input)
    if (directId) {
      const response = await this.run(['cycle', 'get', directId, '-o', 'json'], 60_000)
      return normalizeCycle(unwrapEnvelope(response, 'DemoWorkflow 迭代读取'), projectId)
    }

    const response = await this.run([
      'cycle',
      'search',
      '-s',
      projectId,
      '-k',
      input.trim(),
      '--page',
      '1',
      '--page-size',
      '30',
      '-o',
      'json'
    ], 60_000)
    const cycles = findArray(response).map((value) => normalizeCycle(value, projectId, false)).filter(isDemoWorkflowCycle)
    const exact = cycles.filter((cycle) => cycle.name === input.trim())
    if (exact.length === 1) return exact[0] as DemoWorkflowCycle
    if (exact.length === 0) {
      throw Object.assign(new Error(`在 DemoWorkflow 空间 ${projectId} 中没有找到迭代「${input.trim()}」`), {
        code: 'DEMO_WORKFLOW_CYCLE_NOT_FOUND'
      })
    }
    throw Object.assign(new Error(`迭代名称「${input.trim()}」不唯一，请改用 C 开头的迭代 ID 或迭代链接`), {
      code: 'DEMO_WORKFLOW_CYCLE_AMBIGUOUS'
    })
  }

  async createRequirement(input: DemoWorkflowCreateRequest): Promise<DemoWorkflowCreatedRecord> {
    const args = [
      'record',
      'create',
      input.title,
      '-s',
      input.projectId,
      '--record-category',
      'Req',
      '--record-type-id',
      input.recordTypeId,
      '--description',
      input.description
    ]
    if (input.priorityId) args.push('--priority-id', input.priorityId)
    if (input.processor) args.push('--processor', input.processor)
    if (input.members.length > 0) args.push('--member', input.members.join(','))
    if (input.verifiers.length > 0) args.push('--verifier', input.verifiers.join(','))
    if (input.cycleId) args.push('--cycle-id', input.cycleId)
    for (const tag of input.tags) args.push('--tag', tag)
    args.push('-o', 'json')

    const response = await this.run(args, 120_000)
    const payload = unwrapEnvelope(response, 'DemoWorkflow 需求创建')
    const recordId = recursiveString(payload, ['recordId', 'recordId', 'id'])
    const reportedUrl = recursiveString(payload, ['url', 'recordUrl', 'recordUrl'])
    if (!recordId || !RECORD_ID_PATTERN.test(recordId)) {
      throw invalidDemoWorkflowResponse('DemoWorkflow 创建命令没有返回可确认的工作项 ID')
    }
    const url = reportedUrl && isDemoWorkflowUrl(reportedUrl)
      ? reportedUrl
      : `https://workflow.example.invalid/record?recordId=${encodeURIComponent(recordId)}`
    return { recordId, url }
  }

  private run(args: readonly string[], timeoutMs: number): Promise<unknown> {
    if (this.executable === 'sample-workflow-mock') {
      if (args[0] === 'space') return Promise.resolve([{ projectId: 'P000000', name: 'Public Demo Space' }])
      if (args[0] === 'record' && args[1] === 'get') return Promise.resolve({ recordId: String(args[2]), subject: 'Public mock template', projectId: 'P000000', projectName: 'Public Demo Space', recordTypeId: 'TYPE0000000000', recordCategory: 'Req', tags: [] })
      if (args[0] === 'cycle') return Promise.resolve({ cycleId: String(args[2] ?? 'C000000'), name: 'Public Demo Cycle', targetId: 'P000000' })
      return Promise.resolve({ recordId: '2000000000000000000', url: 'https://workflow.example.invalid/record/2000000000000000000' })
    }
    return this.runner.runJson(this.executable, args, { timeoutMs, maxBufferBytes: 12 * 1024 * 1024 })
  }
}

export const extractTemplateRecordId = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw Object.assign(new Error('DemoWorkflow 需求模板链接不合法'), { code: 'INVALID_DEMO_WORKFLOW_TEMPLATE_URL' })
  }
  const id = url.searchParams.get('templateRecordId') ?? url.searchParams.get('recordId') ?? ''
  if (url.protocol !== 'https:' || url.hostname !== 'workflow.example.invalid' || !RECORD_ID_PATTERN.test(id)) {
    throw Object.assign(new Error('DemoWorkflow 需求模板链接缺少有效的 templateRecordId'), {
      code: 'INVALID_DEMO_WORKFLOW_TEMPLATE_URL'
    })
  }
  return id
}

const extractSpaceId = (value: string): string | undefined => {
  const normalized = value.trim()
  if (SPACE_ID_PATTERN.test(normalized)) return normalized
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || url.hostname !== 'workflow.example.invalid') return undefined
    const fromQuery = url.searchParams.get('projectId')
    if (fromQuery && SPACE_ID_PATTERN.test(fromQuery)) return fromQuery
    const fromPath = url.pathname.match(/\/space\/(W\d+)/u)?.[1]
    return fromPath && SPACE_ID_PATTERN.test(fromPath) ? fromPath : undefined
  } catch {
    return undefined
  }
}

const extractCycleId = (value: string): string | undefined => {
  const normalized = value.trim()
  if (CYCLE_ID_PATTERN.test(normalized)) return normalized
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || url.hostname !== 'workflow.example.invalid') return undefined
    const id = url.searchParams.get('cycleId') ?? ''
    return CYCLE_ID_PATTERN.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

const normalizeCycle = (value: unknown, expectedSpaceId: string, strict = true): DemoWorkflowCycle => {
  if (!isRecord(value)) {
    if (strict) throw invalidDemoWorkflowResponse('DemoWorkflow 迭代返回格式不完整')
    return { id: '', name: '', projectId: '' }
  }
  const id = findString(value, ['cycleId', 'id']) ?? ''
  const name = findString(value, ['name', 'title']) ?? ''
  const projectId = findString(value, ['targetId', 'projectId', 'projectId']) ?? expectedSpaceId
  if (!CYCLE_ID_PATTERN.test(id) || !name || projectId !== expectedSpaceId) {
    if (strict) throw Object.assign(new Error('所选迭代不属于目标 DemoWorkflow 空间'), { code: 'DEMO_WORKFLOW_CYCLE_SPACE_MISMATCH' })
    return { id: '', name: '', projectId: '' }
  }
  return { id, name, projectId }
}

const isDemoWorkflowCycle = (value: DemoWorkflowCycle): boolean => Boolean(value.id && value.name && value.projectId)

const normalizeUsers = (value: unknown): DemoWorkflowTemplateUser[] => {
  if (!Array.isArray(value)) return []
  const users = value.flatMap((user) => {
    if (!isRecord(user)) return []
    const identity = findString(user, ['accountId', 'nickName', 'nickname', 'displayName', 'showName'])
    const label = findString(user, ['nickName', 'nickname', 'displayName', 'showName', 'accountId'])
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

const isDemoWorkflowUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'workflow.example.invalid'
  } catch {
    return false
  }
}

const invalidDemoWorkflowResponse = (message: string): Error =>
  Object.assign(new Error(message), { code: 'INVALID_DEMO_WORKFLOW_RESPONSE' })

const SPACE_ID_PATTERN = /^P\d{6,30}$/u
const CYCLE_ID_PATTERN = /^C\d{6,30}$/u
const RECORD_ID_PATTERN = /^\d{10,32}$/u

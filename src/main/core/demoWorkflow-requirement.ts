import { randomUUID } from 'node:crypto'
import type {
  DemoWorkflowChatWindow,
  DemoWorkflowRequirementCreateInput,
  DemoWorkflowRequirementEvidence,
  DemoWorkflowRequirementInput,
  DemoWorkflowRequirementPreview,
  DemoWorkflowRequirementResult
} from '../../shared/contracts'
import type { DemoWorkflowGateway, DemoWorkflowCycle, DemoWorkflowTemplate } from './demoWorkflow-adapter'
import { extractTemplateRecordId } from './demoWorkflow-adapter'
import type { RequirementChatReader } from './demoMessage-requirement-adapter'
import type { DemoMessageMessage } from './types'

export interface DemoWorkflowRequirementWorkflowOptions {
  chat: RequirementChatReader
  demoWorkflow: DemoWorkflowGateway
  now?: () => Date
}

interface PendingDraft {
  preview: DemoWorkflowRequirementPreview
  template: DemoWorkflowTemplate
  cycle?: DemoWorkflowCycle
  result?: DemoWorkflowRequirementResult
  inFlight?: Promise<DemoWorkflowRequirementResult>
}

export class DemoWorkflowRequirementWorkflow {
  private readonly chat: RequirementChatReader
  private readonly demoWorkflow: DemoWorkflowGateway
  private readonly now: () => Date
  private readonly drafts = new Map<string, PendingDraft>()

  constructor(options: DemoWorkflowRequirementWorkflowOptions) {
    this.chat = options.chat
    this.demoWorkflow = options.demoWorkflow
    this.now = options.now ?? (() => new Date())
  }

  async previewRequirement(input: DemoWorkflowRequirementInput): Promise<DemoWorkflowRequirementPreview> {
    this.removeExpiredDrafts()
    const now = this.now()
    const windowEnd = new Date(now)
    const windowStart = new Date(windowEnd.getTime() - windowMilliseconds(input.chatWindow))
    const templateRecordId = extractTemplateRecordId(input.templateUrl)

    const [group, template, space] = await Promise.all([
      this.chat.findGroupByName(input.groupName),
      this.demoWorkflow.getTemplate(templateRecordId),
      this.demoWorkflow.resolveSpace(input.demoProject)
    ])
    if (template.projectId !== space.id) {
      throw Object.assign(
        new Error(`DemoWorkflow 模板属于空间 ${template.projectName}（${template.projectId}），与目标空间 ${space.id} 不一致`),
        { code: 'DEMO_WORKFLOW_TEMPLATE_SPACE_MISMATCH' }
      )
    }

    const [messages, cycle] = await Promise.all([
      this.chat.readMessages({ groupId: group.id, start: windowStart, end: windowEnd }),
      input.iteration ? this.demoWorkflow.resolveCycle(space.id, input.iteration) : Promise.resolve(undefined)
    ])
    if (messages.length === 0) {
      throw Object.assign(new Error(`群聊「${group.title}」在所选周期内没有可分析的文本消息`), {
        code: 'DEMO_WORKFLOW_REQUIREMENT_NO_CHAT_MESSAGES'
      })
    }

    const generated = generateRequirementDraft(group.title, windowStart, windowEnd, messages)
    const draftId = randomUUID()
    const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS)
    const preview: DemoWorkflowRequirementPreview = {
      draftId,
      title: generated.title,
      description: generated.description,
      groupName: group.title,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      messageCount: messages.length,
      evidence: generated.evidence,
      projectId: space.id,
      projectName: space.name === space.id ? template.projectName : space.name,
      templateRecordId: template.recordId,
      templateTitle: template.title,
      ...(template.processor ? { processor: template.processor.label } : {}),
      members: template.members.map((member) => member.label),
      ...(cycle ? { cycleId: cycle.id, cycleName: cycle.name } : {}),
      expiresAt: expiresAt.toISOString()
    }
    this.drafts.set(draftId, {
      preview: structuredClone(preview),
      template: structuredClone(template),
      ...(cycle ? { cycle: structuredClone(cycle) } : {})
    })
    return structuredClone(preview)
  }

  async createRequirement(input: DemoWorkflowRequirementCreateInput): Promise<DemoWorkflowRequirementResult> {
    this.removeExpiredDrafts()
    const pending = this.drafts.get(input.draftId)
    if (!pending) {
      throw Object.assign(new Error('需求草稿不存在或已过期，请重新分析群聊'), {
        code: 'DEMO_WORKFLOW_REQUIREMENT_DRAFT_EXPIRED'
      })
    }
    if (pending.result) return structuredClone(pending.result)
    if (pending.inFlight) return structuredClone(await pending.inFlight)

    const createPromise = this.demoWorkflow.createRequirement({
      title: input.title,
      description: input.description,
      projectId: pending.preview.projectId,
      recordTypeId: pending.template.recordTypeId,
      ...(pending.template.priorityId ? { priorityId: pending.template.priorityId } : {}),
      ...(pending.template.processor ? { processor: pending.template.processor.value } : {}),
      members: pending.template.members.map((member) => member.value),
      verifiers: pending.template.verifiers.map((verifier) => verifier.value),
      tags: [...pending.template.tags],
      ...(pending.cycle ? { cycleId: pending.cycle.id } : {})
    }).then((created): DemoWorkflowRequirementResult => ({
      recordId: created.recordId,
      title: input.title,
      url: created.url,
      projectId: pending.preview.projectId,
      ...(pending.cycle ? { cycleId: pending.cycle.id } : {}),
      createdAt: this.now().toISOString()
    }))
    pending.inFlight = createPromise
    try {
      const result = await createPromise
      pending.result = structuredClone(result)
      return structuredClone(result)
    } finally {
      delete pending.inFlight
    }
  }

  private removeExpiredDrafts(): void {
    const now = this.now().getTime()
    for (const [draftId, pending] of this.drafts) {
      if (new Date(pending.preview.expiresAt).getTime() <= now && !pending.inFlight) {
        this.drafts.delete(draftId)
      }
    }
  }
}

export const generateRequirementDraft = (
  groupName: string,
  windowStart: Date,
  windowEnd: Date,
  messages: readonly DemoMessageMessage[]
): { title: string; description: string; evidence: DemoWorkflowRequirementEvidence[] } => {
  const relevant = pickRelevantMessages(messages)
  if (relevant.length === 0) {
    throw Object.assign(
      new Error('没有从群聊中识别到明确的需求、问题或修复诉求，请缩短窗口或确认群内存在“记录需求”等表达'),
      { code: 'DEMO_WORKFLOW_REQUIREMENT_NOT_DETECTED' }
    )
  }

  const title = deriveTitle(relevant)
  const evidence = relevant.slice(0, MAX_EVIDENCE).map((message) => ({
    sentAt: message.createdAt,
    sender: message.senderLabel?.trim() || '群成员',
    text: truncate(cleanMessageText(message.text), MAX_EVIDENCE_TEXT)
  }))
  const statements = unique(
    relevant.flatMap((message) => splitStatements(cleanMessageText(message.text)))
  )
  const problems = statements.filter((statement) => PROBLEM_PATTERN.test(statement)).slice(0, 6)
  const requests = statements.filter((statement) => ACTION_PATTERN.test(statement)).slice(0, 6)
  const requirementItems = requests.length > 0 ? requests : statements.slice(0, 6)
  const acceptance = deriveAcceptance(statements)
  const description = [
    '## 1. 需求背景',
    `需求来源：示例消息群「${groupName}」`,
    `分析窗口：${formatTime(windowStart)} 至 ${formatTime(windowEnd)}`,
    `群聊中反馈了与「${title}」相关的问题，需要形成可跟踪、可验收的 DemoWorkflow 需求。`,
    '',
    '## 2. 问题现象',
    ...asBullets(problems.length > 0 ? problems : statements.slice(0, 4)),
    '',
    '## 3. 需求内容',
    ...asBullets(requirementItems),
    '',
    '## 4. 验收标准',
    ...asBullets(acceptance),
    '',
    '## 5. 群聊依据',
    ...evidence.map((item) => `> ${formatTime(new Date(item.sentAt))} ${item.sender}：${item.text}`),
    '',
    '_本草稿由 LuckyTag 根据所选时间窗口内的群聊记录自动整理，创建前可编辑。_'
  ].join('\n')

  return { title, description: truncate(description, MAX_DESCRIPTION_LENGTH), evidence }
}

const pickRelevantMessages = (messages: readonly DemoMessageMessage[]): DemoMessageMessage[] => {
  const usable = messages.filter((message) => !message.recalled && cleanMessageText(message.text).length > 1)
  const scored = usable.map((message, index) => ({ message, index, score: requirementScore(message.text) }))
  const focal = [...scored].sort((left, right) => right.score - left.score)[0]
  if (!focal || focal.score < MIN_REQUIREMENT_SCORE) return []
  const focalTime = new Date(focal.message.createdAt).getTime()
  return scored
    .filter(({ message, index, score }) => {
      const distance = Math.abs(index - focal.index)
      const timeDistance = Math.abs(new Date(message.createdAt).getTime() - focalTime)
      return score >= 3 || (distance <= 4 && timeDistance <= CONTEXT_WINDOW_MS)
    })
    .map(({ message }) => message)
}

const requirementScore = (value: string): number => {
  const text = cleanMessageText(value)
  let score = 0
  if (EXPLICIT_RECORD_PATTERN.test(text)) score += 8
  if (ACTION_PATTERN.test(text)) score += 4
  if (PROBLEM_PATTERN.test(text)) score += 3
  if (TECHNICAL_SIGNAL_PATTERN.test(text)) score += 2
  if (text.length >= 12 && text.length <= 1_200) score += 1
  return score
}

const deriveTitle = (messages: readonly DemoMessageMessage[]): string => {
  const combined = messages.map((message) => cleanMessageText(message.text)).join('；')
  if (
    /Subagent/iu.test(combined) &&
    /(?:parentSpanId|span|链路)/iu.test(combined) &&
    /(?:token|指标|归因)/iu.test(combined)
  ) {
    return '修复 Subagent 场景下链路追踪与指标归因异常'
  }

  const candidates = messages
    .flatMap((message) => splitStatements(cleanMessageText(message.text)))
    .map(stripRequestPrefix)
    .filter((text) => text.length >= 6)
    .map((text) => ({
      text,
      score:
        (TITLE_ACTION_PATTERN.test(text) ? 5 : 0) +
        (PROBLEM_PATTERN.test(text) ? 3 : 0) +
        (TECHNICAL_SIGNAL_PATTERN.test(text) ? 2 : 0) -
        Math.max(0, text.length - 90) / 30
    }))
    .sort((left, right) => right.score - left.score)
  let title = candidates[0]?.text ?? '修复群聊反馈的功能异常'
  title = title.replace(/[。；;，,]+$/u, '').trim()
  if (!TITLE_ACTION_PATTERN.test(title)) {
    title = `${PROBLEM_PATTERN.test(title) ? '修复' : '优化'} ${title}`
  }
  return truncate(title, 120)
}

const deriveAcceptance = (statements: readonly string[]): string[] => {
  const combined = statements.join('；')
  const items: string[] = []
  if (/parentSpanId/iu.test(combined)) {
    items.push('Subagent 子任务的 parentSpanId 应正确关联父任务 Span，不得为空或丢失。')
  }
  if (/Cron/iu.test(combined) && /trigger\s*[=:：]\s*user/iu.test(combined)) {
    items.push('Cron 触发的 Subagent 应归因到真实触发来源，不得错误标记为 user。')
  }
  if (/(?:token|指标).{0,16}(?:场景|归因)|(?:场景|归因).{0,16}(?:token|指标)/iu.test(combined)) {
    items.push('各触发场景的 Token 指标应归因到正确场景，且总 Token 统计保持一致。')
  }
  if (/(?:镜像|image|发布|上线)/iu.test(combined)) {
    items.push('修复随新版 dtclaw 镜像发布，并完成链路追踪与指标统计回归。')
  }
  items.push('群聊中记录的异常场景均有可复现用例，修复后通过回归验证且不引入已有流程退化。')
  return unique(items)
}

const splitStatements = (value: string): string[] =>
  value
    .split(/[\n\r]+|(?<=[。！？!?；;])/u)
    .map((part) => part.trim().replace(/^[\-•*\d.、\s]+/u, ''))
    .filter((part) => part.length >= 4)

const cleanMessageText = (value: string): string =>
  value
    .replace(/<@[^>]+>/gu, '')
    .replace(/(?:https?|wss?):\/\/\S+/giu, '')
    .replace(/[`*_#]+/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .trim()

const stripRequestPrefix = (value: string): string =>
  value
    .replace(/^(?:@\S+\s*)?(?:麻烦|辛苦|请|帮忙|帮我)?\s*(?:记录|记|提|建|新建)(?:一下|下|个)?\s*(?:这个|一个)?\s*(?:需求|问题)?\s*[：:,，\-—\s]*/u, '')
    .replace(/^(?:需求|标题|问题|结论)\s*[：:]\s*/u, '')
    .trim()

const asBullets = (items: readonly string[]): string[] =>
  (items.length > 0 ? items : ['按群聊原始诉求完成实现并补充回归验证。']).map((item) => `- ${item}`)

const unique = (items: readonly string[]): string[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.replace(/\s+/gu, '').toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const formatTime = (date: Date): string =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`

const windowMilliseconds = (window: DemoWorkflowChatWindow): number =>
  window === '24h' ? 24 * HOUR_MS : window === '3d' ? 3 * DAY_MS : 7 * DAY_MS

const EXPLICIT_RECORD_PATTERN = /(?:帮|麻烦|辛苦|请)?.{0,8}(?:记录|记下|提|建|新建).{0,8}(?:需求|问题)|(?:需求|问题|标题)\s*[：:]/iu
const ACTION_PATTERN = /(?:需要|请|麻烦|计划|建议|要求)?.{0,8}(?:修复|新增|支持|优化|调整|改造|升级|发布|补充|解决)/iu
const TITLE_ACTION_PATTERN = /^(?:修复|新增|支持|优化|调整|改造|升级|发布|补充|解决)/iu
const PROBLEM_PATTERN = /(?:异常|错误|失败|不正确|不对|不生效|丢失|为空|为\s*null|null|归因|问题|bug)/iu
const TECHNICAL_SIGNAL_PATTERN = /(?:Subagent|parentSpanId|Cron|trigger|token|span|链路|指标|镜像|dtclaw)/iu
const MIN_REQUIREMENT_SCORE = 5
const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS
const CONTEXT_WINDOW_MS = 45 * 60 * 1_000
const DRAFT_TTL_MS = 30 * 60 * 1_000
const MAX_EVIDENCE = 12
const MAX_EVIDENCE_TEXT = 800
const MAX_DESCRIPTION_LENGTH = 18_000

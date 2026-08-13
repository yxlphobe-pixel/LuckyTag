import { describe, expect, it } from 'vitest'
import type { DemoWorkflowRequirementInput } from '../../src/shared/contracts'
import {
  DemoWorkflowAdapter,
  type DemoWorkflowCreateRequest,
  type DemoWorkflowGateway,
  type DemoWorkflowTemplate
} from '../../src/main/core/demoWorkflow-adapter'
import {
  DemoWorkflowRequirementWorkflow,
  generateRequirementDraft
} from '../../src/main/core/demoWorkflow-requirement'
import {
  DemoMessageRequirementAdapter,
  type RequirementChatReader
} from '../../src/main/core/demoMessage-requirement-adapter'
import type { JsonCliRunner, RunJsonOptions } from '../../src/main/core/cli-runner'
import type { DemoMessageMessage } from '../../src/main/core/types'

class RecordingRunner implements JsonCliRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options?: RunJsonOptions }> = []
  responses: unknown[] = []

  async runJson<T>(executable: string, args: readonly string[], options?: RunJsonOptions): Promise<T> {
    this.calls.push({ executable, args, ...(options ? { options } : {}) })
    return this.responses.shift() as T
  }
}

class FixtureChat implements RequirementChatReader {
  constructor(private readonly messages: DemoMessageMessage[]) {}

  async findGroupByName(groupName: string): Promise<{ id: string; title: string }> {
    return { id: 'group-link', title: groupName }
  }

  async readMessages(): Promise<DemoMessageMessage[]> {
    return structuredClone(this.messages)
  }
}

class FixtureDemoWorkflow implements DemoWorkflowGateway {
  readonly createCalls: DemoWorkflowCreateRequest[] = []
  readonly template: DemoWorkflowTemplate = {
    recordId: '2026000000000000001',
    title: '参考需求模板',
    projectId: 'P26000000001',
    projectName: '示例空间',
    recordTypeId: 'TYPE2024001000001',
    priorityId: '95',
    processor: { value: '100001', label: '负责人甲' },
    members: [
      { value: '100002', label: '成员乙' },
      { value: '100003', label: '成员丙' }
    ],
    verifiers: [],
    tags: []
  }

  async resolveSpace(): Promise<{ id: string; name: string }> {
    return { id: 'P26000000001', name: '示例空间' }
  }

  async getTemplate(): Promise<DemoWorkflowTemplate> {
    return structuredClone(this.template)
  }

  async resolveCycle(): Promise<{ id: string; name: string; projectId: string }> {
    return { id: 'C26000000002', name: '示例迭代', projectId: 'P26000000001' }
  }

  async createRequirement(input: DemoWorkflowCreateRequest): Promise<{ recordId: string; url: string }> {
    this.createCalls.push(structuredClone(input))
    return {
      recordId: '2026000000000000002',
      url: 'https://workflow.example.invalid/record?recordId=2026000000000000002'
    }
  }
}

const input: DemoWorkflowRequirementInput = {
  groupName: '链路联调群',
  chatWindow: '24h',
  demoProject: '示例空间',
  iteration: '示例迭代',
  templateUrl: 'https://workflow.example.invalid/space/P26000000001/cycle/detail?cycleId=C26000000002&templateRecordId=2026000000000000001'
}

const fixtureMessages = (): DemoMessageMessage[] => [
  message('m1', '2026-07-31T08:00:00.000Z', '同学A', 'Subagent 子任务的 parentSpanId 现在为 null，链路串不起来。'),
  message('m2', '2026-07-31T08:02:00.000Z', '负责人甲', '帮我记录一个需求：修复 Subagent 场景下链路追踪与指标归因异常。'),
  message('m3', '2026-07-31T08:04:00.000Z', '同学B', 'Cron spawn 的 Subagent 现在 trigger=user。'),
  message('m4', '2026-07-31T08:06:00.000Z', '负责人甲', 'Token 总数没问题，但是场景指标归因错了，修完要发布新版 dtclaw 镜像。')
]

describe('DemoWorkflow requirement workflow', () => {
  it('turns a de-identified chain-tracing chat case into an editable, template-backed DemoWorkflow draft', async () => {
    const demoWorkflow = new FixtureDemoWorkflow()
    const workflow = new DemoWorkflowRequirementWorkflow({
      chat: new FixtureChat(fixtureMessages()),
      demoWorkflow,
      now: () => new Date('2026-07-31T12:00:00.000Z')
    })

    const preview = await workflow.previewRequirement(input)

    expect(preview).toMatchObject({
      title: '修复 Subagent 场景下链路追踪与指标归因异常',
      groupName: '链路联调群',
      messageCount: 4,
      projectId: 'P26000000001',
      projectName: '示例空间',
      cycleId: 'C26000000002',
      cycleName: '示例迭代',
      templateRecordId: '2026000000000000001',
      processor: '负责人甲',
      members: ['成员乙', '成员丙']
    })
    expect(preview.description).toContain('parentSpanId 应正确关联父任务 Span')
    expect(preview.description).toContain('不得错误标记为 user')
    expect(preview.description).toContain('总 Token 统计保持一致')
    expect(preview.description).toContain('新版 dtclaw 镜像')
    expect(preview.evidence.map((evidence) => evidence.sender)).toContain('负责人甲')
  })

  it('creates at most once per draft and inherits safe template fields', async () => {
    const demoWorkflow = new FixtureDemoWorkflow()
    const workflow = new DemoWorkflowRequirementWorkflow({
      chat: new FixtureChat(fixtureMessages()),
      demoWorkflow,
      now: () => new Date('2026-07-31T12:00:00.000Z')
    })
    const preview = await workflow.previewRequirement(input)
    const createInput = {
      draftId: preview.draftId,
      title: `${preview.title}（已确认）`,
      description: `${preview.description}\n\n补充验收说明。`
    }

    const [first, second] = await Promise.all([
      workflow.createRequirement(createInput),
      workflow.createRequirement(createInput)
    ])

    expect(first).toEqual(second)
    expect(first.url).toBe('https://workflow.example.invalid/record?recordId=2026000000000000002')
    expect(demoWorkflow.createCalls).toHaveLength(1)
    expect(demoWorkflow.createCalls[0]).toMatchObject({
      projectId: 'P26000000001',
      cycleId: 'C26000000002',
      recordTypeId: 'TYPE2024001000001',
      priorityId: '95',
      processor: '100001',
      members: ['100002', '100003']
    })
  })

  it('refuses to apply a template from another DemoWorkflow space', async () => {
    const demoWorkflow = new FixtureDemoWorkflow()
    demoWorkflow.template.projectId = 'P99999999999'
    const workflow = new DemoWorkflowRequirementWorkflow({
      chat: new FixtureChat(fixtureMessages()),
      demoWorkflow,
      now: () => new Date('2026-07-31T12:00:00.000Z')
    })

    await expect(workflow.previewRequirement(input)).rejects.toMatchObject({
      code: 'DEMO_WORKFLOW_TEMPLATE_SPACE_MISMATCH'
    })
  })

  it('condenses the observed Subagent signals into a concise title and removes WebSocket URLs', () => {
    const generated = generateRequirementDraft(
      '链路联调群',
      new Date('2026-07-31T00:00:00.000Z'),
      new Date('2026-07-31T12:00:00.000Z'),
      [
        message('r1', '2026-07-31T08:00:00.000Z', '同学A', '因为用了 Subagent，子任务 parentSpanId 是 null。'),
        message('r2', '2026-07-31T08:02:00.000Z', '同学B', '这个有问题需要修复，后续升级 dtclaw 镜像。'),
        message('r3', '2026-07-31T08:04:00.000Z', '负责人甲', '总 token 不受影响，但按场景拆分的指标归因会有问题。'),
        message('r4', '2026-07-31T08:06:00.000Z', '同学C', 'wss://internal.example.test/openapi?tenantId=123')
      ]
    )

    expect(generated.title).toBe('修复 Subagent 场景下链路追踪与指标归因异常')
    expect(generated.description).not.toContain('wss://')
    expect(generated.evidence.every((item) => !item.text.includes('tenantId'))).toBe(true)
  })
})

describe('DemoWorkflowAdapter', () => {
  it('reads template and cycle JSON, then creates with verified CLI flags', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      {
        recordId: '2026000000000000001',
        subject: '参考需求',
        recordCategory: 'Req',
        recordTypeId: 'TYPE2024001000001',
        priorityId: '95',
        workspace: '示例空间',
        projectId: 'P26000000001',
        processors: [{ accountId: '100001', nickName: '负责人甲' }],
        customFieldMap: {
          member: { users: [{ accountId: '100002', nickName: '成员乙' }] },
          verifier: { users: [{ accountId: '100004', nickName: '验证人丁' }] }
        }
      },
      [{ cycleId: 'C26000000002', name: '示例迭代', targetId: 'P26000000001' }],
      {
        recordId: '2026000000000000002',
        url: 'https://workflow.example.invalid/record?recordId=2026000000000000002'
      }
    )
    const adapter = new DemoWorkflowAdapter(runner, 'sample-workflow-fixture')

    await expect(adapter.resolveSpace('P26000000001')).resolves.toEqual({
      id: 'P26000000001',
      name: 'P26000000001'
    })
    const template = await adapter.getTemplate('2026000000000000001')
    const cycle = await adapter.resolveCycle('P26000000001', '示例迭代')
    const created = await adapter.createRequirement({
      title: '修复链路异常',
      description: '## 需求内容\n修复问题',
      projectId: 'P26000000001',
      recordTypeId: template.recordTypeId,
      ...(template.priorityId ? { priorityId: template.priorityId } : {}),
      ...(template.processor ? { processor: template.processor.value } : {}),
      members: template.members.map((member) => member.value),
      verifiers: template.verifiers.map((verifier) => verifier.value),
      tags: [],
      cycleId: cycle.id
    })

    expect(template.processor).toEqual({ value: '100001', label: '负责人甲' })
    expect(template.members).toEqual([{ value: '100002', label: '成员乙' }])
    expect(cycle.id).toBe('C26000000002')
    expect(created.recordId).toBe('2026000000000000002')
    expect(runner.calls[0]?.args).toEqual(expect.arrayContaining([
      'record', 'get', '2026000000000000001', '--with-custom-fields', '--with-tags', '-o', 'json'
    ]))
    expect(runner.calls[1]?.args).toEqual(expect.arrayContaining([
      'cycle', 'search', '-s', 'P26000000001', '-k', '示例迭代', '--page-size', '30', '-o', 'json'
    ]))
    expect(runner.calls[2]?.args).toEqual(expect.arrayContaining([
      'record', 'create', '修复链路异常', '-s', 'P26000000001', '--processor', '100001',
      '--member', '100002', '--verifier', '100004', '--cycle-id', 'C26000000002', '-o', 'json'
    ]))
  })
})

describe('DemoMessageRequirementAdapter', () => {
  it('uses exact group matching and paginates the read-only message window in batches of 30', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      {
        success: true,
        result: {
          groups: [{ title: '链路联调群', channelId: 'group-link' }],
          hasMore: false
        }
      },
      {
        success: true,
        result: {
          messages: [{
            eventId: 'm1',
            channelId: 'group-link',
            content: '{"text":"帮我记录需求：修复链路异常"}',
            createTime: '2026-07-31T08:00:00.000Z',
            sender: { name: '负责人甲' }
          }],
          hasMore: true
        }
      },
      {
        success: true,
        result: {
          messages: [{
            eventId: 'm2',
            channelId: 'group-link',
            content: '{"text":"需要发布新版镜像"}',
            createTime: '2026-07-31T08:02:00.000Z',
            sender: { name: '同学B' }
          }],
          hasMore: false
        }
      }
    )
    const adapter = new DemoMessageRequirementAdapter(runner, 'sample-chat-fixture')
    const group = await adapter.findGroupByName('链路联调群')
    const messages = await adapter.readMessages({
      groupId: group.id,
      start: new Date('2026-07-31T00:00:00.000Z'),
      end: new Date('2026-07-31T12:00:00.000Z')
    })

    expect(group.id).toBe('group-link')
    expect(messages.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[0]?.args.slice(-2)).toEqual(['--format', 'json'])
    expect(runner.calls[1]?.args).toEqual(expect.arrayContaining([
      'chat', 'message', 'list', '--direction', 'newer', '--limit', '30'
    ]))
  })

  it('does not guess when multiple exact-name groups are returned', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({
      success: true,
      result: {
        groups: [
          { title: '同名群', channelId: 'group-1' },
          { title: '同名群', channelId: 'group-2' }
        ]
      }
    })

    await expect(new DemoMessageRequirementAdapter(runner, 'sample-chat-fixture').findGroupByName('同名群')).rejects.toMatchObject({
      code: 'DEMO_MESSAGE_GROUP_AMBIGUOUS'
    })
  })
})

const message = (id: string, createdAt: string, senderLabel: string, text: string): DemoMessageMessage => ({
  id,
  groupId: 'group-link',
  text,
  createdAt,
  recalled: false,
  isSelf: false,
  senderLabel
})

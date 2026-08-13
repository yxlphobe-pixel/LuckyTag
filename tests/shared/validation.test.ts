import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/contracts'
import {
  assertAgentRuntimeKind,
  assertAppConfig,
  assertDemoWorkflowRequirementCreateInput,
  assertDemoWorkflowRequirementInput,
  assertDemoWorkflowRequirementUrl,
  isAppConfig
} from '../../src/shared/validation'

describe('Agent runtime validation', () => {
  it.each(['codex', 'claude-code'] as const)('accepts supported runtime %s', (runtime) => {
    expect(assertAgentRuntimeKind(runtime)).toBe(runtime)
  })

  it.each([undefined, '', 'Codex', 'claude', { runtime: 'codex' }])(
    'rejects unsupported runtime input %j',
    (runtime) => {
      expect(() => assertAgentRuntimeKind(runtime)).toThrow('不支持的 Agent Runtime')
    }
  )
})

const configWithLocalPath = (path: string): AppConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  knowledgeSources: [
    {
      id: 'local-docs',
      type: 'local-directory',
      label: '本地知识库',
      path,
      enabled: true
    }
  ]
})

describe('DemoWorkflow requirement validation', () => {
  it('normalizes the form and accepts an optional empty iteration', () => {
    expect(assertDemoWorkflowRequirementInput({
      groupName: '  链路联调群  ',
      chatWindow: '24h',
      demoProject: ' 示例空间 ',
      iteration: '',
      templateUrl: 'https://workflow.example.invalid/space/P26000000001/cycle/detail?templateRecordId=2026000000000000001'
    })).toMatchObject({
      groupName: '链路联调群',
      demoProject: '示例空间',
      iteration: ''
    })
  })

  it.each([
    'https://example.com/?templateRecordId=2026000000000000001',
    'http://workflow.example.invalid/?templateRecordId=2026000000000000001',
    'https://workflow.example.invalid/space/P26000000001'
  ])('rejects an unsafe or incomplete template URL: %s', (templateUrl) => {
    expect(() => assertDemoWorkflowRequirementInput({
      groupName: '群聊',
      chatWindow: '24h',
      demoProject: '示例空间',
      iteration: '',
      templateUrl
    })).toThrow()
  })

  it('allows Markdown newlines in an edited draft but rejects non-DemoWorkflow output links', () => {
    expect(assertDemoWorkflowRequirementCreateInput({
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      title: '修复链路异常',
      description: '## 需求内容\n- 修复问题'
    }).description).toContain('\n')
    expect(() => assertDemoWorkflowRequirementUrl('https://example.com/record?id=1')).toThrow()
  })
})

describe('app config validation', () => {
  it('accepts a normal local directory path including spaces', () => {
    expect(isAppConfig(configWithLocalPath('/Users/example/My Knowledge'))).toBe(true)
  })

  it.each(['\0', '\n', '\t', '\u001f', '\u007f', '\u0085'])(
    'rejects a local directory path containing control character %j',
    (controlCharacter) => {
      const config = configWithLocalPath(`/Users/example/Knowledge${controlCharacter}Injected`)

      expect(isAppConfig(config)).toBe(false)
      expect(() => assertAppConfig(config)).toThrow('配置格式不合法')
    }
  )

  it('rejects C0/C1 controls in SampleLibrary routes and namespaces', () => {
    const document = structuredClone(DEFAULT_CONFIG)
    document.knowledgeSources = [{
      id: 'sampleLibrary-doc',
      type: 'sampleLibrary-doc',
      label: '文档',
      routeOrUrl: 'team/book/doc\u0000',
      enabled: true
    }]
    expect(isAppConfig(document)).toBe(false)

    const book = structuredClone(DEFAULT_CONFIG)
    book.knowledgeSources = [{
      id: 'sampleLibrary-book',
      type: 'sampleLibrary-book',
      label: '知识库',
      namespace: 'team/book\u0085',
      enabled: true
    }]
    expect(isAppConfig(book)).toBe(false)
  })
})

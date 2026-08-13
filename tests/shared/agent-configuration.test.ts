import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/contracts'
import {
  assertAgentConfigurationInput,
  assertAppConfig,
  isAppConfig,
  migrateAppConfig
} from '../../src/shared/validation'

describe('Agent 应用配置', () => {
  const codexApiKey = {
    provider: 'custom',
    protocol: 'openai-responses',
    authentication: 'api-key'
  } as const

  it('将旧版 v1 配置无损迁移为 v3 并补齐 Agent 默认值', () => {
    const { agent: _agent, ...current } = structuredClone(DEFAULT_CONFIG)
    const legacy = { ...current, version: 1 }

    const migrated = migrateAppConfig(legacy)

    expect(migrated.version).toBe(3)
    expect(migrated.agent).toEqual(DEFAULT_CONFIG.agent)
    expect(migrated.groups).toEqual(legacy.groups)
    expect(isAppConfig(migrated)).toBe(true)
  })

  it('允许 HTTPS 与本机回环 HTTP，拒绝远程明文 HTTP', () => {
    expect(assertAgentConfigurationInput({
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      ...codexApiKey,
      modelName: 'gpt-test',
      baseUrl: 'https://models.example.test/v1'
    }).baseUrl).toBe('https://models.example.test/v1')

    expect(assertAgentConfigurationInput({
      enabled: true,
      runtime: 'claude-code',
      mode: 'custom-model',
      provider: 'custom',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      modelName: 'claude-test',
      baseUrl: 'http://127.0.0.1:11434/v1'
    }).baseUrl).toBe('http://127.0.0.1:11434/v1')

    expect(() => assertAgentConfigurationInput({
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      ...codexApiKey,
      modelName: 'gpt-test',
      baseUrl: 'http://models.example.test/v1'
    })).toThrow('模型 URL')
  })

  it('自定义模型模式要求模型名，且禁止同时设置与清除 Key', () => {
    expect(() => assertAgentConfigurationInput({
      enabled: false,
      runtime: 'codex',
      mode: 'custom-model',
      ...codexApiKey,
      modelName: '',
      baseUrl: 'https://api.openai.com/v1'
    })).toThrow('模型名称')

    expect(() => assertAgentConfigurationInput({
      enabled: false,
      runtime: 'codex',
      mode: 'custom-model',
      ...codexApiKey,
      modelName: 'valid-model-for-mutual-exclusion-check',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret-value',
      clearApiKey: true
    })).toThrow('同时设置和清除')
  })

  it('Runtime 默认模式不要求自定义模型或 URL', () => {
    expect(assertAgentConfigurationInput({
      enabled: true,
      runtime: 'codex',
      mode: 'runtime-default',
      provider: 'openai',
      protocol: 'openai-responses',
      authentication: 'api-key',
      modelName: '',
      baseUrl: ''
    })).toEqual({
      enabled: true,
      runtime: 'codex',
      mode: 'runtime-default',
      provider: 'openai',
      protocol: 'openai-responses',
      authentication: 'api-key',
      modelName: '',
      baseUrl: ''
    })
  })

  it('普通配置会剥离伪装成扩展字段的 API Key', () => {
    const proposed = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>
    const agent = proposed.agent as Record<string, unknown>
    agent.apiKey = 'must-not-survive'
    ;(agent.model as Record<string, unknown>).apiKey = 'must-not-survive-either'

    const validated = assertAppConfig(proposed)

    expect(validated).not.toHaveProperty('agent.apiKey')
    expect(validated).not.toHaveProperty('agent.model.apiKey')
  })

  it('拒绝模型控制字符以及 URL 的 userinfo 与 fragment', () => {
    const base = {
      enabled: true,
      runtime: 'codex' as const,
      mode: 'custom-model' as const,
      ...codexApiKey,
      modelName: 'safe-model',
      baseUrl: 'https://models.example.test/v1'
    }
    expect(() => assertAgentConfigurationInput({ ...base, modelName: 'bad\u0085model' })).toThrow('模型名称')
    expect(() => assertAgentConfigurationInput({ ...base, baseUrl: 'https://user:password@models.example.test/v1' })).toThrow('模型 URL')
    expect(() => assertAgentConfigurationInput({ ...base, baseUrl: 'https://models.example.test/v1#secret' })).toThrow('模型 URL')
  })

  it('迁移早期 v2 Agent 配置并根据模型名推断模式', () => {
    const earlyV2 = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>
    earlyV2.version = 2
    const agent = earlyV2.agent as Record<string, unknown>
    delete agent.mode
    const model = agent.model as Record<string, unknown>
    delete model.provider
    delete model.protocol
    delete model.authentication
    model.name = 'existing-model'
    model.baseUrl = 'https://models.example.test/v1'

    expect(migrateAppConfig(earlyV2).agent).toMatchObject({
      mode: 'custom-model',
      model: { provider: 'custom', protocol: 'openai-responses', authentication: 'api-key' }
    })
  })

  it('不接受缺少 Agent 安全元数据的 v3 配置', () => {
    const { agent: _agent, ...withoutAgent } = structuredClone(DEFAULT_CONFIG)
    expect(isAppConfig(withoutAgent)).toBe(false)
  })

  it('只允许本机回环 Endpoint 使用无认证', () => {
    expect(assertAgentConfigurationInput({
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      provider: 'ollama',
      protocol: 'openai-responses',
      authentication: 'none',
      modelName: 'qwen3',
      baseUrl: 'http://127.0.0.1:11434/v1'
    })).toMatchObject({ provider: 'ollama', authentication: 'none' })

    expect(() => assertAgentConfigurationInput({
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      provider: 'custom',
      protocol: 'openai-responses',
      authentication: 'none',
      modelName: 'remote-model',
      baseUrl: 'https://models.example.test/v1'
    })).toThrow('无认证仅允许本机回环地址')
  })

  it('拒绝 Runtime、协议和 Provider 的不兼容组合', () => {
    expect(() => assertAgentConfigurationInput({
      enabled: true,
      runtime: 'claude-code',
      mode: 'custom-model',
      provider: 'openai',
      protocol: 'openai-responses',
      authentication: 'api-key',
      modelName: 'claude-test',
      baseUrl: 'https://api.openai.com/v1'
    })).toThrow('Runtime 与模型协议不兼容')

    expect(() => assertAgentConfigurationInput({
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      provider: 'anthropic',
      protocol: 'openai-responses',
      authentication: 'api-key',
      modelName: 'model',
      baseUrl: 'https://api.anthropic.com'
    })).toThrow('Provider 与模型协议不兼容')
  })
})

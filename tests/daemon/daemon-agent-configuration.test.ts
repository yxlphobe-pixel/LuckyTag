import { describe, expect, it } from 'vitest'
import {
  AGENT_CONFIGURATION_TEST_COOLDOWN_MS,
  AgentConfigurationTestGate,
  saveApplicationConfiguration,
  saveAgentConfiguration,
  testAgentConfiguration,
  type AgentConfigurationSaveContext,
  type AgentConfigurationTestContext
} from '../../src/daemon/index'
import { OrderedAsyncDispatcher } from '../../src/daemon/protocol'
import type { AgentCredentialScope, CredentialStore } from '../../src/daemon/agent-runtime'
import { DEFAULT_CONFIG, type AppConfig, type DashboardSnapshot } from '../../src/shared/contracts'

const ENDPOINT_A = 'https://models-a.example.test/v1'
const ENDPOINT_B = 'https://models-b.example.test/v1'
const CODEX_API_KEY = {
  provider: 'custom',
  protocol: 'openai-responses',
  authentication: 'api-key'
} as const

describe('Daemon Agent 配置安全边界', () => {
  it('切换模型 Endpoint 时绝不静默复用旧 Key', async () => {
    const fixture = saveFixture(configuration(ENDPOINT_A, true))
    fixture.credentials.seed({ runtime: 'codex', baseUrl: ENDPOINT_A }, 'endpoint-a-key')

    await expect(saveAgentConfiguration(fixture.context, {
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      ...CODEX_API_KEY,
      modelName: 'model-b',
      baseUrl: ENDPOINT_B
    })).rejects.toMatchObject({ code: 'AGENT_API_KEY_REENTRY_REQUIRED' })

    expect(fixture.saved).toHaveLength(0)
    expect(fixture.credentials.peek({ runtime: 'codex', baseUrl: ENDPOINT_A })).toBe('endpoint-a-key')
    expect(fixture.credentials.peek({ runtime: 'codex', baseUrl: ENDPOINT_B })).toBeNull()
  })

  it('同 Runtime、同 Endpoint 只变更模型名时可复用该 scope 的 Key', async () => {
    const fixture = saveFixture(configuration(ENDPOINT_A, true))
    fixture.credentials.seed({ runtime: 'codex', baseUrl: ENDPOINT_A }, 'endpoint-a-key')

    await expect(saveAgentConfiguration(fixture.context, {
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      ...CODEX_API_KEY,
      modelName: 'renamed-model',
      baseUrl: `${ENDPOINT_A}/../v1`
    })).resolves.toMatchObject({
      config: { agent: { model: { name: 'renamed-model', apiKeyConfigured: true } } }
    })
  })

  it('保持禁用时允许切换 Endpoint，但会清除目标 scope 的陈旧 Key', async () => {
    const fixture = saveFixture(configuration(ENDPOINT_A, true))
    fixture.credentials.seed({ runtime: 'codex', baseUrl: ENDPOINT_B }, 'stale-endpoint-b-key')

    await saveAgentConfiguration(fixture.context, {
      enabled: false,
      runtime: 'codex',
      mode: 'custom-model',
      ...CODEX_API_KEY,
      modelName: 'model-b',
      baseUrl: ENDPOINT_B
    })

    expect(fixture.credentials.peek({ runtime: 'codex', baseUrl: ENDPOINT_B })).toBeNull()
    expect(fixture.saved.at(-1)?.agent.model.apiKeyConfigured).toBe(false)
  })

  it('Runtime 默认模式不读取、写入或复用 LuckyTag Keychain', async () => {
    const fixture = saveFixture(configuration(ENDPOINT_A, true))
    fixture.credentials.seed({ runtime: 'codex', baseUrl: ENDPOINT_A }, 'endpoint-a-key')

    await saveAgentConfiguration(fixture.context, {
      enabled: true,
      runtime: 'codex',
      mode: 'runtime-default',
      provider: 'openai',
      protocol: 'openai-responses',
      authentication: 'api-key',
      modelName: '',
      baseUrl: ''
    })

    expect(fixture.credentials.operations).toEqual([])
    expect(fixture.saved.at(-1)?.agent.model.apiKeyConfigured).toBe(false)
  })

  it('本机无认证 Provider 不读写 Keychain，并清理同 Endpoint 的陈旧 Key', async () => {
    const endpoint = 'http://127.0.0.1:11434/v1'
    const fixture = saveFixture(configuration(ENDPOINT_A, false))
    fixture.credentials.seed({ runtime: 'codex', baseUrl: endpoint }, 'stale-local-key')

    await expect(saveAgentConfiguration(fixture.context, {
      enabled: true,
      runtime: 'codex',
      mode: 'custom-model',
      provider: 'ollama',
      protocol: 'openai-responses',
      authentication: 'none',
      modelName: 'qwen3',
      baseUrl: endpoint
    })).resolves.toMatchObject({
      config: { agent: { model: { provider: 'ollama', authentication: 'none', apiKeyConfigured: false } } }
    })

    expect(fixture.credentials.peek({ runtime: 'codex', baseUrl: endpoint })).toBeNull()
    expect(fixture.credentials.operations).toEqual([
      `get:${scopeKey({ runtime: 'codex', baseUrl: endpoint })}`,
      `delete:${scopeKey({ runtime: 'codex', baseUrl: endpoint })}`
    ])
  })

  it('配置实测只允许已启用配置，失败前不会启动 Agent', async () => {
    let runnerCalls = 0
    const context: AgentConfigurationTestContext = {
      service: { getSnapshot: async () => snapshot(configuration(ENDPOINT_A, false)) },
      credentials: new MemoryCredentialStore(),
      runtimes: {
        probe: async () => ({
          runtime: 'codex',
          available: true,
          detail: 'ready',
          checkedAt: new Date().toISOString()
        })
      },
      agentRunner: {
        run: async () => {
          runnerCalls += 1
          return { output: 'LUCKYTAG_OK', exitCode: 0 }
        }
      }
    }

    await expect(testAgentConfiguration(context)).rejects.toMatchObject({
      code: 'AGENT_CONFIGURATION_DISABLED'
    })
    expect(runnerCalls).toBe(0)
  })

  it('配置实测为 single-flight，完成后执行 30 秒冷却', async () => {
    let now = 1_000
    let releaseFirst: (() => void) | undefined
    const gate = new AgentConfigurationTestGate(() => now)
    const first = gate.run(() => new Promise<string>((resolve) => {
      releaseFirst = () => resolve('first')
    }))
    await Promise.resolve()

    await expect(gate.run(async () => 'concurrent')).rejects.toMatchObject({
      code: 'AGENT_CONFIGURATION_TEST_IN_PROGRESS'
    })
    releaseFirst?.()
    await expect(first).resolves.toBe('first')

    await expect(gate.run(async () => 'too-soon')).rejects.toMatchObject({
      code: 'AGENT_CONFIGURATION_TEST_COOLDOWN'
    })
    now += AGENT_CONFIGURATION_TEST_COOLDOWN_MS
    await expect(gate.run(async () => 'after-cooldown')).resolves.toBe('after-cooldown')
  })

  it('普通配置与 Agent 配置串行保存，安全关闭不会被旧快照重新打开', async () => {
    const credentials = new MemoryCredentialStore()
    let current = snapshot(configuration(ENDPOINT_A, false))
    current.config.replyPolicy.enabled = true
    current.config.replyPolicy.dryRun = false
    let snapshotReads = 0
    let releaseFirstWrite: (() => void) | undefined
    let firstWriteStarted: (() => void) | undefined
    const firstWriteReached = new Promise<void>((resolve) => { firstWriteStarted = resolve })
    const firstWriteBarrier = new Promise<void>((resolve) => { releaseFirstWrite = resolve })
    let writes = 0
    const context: AgentConfigurationSaveContext = {
      service: {
        getSnapshot: async () => {
          snapshotReads += 1
          return structuredClone(current)
        },
        saveConfig: async (config) => {
          writes += 1
          if (writes === 1) {
            firstWriteStarted?.()
            await firstWriteBarrier
          }
          current = { ...current, config: structuredClone(config) }
          return structuredClone(current)
        }
      },
      credentials,
      decorateSnapshot: async (value) => structuredClone(value)
    }
    const queue = new OrderedAsyncDispatcher()
    const safeConfig = structuredClone(current.config)
    safeConfig.replyPolicy.dryRun = true

    const disableLive = queue.run(() => saveApplicationConfiguration(context, safeConfig))
    await firstWriteReached
    const updateAgent = queue.run(() => saveAgentConfiguration(context, {
      enabled: true,
      runtime: 'claude-code',
      mode: 'runtime-default',
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      modelName: '',
      baseUrl: ''
    }))
    await Promise.resolve()
    expect(snapshotReads).toBe(1)

    releaseFirstWrite?.()
    await Promise.all([disableLive, updateAgent])

    expect(current.config.replyPolicy).toMatchObject({ enabled: true, dryRun: true })
    expect(current.config.agent).toMatchObject({
      enabled: true,
      runtime: 'claude-code',
      mode: 'runtime-default'
    })
  })
})

const saveFixture = (initialAgent: AppConfig['agent']): {
  context: AgentConfigurationSaveContext
  credentials: MemoryCredentialStore
  saved: AppConfig[]
} => {
  const credentials = new MemoryCredentialStore()
  const saved: AppConfig[] = []
  let current = snapshot(initialAgent)
  const context: AgentConfigurationSaveContext = {
    service: {
      getSnapshot: async () => structuredClone(current),
      saveConfig: async (config) => {
        saved.push(structuredClone(config))
        current = { ...current, config: structuredClone(config) }
        return structuredClone(current)
      }
    },
    credentials,
    decorateSnapshot: async (value) => structuredClone(value)
  }
  return { context, credentials, saved }
}

class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>()
  readonly operations: string[] = []

  seed(scope: AgentCredentialScope, value: string): void {
    this.values.set(scopeKey(scope), value)
  }

  peek(scope: AgentCredentialScope): string | null {
    return this.values.get(scopeKey(scope)) ?? null
  }

  async has(scope: AgentCredentialScope): Promise<boolean> {
    this.operations.push(`has:${scopeKey(scope)}`)
    return this.values.has(scopeKey(scope))
  }

  async set(scope: AgentCredentialScope, value: string): Promise<void> {
    this.operations.push(`set:${scopeKey(scope)}`)
    this.values.set(scopeKey(scope), value)
  }

  async delete(scope: AgentCredentialScope): Promise<void> {
    this.operations.push(`delete:${scopeKey(scope)}`)
    this.values.delete(scopeKey(scope))
  }

  async get(scope: AgentCredentialScope): Promise<string | null> {
    this.operations.push(`get:${scopeKey(scope)}`)
    return this.peek(scope)
  }
}

const scopeKey = (scope: AgentCredentialScope): string =>
  `${scope.runtime}:${new URL(scope.baseUrl || 'https://runtime-default.invalid').toString()}`

const configuration = (baseUrl: string, enabled: boolean): AppConfig['agent'] => ({
  enabled,
  runtime: 'codex',
  mode: 'custom-model',
  model: {
    ...CODEX_API_KEY,
    name: 'fixture-model',
    baseUrl,
    apiKeyConfigured: enabled
  }
})

const snapshot = (agent: AppConfig['agent']): DashboardSnapshot => ({
  config: { ...structuredClone(DEFAULT_CONFIG), agent: structuredClone(agent) },
  connections: [],
  knowledge: { documentCount: 0, chunkCount: 0, sourceErrors: [] },
  runtime: { running: false, processing: false, instanceId: 'fixture' },
  recentReplies: []
})

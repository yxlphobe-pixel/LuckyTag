import type {
  AgentAuthenticationKind,
  AgentConfigurationInput,
  AgentModelProtocol,
  AgentProviderId,
  AgentRuntimeKind,
  AppConfig,
  DemoWorkflowRequirementCreateInput,
  DemoWorkflowRequirementInput,
  KnowledgeSource
} from './contracts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max

const isExternalId = (value: unknown): value is string =>
  isNonEmptyString(value, 256) && !/[\s\u0000-\u001F\u007F-\u009F]/u.test(value)

const isRecordId = (value: unknown): value is string =>
  isNonEmptyString(value, 128) && /^[A-Za-z0-9._:@-]+$/.test(value)

const isSafeLocalPath = (value: unknown): value is string =>
  isNonEmptyString(value) && !/[\u0000-\u001F\u007F-\u009F]/u.test(value)

const isSampleLibraryDocReference = (value: unknown): value is string => {
  if (!isNonEmptyString(value, 1024) || hasControlCharacters(value)) return false
  if (/^[^\s/]+\/[^\s/]+\/[^\s/]+$/.test(value)) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'library.example.invalid' && !url.username && !url.password
  } catch {
    return false
  }
}

const isSampleLibraryNamespace = (value: unknown): value is string =>
  isNonEmptyString(value, 512) && !hasControlCharacters(value) && /^[^\s/]+\/[^\s/]+$/.test(value)

const isKnowledgeSource = (value: unknown): value is KnowledgeSource => {
  if (!isRecord(value) || !isRecordId(value.id) || !isNonEmptyString(value.label, 120)) return false
  if (typeof value.enabled !== 'boolean') return false

  if (value.type === 'local-directory') return isSafeLocalPath(value.path)
  if (value.type === 'sampleLibrary-doc') return isSampleLibraryDocReference(value.routeOrUrl)
  if (value.type === 'sampleLibrary-book') return isSampleLibraryNamespace(value.namespace)
  return false
}

const isAgentConfiguration = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return false
  if (value.runtime !== 'codex' && value.runtime !== 'claude-code') return false
  if (value.mode !== 'runtime-default' && value.mode !== 'custom-model') return false
  if (!isRecord(value.model)) return false
  if (
    !isAgentProviderId(value.model.provider) ||
    !isAgentModelProtocol(value.model.protocol) ||
    !isAgentAuthenticationKind(value.model.authentication) ||
    typeof value.model.name !== 'string' ||
    value.model.name.length > 256 ||
    hasControlCharacters(value.model.name) ||
    typeof value.model.baseUrl !== 'string' ||
    typeof value.model.apiKeyConfigured !== 'boolean'
  ) return false
  if (value.model.protocol !== protocolForRuntime(value.runtime)) return false
  if (!providerSupportsProtocol(value.model.provider, value.model.protocol)) return false
  if (value.mode === 'custom-model') {
    if (!value.model.name.trim() || !isAgentBaseUrl(value.model.baseUrl)) return false
    if (value.model.authentication === 'none') {
      return !value.model.apiKeyConfigured && providerAllowsNoAuthentication(value.model.provider) && isLoopbackModelUrl(value.model.baseUrl)
    }
    return true
  }
  return value.model.name === '' && value.model.baseUrl === '' && !value.model.apiKeyConfigured && value.model.authentication === 'api-key'
}

export const isAppConfig = (value: unknown): value is AppConfig => {
  if (!isRecord(value) || value.version !== 3 || typeof value.onboardingComplete !== 'boolean') {
    return false
  }
  if (!Array.isArray(value.groups) || !Array.isArray(value.knowledgeSources)) return false
  if (value.groups.length > 100 || value.knowledgeSources.length > 100) return false
  if (!value.groups.every((group) => {
    return isRecord(group) && isExternalId(group.id) && isNonEmptyString(group.label, 120) && typeof group.enabled === 'boolean'
  })) return false
  if (!value.knowledgeSources.every(isKnowledgeSource)) return false
  if (!isAgentConfiguration(value.agent)) return false
  if (new Set(value.groups.map((group) => group.id)).size !== value.groups.length) return false
  if (new Set(value.knowledgeSources.map((source) => source.id)).size !== value.knowledgeSources.length) return false
  if (!isRecord(value.replyPolicy)) return false

  const policy = value.replyPolicy
  return (
    typeof policy.enabled === 'boolean' &&
    typeof policy.dryRun === 'boolean' &&
    Number.isInteger(policy.pollIntervalSeconds) &&
    Number(policy.pollIntervalSeconds) >= 60 &&
    Number(policy.pollIntervalSeconds) <= 3600 &&
    Number.isInteger(policy.lookbackMinutes) &&
    Number(policy.lookbackMinutes) >= 1 &&
    Number(policy.lookbackMinutes) <= 1440 &&
    typeof policy.confidenceThreshold === 'number' &&
    policy.confidenceThreshold >= 0 &&
    policy.confidenceThreshold <= 1 &&
    Number.isInteger(policy.maxReplyLength) &&
    Number(policy.maxReplyLength) >= 100 &&
    Number(policy.maxReplyLength) <= 4000 &&
    Number.isInteger(policy.maxRepliesPerHour) &&
    Number(policy.maxRepliesPerHour) >= 1 &&
    Number(policy.maxRepliesPerHour) <= 100 &&
    Number.isInteger(policy.followUpHours) &&
    Number(policy.followUpHours) >= 1 &&
    Number(policy.followUpHours) <= 24 &&
    typeof policy.markExistingIgnored === 'boolean'
  )
}

export const migrateAppConfig = (value: unknown): AppConfig => {
  if (isAppConfig(value)) return canonicalAppConfig(value)
  const legacyV1 = migrateLegacyV1Config(value)
  if (legacyV1) return canonicalAppConfig(legacyV1)
  const legacyV2 = migrateLegacyV2Config(value)
  if (legacyV2) return canonicalAppConfig(legacyV2)
  throw new Error('配置格式不合法，无法迁移')
}

export const assertAgentRuntimeKind = (value: unknown): AgentRuntimeKind => {
  if (value !== 'codex' && value !== 'claude-code') {
    throw invalidAgentInput('不支持的 Agent Runtime')
  }
  return value
}

export const assertAgentConfigurationInput = (value: unknown): AgentConfigurationInput => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') throw invalidAgentInput('配置格式不合法')
  if (value.runtime !== 'codex' && value.runtime !== 'claude-code') throw invalidAgentInput('不支持的 Agent Runtime')
  if (value.mode !== 'runtime-default' && value.mode !== 'custom-model') throw invalidAgentInput('不支持的模型配置模式')
  if (!isAgentProviderId(value.provider)) throw invalidAgentInput('不支持的模型 Provider')
  if (!isAgentModelProtocol(value.protocol)) throw invalidAgentInput('不支持的模型协议')
  if (!isAgentAuthenticationKind(value.authentication)) throw invalidAgentInput('不支持的认证方式')
  if (value.protocol !== protocolForRuntime(value.runtime)) throw invalidAgentInput('所选 Runtime 与模型协议不兼容')
  if (!providerSupportsProtocol(value.provider, value.protocol)) throw invalidAgentInput('所选 Provider 与模型协议不兼容')
  const modelName = typeof value.modelName === 'string' ? value.modelName.trim() : ''
  if (modelName.length > 256 || hasControlCharacters(modelName) || (value.mode === 'custom-model' && !modelName)) {
    throw invalidAgentInput('使用自定义模型时必须填写模型名称')
  }
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  if (value.mode === 'custom-model' && !isAgentBaseUrl(baseUrl)) {
    throw invalidAgentInput('模型 URL 必须使用 HTTPS，或指向本机回环地址')
  }
  if (value.mode === 'runtime-default' && baseUrl && !isAgentBaseUrl(baseUrl)) {
    throw invalidAgentInput('模型 URL 格式不合法')
  }
  if (value.apiKey !== undefined && (
    typeof value.apiKey !== 'string' ||
    !value.apiKey.trim() ||
    value.apiKey.length > 8192 ||
    hasControlCharacters(value.apiKey)
  )) {
    throw invalidAgentInput('Key 格式不合法')
  }
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== 'boolean') throw invalidAgentInput('清除 Key 参数不合法')
  if (value.apiKey && value.clearApiKey) throw invalidAgentInput('不能同时设置和清除 Key')
  if (value.mode === 'runtime-default' && value.authentication !== 'api-key') {
    throw invalidAgentInput('Runtime 默认配置不接受自定义认证方式')
  }
  if (value.mode === 'custom-model' && value.authentication === 'none') {
    if (!providerAllowsNoAuthentication(value.provider) || !isLoopbackModelUrl(baseUrl)) {
      throw invalidAgentInput('无认证仅允许本机回环地址的 Ollama 或自定义服务')
    }
    if (value.apiKey || value.clearApiKey) throw invalidAgentInput('无认证模式不接收模型 Key')
  }
  return {
    enabled: value.enabled,
    runtime: value.runtime,
    mode: value.mode,
    provider: value.mode === 'runtime-default' ? defaultProviderForRuntime(value.runtime) : value.provider,
    protocol: protocolForRuntime(value.runtime),
    authentication: value.mode === 'runtime-default' ? 'api-key' : value.authentication,
    modelName,
    baseUrl,
    ...(value.apiKey ? { apiKey: value.apiKey.trim() } : {}),
    ...(value.clearApiKey ? { clearApiKey: true } : {})
  }
}

export const assertAppConfig = (value: unknown): AppConfig => {
  if (!isAppConfig(value)) throw new Error('配置格式不合法，已拒绝保存')
  return canonicalAppConfig(value)
}

export const assertDemoWorkflowRequirementInput = (value: unknown): DemoWorkflowRequirementInput => {
  if (!isRecord(value)) throw invalidDemoWorkflowInput('表单格式不合法')
  const groupName = normalizedText(value.groupName, 120, '示例消息群名称')
  const demoProject = normalizedText(value.demoProject, 1_024, 'DemoWorkflow 需求空间')
  const iteration = optionalNormalizedText(value.iteration, 256, '迭代窗口')
  const templateUrl = normalizedText(value.templateUrl, 2_048, 'DemoWorkflow 需求模板')
  if (value.chatWindow !== '24h' && value.chatWindow !== '3d' && value.chatWindow !== '7d') {
    throw invalidDemoWorkflowInput('群聊天周期窗口不合法')
  }
  assertProjectSampleSystemUrl(templateUrl, true)
  return { groupName, chatWindow: value.chatWindow, demoProject, iteration, templateUrl }
}

export const assertDemoWorkflowRequirementCreateInput = (value: unknown): DemoWorkflowRequirementCreateInput => {
  if (!isRecord(value)) throw invalidDemoWorkflowInput('创建参数格式不合法')
  const draftId = normalizedText(value.draftId, 64, '草稿 ID')
  if (!UUID_PATTERN.test(draftId)) throw invalidDemoWorkflowInput('草稿 ID 不合法')
  return {
    draftId,
    title: normalizedText(value.title, 200, '需求标题'),
    description: normalizedMultilineText(value.description, 20_000, '需求描述')
  }
}

export const assertDemoWorkflowRequirementUrl = (value: unknown): string => {
  const url = normalizedText(value, 2_048, 'DemoWorkflow 需求地址')
  assertProjectSampleSystemUrl(url, false)
  return url
}

const normalizedText = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string') throw invalidDemoWorkflowInput(`${label}不能为空`)
  const normalized = value.trim()
  if (!normalized) throw invalidDemoWorkflowInput(`${label}不能为空`)
  if (normalized.length > max || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw invalidDemoWorkflowInput(`${label}格式不合法`)
  }
  return normalized
}

const optionalNormalizedText = (value: unknown, max: number, label: string): string => {
  if (value === undefined || value === null || value === '') return ''
  return normalizedText(value, max, label)
}

const normalizedMultilineText = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string') throw invalidDemoWorkflowInput(`${label}不能为空`)
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (!normalized) throw invalidDemoWorkflowInput(`${label}不能为空`)
  if (normalized.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw invalidDemoWorkflowInput(`${label}格式不合法`)
  }
  return normalized
}

const assertProjectSampleSystemUrl = (value: string, requireTemplateId: boolean): void => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidDemoWorkflowInput('DemoWorkflow 地址必须是有效的 HTTPS 链接')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'workflow.example.invalid') {
    throw invalidDemoWorkflowInput('DemoWorkflow 地址必须来自 workflow.example.invalid')
  }
  const templateId = url.searchParams.get('templateRecordId') ?? url.searchParams.get('recordId') ?? ''
  if (requireTemplateId && !/^\d{10,32}$/u.test(templateId)) {
    throw invalidDemoWorkflowInput('DemoWorkflow 需求模板链接缺少有效的 templateRecordId')
  }
}

const invalidDemoWorkflowInput = (message: string): Error =>
  Object.assign(new Error(message), { code: 'INVALID_DEMO_WORKFLOW_REQUIREMENT_INPUT' })

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const DEFAULT_AGENT_CONFIGURATION = {
  enabled: false,
  runtime: 'codex',
  mode: 'runtime-default',
  model: {
    provider: 'openai',
    protocol: 'openai-responses',
    authentication: 'api-key',
    name: '',
    baseUrl: '',
    apiKeyConfigured: false
  }
} as const

const migrateLegacyV1Config = (value: unknown): AppConfig | null => {
  if (!isRecord(value) || value.version !== 1) return null
  const migrated = { ...value, version: 3, agent: structuredClone(DEFAULT_AGENT_CONFIGURATION) }
  return isAppConfig(migrated) ? migrated : null
}

const migrateLegacyV2Config = (value: unknown): AppConfig | null => {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.agent) || !isRecord(value.agent.model)) return null
  const runtime = value.agent.runtime
  if (runtime !== 'codex' && runtime !== 'claude-code') return null
  const mode = value.agent.mode === 'runtime-default' || value.agent.mode === 'custom-model'
    ? value.agent.mode
    : typeof value.agent.model.name === 'string' && value.agent.model.name.trim()
      ? 'custom-model'
      : 'runtime-default'
  const baseUrl = typeof value.agent.model.baseUrl === 'string' ? value.agent.model.baseUrl : ''
  const migrated = {
    ...value,
    version: 3,
    agent: {
      ...value.agent,
      mode,
      model: {
        ...value.agent.model,
        provider: mode === 'runtime-default' ? defaultProviderForRuntime(runtime) : inferProvider(runtime, baseUrl),
        protocol: protocolForRuntime(runtime),
        authentication: 'api-key',
        ...(mode === 'runtime-default' ? { name: '', baseUrl: '', apiKeyConfigured: false } : {})
      }
    }
  }
  return isAppConfig(migrated) ? migrated : null
}

const canonicalAppConfig = (value: AppConfig): AppConfig => ({
  version: 3,
  onboardingComplete: value.onboardingComplete,
  groups: value.groups.map((group) => ({ id: group.id, label: group.label, enabled: group.enabled })),
  knowledgeSources: value.knowledgeSources.map((source) => source.type === 'local-directory'
    ? { id: source.id, type: source.type, label: source.label, path: source.path, enabled: source.enabled }
    : source.type === 'sampleLibrary-doc'
      ? { id: source.id, type: source.type, label: source.label, routeOrUrl: source.routeOrUrl, enabled: source.enabled }
      : { id: source.id, type: source.type, label: source.label, namespace: source.namespace, enabled: source.enabled }),
  replyPolicy: {
    enabled: value.replyPolicy.enabled,
    dryRun: value.replyPolicy.dryRun,
    pollIntervalSeconds: value.replyPolicy.pollIntervalSeconds,
    lookbackMinutes: value.replyPolicy.lookbackMinutes,
    confidenceThreshold: value.replyPolicy.confidenceThreshold,
    maxReplyLength: value.replyPolicy.maxReplyLength,
    maxRepliesPerHour: value.replyPolicy.maxRepliesPerHour,
    followUpHours: value.replyPolicy.followUpHours,
    markExistingIgnored: value.replyPolicy.markExistingIgnored
  },
  agent: {
    enabled: value.agent.enabled,
    runtime: value.agent.runtime,
    mode: value.agent.mode,
    model: {
      provider: value.agent.model.provider,
      protocol: value.agent.model.protocol,
      authentication: value.agent.model.authentication,
      name: value.agent.model.name,
      baseUrl: value.agent.model.baseUrl,
      apiKeyConfigured: value.agent.model.apiKeyConfigured
    }
  }
})

const isAgentBaseUrl = (value: unknown): value is string => {
  if (!isNonEmptyString(value, 2_048) || hasControlCharacters(value)) return false
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

const isLoopbackModelUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

const isAgentModelProtocol = (value: unknown): value is AgentModelProtocol =>
  value === 'openai-responses' || value === 'anthropic-messages'

const isAgentAuthenticationKind = (value: unknown): value is AgentAuthenticationKind =>
  value === 'api-key' || value === 'none'

const isAgentProviderId = (value: unknown): value is AgentProviderId =>
  value === 'openai' || value === 'anthropic' || value === 'sample-cloud' ||
  value === 'openrouter' || value === 'azure-openai' || value === 'aws-bedrock' ||
  value === 'ollama' || value === 'custom'

const protocolForRuntime = (runtime: AgentRuntimeKind): AgentModelProtocol =>
  runtime === 'codex' ? 'openai-responses' : 'anthropic-messages'

const defaultProviderForRuntime = (runtime: AgentRuntimeKind): AgentProviderId =>
  runtime === 'codex' ? 'openai' : 'anthropic'

const providerSupportsProtocol = (provider: AgentProviderId, protocol: AgentModelProtocol): boolean => {
  if (provider === 'custom' || provider === 'aws-bedrock') return true
  if (protocol === 'anthropic-messages') return provider === 'anthropic'
  return provider === 'openai' || provider === 'sample-cloud' || provider === 'openrouter' ||
    provider === 'azure-openai' || provider === 'ollama'
}

const providerAllowsNoAuthentication = (provider: AgentProviderId): boolean =>
  provider === 'ollama' || provider === 'custom'

const inferProvider = (runtime: AgentRuntimeKind, baseUrl: string): AgentProviderId => {
  try {
    const hostname = new URL(baseUrl).hostname
    if (hostname === 'api.openai.com') return 'openai'
    if (hostname === 'api.anthropic.com') return 'anthropic'
    if (hostname === 'api.example.invalid') return 'sample-cloud'
    if (hostname === 'openrouter.ai') return 'openrouter'
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return 'custom'
  } catch {
    return defaultProviderForRuntime(runtime)
  }
  return 'custom'
}

const hasControlCharacters = (value: string): boolean => /[\u0000-\u001F\u007F-\u009F]/u.test(value)

const invalidAgentInput = (message: string): Error =>
  Object.assign(new Error(message), { code: 'INVALID_AGENT_CONFIGURATION' })

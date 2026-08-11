import { useEffect, useState } from 'react'
import type {
  AgentAuthenticationKind,
  AgentConfiguration,
  AgentConfigurationInput,
  AgentConfigurationMode,
  AgentModelProtocol,
  AgentProviderId,
  AgentConfigurationTestResult,
  AgentRuntimeKind,
  AgentRuntimeStatus,
  DaemonStatus
} from '@shared/contracts'
import { Icon } from './Icon'

interface ApplicationConfigurationPanelProps {
  agentTestError: string | null
  agentTestResult: AgentConfigurationTestResult | null
  busy: boolean
  probing: boolean
  configuration: AgentConfiguration
  daemon: DaemonStatus | undefined
  runtimeStatuses: Partial<Record<AgentRuntimeKind, AgentRuntimeStatus>>
  onProbe: (runtime: AgentRuntimeKind) => void
  onSave: (input: AgentConfigurationInput) => void
  onTest: () => void
  testing: boolean
}

const defaultBaseUrls: Record<AgentRuntimeKind, string> = {
  codex: 'https://api.openai.com/v1',
  'claude-code': 'https://api.anthropic.com'
}

const modelSuggestions: Record<AgentRuntimeKind, readonly string[]> = {
  codex: [
    'qwen3.6-plus',
    'qwen3.5-plus',
    'kimi-k2.5',
    'glm-5',
    'qwen3-max',
    'deepseek-v3.2',
    'MiniMax-M2.5'
  ],
  'claude-code': [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5'
  ]
}

const antDigitalModelUrl = 'https://maas-api.antdigital.com/v1'

interface ProviderPreset {
  id: AgentProviderId
  runtime: AgentRuntimeKind
  label: string
  detail: string
  baseUrl: string
  authentication: AgentAuthenticationKind
}

const protocolByRuntime: Record<AgentRuntimeKind, AgentModelProtocol> = {
  codex: 'openai-responses',
  'claude-code': 'anthropic-messages'
}

const defaultProviderByRuntime: Record<AgentRuntimeKind, AgentProviderId> = {
  codex: 'openai',
  'claude-code': 'anthropic'
}

const providerPresets: readonly ProviderPreset[] = [
  { id: 'openai', runtime: 'codex', label: 'OpenAI', detail: '官方 Responses API', baseUrl: 'https://api.openai.com/v1', authentication: 'api-key' },
  { id: 'ant-digital-maas', runtime: 'codex', label: '蚂蚁数科 MaaS', detail: 'OpenAI Responses 兼容', baseUrl: antDigitalModelUrl, authentication: 'api-key' },
  { id: 'openrouter', runtime: 'codex', label: 'OpenRouter', detail: 'Responses Beta', baseUrl: 'https://openrouter.ai/api/v1', authentication: 'api-key' },
  { id: 'azure-openai', runtime: 'codex', label: 'Azure OpenAI', detail: '填写资源 Endpoint', baseUrl: '', authentication: 'api-key' },
  { id: 'aws-bedrock', runtime: 'codex', label: 'Amazon Bedrock', detail: '填写兼容 Endpoint', baseUrl: '', authentication: 'api-key' },
  { id: 'ollama', runtime: 'codex', label: 'Ollama', detail: '本机，无需 Key', baseUrl: 'http://127.0.0.1:11434/v1', authentication: 'none' },
  { id: 'anthropic', runtime: 'claude-code', label: 'Anthropic', detail: '官方 Messages API', baseUrl: 'https://api.anthropic.com', authentication: 'api-key' },
  { id: 'aws-bedrock', runtime: 'claude-code', label: 'Amazon Bedrock', detail: '填写 Messages Endpoint', baseUrl: '', authentication: 'api-key' }
]

export function ApplicationConfigurationPanel({
  agentTestError,
  agentTestResult,
  busy,
  probing,
  configuration,
  daemon,
  runtimeStatuses,
  onProbe,
  onSave,
  onTest,
  testing
}: ApplicationConfigurationPanelProps): React.JSX.Element {
  const [enabled, setEnabled] = useState(configuration.enabled)
  const [runtime, setRuntime] = useState<AgentRuntimeKind>(configuration.runtime)
  const [mode, setMode] = useState<AgentConfigurationMode>(configuration.mode)
  const [provider, setProvider] = useState<AgentProviderId>(configuration.model.provider)
  const [authentication, setAuthentication] = useState<AgentAuthenticationKind>(configuration.model.authentication)
  const [modelName, setModelName] = useState(configuration.model.name)
  const [baseUrl, setBaseUrl] = useState(configuration.model.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    setEnabled(configuration.enabled)
    setRuntime(configuration.runtime)
    setMode(configuration.mode)
    setProvider(configuration.model.provider)
    setAuthentication(configuration.model.authentication)
    setModelName(configuration.model.name)
    setBaseUrl(configuration.model.baseUrl)
    setApiKey('')
    setClearApiKey(false)
    setValidationError(null)
  }, [
    configuration.enabled,
    configuration.mode,
    configuration.model.authentication,
    configuration.model.apiKeyConfigured,
    configuration.model.baseUrl,
    configuration.model.name,
    configuration.model.provider,
    configuration.runtime
  ])

  const changeRuntime = (next: AgentRuntimeKind): void => {
    const changed = next !== runtime
    setRuntime(next)
    setApiKey('')
    setClearApiKey(false)
    if (mode === 'runtime-default') {
      setProvider(defaultProviderByRuntime[next])
      setAuthentication('api-key')
      setModelName('')
      setBaseUrl('')
    } else {
      setProvider(defaultProviderByRuntime[next])
      setAuthentication('api-key')
      setModelName('')
      setBaseUrl(defaultBaseUrls[next])
    }
    if (changed) onProbe(next)
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const normalizedModel = modelName.trim()
    const normalizedUrl = baseUrl.trim()
    if (mode === 'custom-model' && !normalizedModel) {
      setValidationError('使用自定义模型时需要填写模型名称')
      return
    }
    if (mode === 'custom-model' && !isAllowedModelUrl(normalizedUrl)) {
      setValidationError('请使用 HTTPS URL，或本机 localhost / 127.0.0.1 地址')
      return
    }
    if (mode === 'custom-model' && authentication === 'none' && !isLoopbackModelUrl(normalizedUrl)) {
      setValidationError('无认证只允许本机 localhost / 127.0.0.1 / ::1 地址')
      return
    }
    setValidationError(null)
    onSave({
      enabled,
      runtime,
      mode,
      provider: mode === 'runtime-default' ? defaultProviderByRuntime[runtime] : provider,
      protocol: protocolByRuntime[runtime],
      authentication: mode === 'runtime-default' ? 'api-key' : authentication,
      modelName: mode === 'custom-model' ? normalizedModel : '',
      baseUrl: mode === 'custom-model' ? normalizedUrl : '',
      ...(mode === 'custom-model' && authentication === 'api-key' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(mode === 'custom-model' && authentication === 'api-key' && clearApiKey ? { clearApiKey: true } : {})
    })
    setApiKey('')
    setClearApiKey(false)
  }

  const runtimeStatus = runtimeStatuses[runtime]
  const protocol = protocolByRuntime[runtime]
  const runtimeMatches = runtimeStatus?.runtime === runtime
  const configuredKey =
    configuration.mode === 'custom-model' &&
    configuration.model.authentication === 'api-key' &&
    configuration.runtime === runtime &&
    configuration.model.baseUrl === baseUrl.trim() &&
    configuration.model.apiKeyConfigured
  const keyState = clearApiKey ? '保存后清除' : apiKey ? '将替换钥匙串 Key' : configuredKey ? '已安全保存' : '未配置'
  const unavailable = runtimeMatches && runtimeStatus?.available === false
  const formMatchesSavedConfiguration =
    runtime === configuration.runtime &&
    mode === configuration.mode &&
    provider === configuration.model.provider &&
    protocol === configuration.model.protocol &&
    authentication === configuration.model.authentication &&
    modelName.trim() === configuration.model.name &&
    baseUrl.trim() === configuration.model.baseUrl &&
    !apiKey.trim() &&
    !clearApiKey
  const canTest =
    configuration.enabled &&
    runtimeStatus?.runtime === configuration.runtime &&
    runtimeStatus.available &&
    (configuration.mode === 'runtime-default' || configuration.model.authentication === 'none' || configuration.model.apiKeyConfigured) &&
    formMatchesSavedConfiguration
  const testResultIsStale = !formMatchesSavedConfiguration && Boolean(agentTestResult || agentTestError)
  const configurationMethod = mode === 'runtime-default' ? 'runtime' : provider === 'custom' ? 'custom' : 'preset'
  const visiblePresets = providerPresets.filter((preset) => preset.runtime === runtime)

  const selectConfigurationMethod = (next: 'runtime' | 'preset' | 'custom'): void => {
    setApiKey('')
    setClearApiKey(false)
    setValidationError(null)
    if (next === 'runtime') {
      setMode('runtime-default')
      setProvider(defaultProviderByRuntime[runtime])
      setAuthentication('api-key')
      setModelName('')
      setBaseUrl('')
      return
    }
    setMode('custom-model')
    if (next === 'custom') {
      setProvider('custom')
      setAuthentication('api-key')
      if (!baseUrl) setBaseUrl(defaultBaseUrls[runtime])
      return
    }
    const preset = visiblePresets[0]
    if (preset) selectProvider(preset)
  }

  const selectProvider = (preset: ProviderPreset): void => {
    setMode('custom-model')
    setProvider(preset.id)
    setAuthentication(preset.authentication)
    setBaseUrl(preset.baseUrl)
    setApiKey('')
    setClearApiKey(false)
    setValidationError(null)
    if (!modelName && preset.id === 'ant-digital-maas') setModelName(modelSuggestions.codex[0] ?? '')
  }

  return (
    <div className="content-stack app-config-stack">
      <section className="panel daemon-architecture-card">
        <div className="daemon-architecture-icon"><Icon name="terminal" size={22} /></div>
        <div>
          <span className="section-kicker">Electron + Local Daemon</span>
          <h2>桌面端与本机守护服务已解耦</h2>
          <p>Electron 只负责交互与系统生命周期；Agent、任务调度与本地数据由独立 Daemon 承载，关闭窗口后仍可继续运行。当前自动回复仍沿用知识证据安全链路。</p>
        </div>
        <span className={`daemon-pill${daemon?.connected ? ' connected' : ''}`}><span />{daemon?.connected ? `Daemon 已连接 · PID ${daemon.pid}` : 'Daemon 未连接'}</span>
      </section>

      <form className="panel agent-config-panel" onSubmit={submit}>
        <div className="panel-heading agent-config-heading">
          <div><span className="section-kicker">Agent Runtime</span><h2>运行时选择</h2><p className="panel-description">LuckyTag 支持 Codex CLI 与 Claude Code，每个 Agent 会话使用独立工作目录与最小环境变量执行；本配置先用于模型测试与后续 Agent 工作流。</p></div>
          <label className="agent-enable-control">
            <span><strong>启用 Agent Runtime</strong><small>{enabled ? '供模型测试与后续工作流使用' : '不影响当前知识库自动回复'}</small></span>
            <span className="switch large"><input checked={enabled} disabled={busy || probing} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /><span /></span>
          </label>
        </div>

        <div className="runtime-choice-grid">
          <button aria-pressed={runtime === 'codex'} className={`runtime-choice${runtime === 'codex' ? ' selected' : ''}`} disabled={busy || probing} onClick={() => changeRuntime('codex')} type="button">
            <span className="runtime-symbol codex">&gt;_</span><span><strong>Codex CLI</strong><small>OpenAI Agent Runtime</small></span>{runtime === 'codex' && <Icon name="check" size={16} />}
          </button>
          <button aria-pressed={runtime === 'claude-code'} className={`runtime-choice${runtime === 'claude-code' ? ' selected' : ''}`} disabled={busy || probing} onClick={() => changeRuntime('claude-code')} type="button">
            <span className="runtime-symbol claude">✶</span><span><strong>Claude Code</strong><small>Anthropic Agent Runtime</small></span>{runtime === 'claude-code' && <Icon name="check" size={16} />}
          </button>
        </div>

        <div className="runtime-probe-row">
          <div aria-live="polite" className={`runtime-probe-state${probing ? ' checking' : runtimeMatches && runtimeStatus?.available ? ' available' : unavailable ? ' unavailable' : ''}`}><span />
            <div><strong>{probing ? '正在检测 Runtime…' : runtimeMatches ? runtimeStatus.detail : '尚未检测当前 Runtime'}</strong><small>{runtimeMatches && runtimeStatus.version ? runtimeStatus.version : '检测只读取本机命令行版本，不执行 Agent'}</small></div>
          </div>
          <button className="button secondary" disabled={busy || probing} onClick={() => onProbe(runtime)} type="button"><Icon name="refresh" size={14} /> {probing ? '检测中…' : '检测 Runtime'}</button>
        </div>

        <div className="agent-model-section">
          <div className="agent-section-title"><span className="section-kicker">Model Provider</span><h2>Agent 模型配置</h2><p>可以沿用 Runtime 自己的登录与模型配置，或为 LuckyTag 单独指定兼容模型。自定义 Key 只写入 macOS 钥匙串。</p></div>
          <div className="protocol-summary-row">
            <span className="protocol-badge">{protocol === 'openai-responses' ? 'OpenAI Responses' : 'Anthropic Messages'}</span>
            <span>一期已验证协议 2</span>
          </div>
          <fieldset className="configuration-mode-grid three-column">
            <legend className="sr-only">模型配置方式</legend>
            <button aria-pressed={configurationMethod === 'runtime'} className={`configuration-mode${configurationMethod === 'runtime' ? ' selected' : ''}`} disabled={busy || probing} onClick={() => selectConfigurationMethod('runtime')} type="button">
              <Icon name="terminal" size={17} /><span><strong>沿用 Runtime</strong><small>复用 CLI 的认证与默认模型</small></span>
            </button>
            <button aria-pressed={configurationMethod === 'preset'} className={`configuration-mode${configurationMethod === 'preset' ? ' selected' : ''}`} disabled={busy || probing} onClick={() => selectConfigurationMethod('preset')} type="button">
              <Icon name="sparkle" size={17} /><span><strong>Provider 预设</strong><small>选择经过验证的服务入口</small></span>
            </button>
            <button aria-pressed={configurationMethod === 'custom'} className={`configuration-mode${configurationMethod === 'custom' ? ' selected' : ''}`} disabled={busy || probing} onClick={() => selectConfigurationMethod('custom')} type="button">
              <Icon name="settings" size={17} /><span><strong>自定义 Endpoint</strong><small>企业网关或本机模型服务</small></span>
            </button>
          </fieldset>
          {mode === 'runtime-default' ? (
            <div className="runtime-default-note"><Icon name="shield" size={17} /><div><strong>不会覆盖 Runtime 的现有配置</strong><p>{runtime === 'claude-code' ? '隔离 Worker 复用 Claude Code 的认证选择和默认模型，但不加载 user / project / local 设置；LuckyTag 不读取或复制凭据。' : '隔离 Worker 仅复用所选 CLI 的默认认证与模型设置；LuckyTag 不读取或复制其中的凭据。'}</p></div></div>
          ) : (
            <div className="byok-configuration">
              {configurationMethod === 'preset' && <div className="provider-grid" aria-label="Provider 预设">
                {visiblePresets.map((preset) => (
                  <button aria-pressed={provider === preset.id} className={`provider-card${provider === preset.id ? ' selected' : ''}`} disabled={busy || probing} key={`${preset.runtime}-${preset.id}`} onClick={() => selectProvider(preset)} type="button">
                    <span className="provider-mark">{preset.label.slice(0, 1)}</span>
                    <span><strong>{preset.label}</strong><small>{preset.detail}</small></span>
                    {provider === preset.id && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>}
              <div className="agent-model-grid">
              <label className="field"><span>模型名称 <small>必填</small></span><input disabled={busy || probing} list="agent-model-suggestions" onChange={(event) => setModelName(event.target.value)} placeholder={runtime === 'codex' ? '例如 qwen3.6-plus' : '例如 claude-sonnet-4-6'} value={modelName} /><datalist id="agent-model-suggestions">{modelSuggestions[runtime].map((model) => <option key={model} value={model} />)}</datalist></label>
              <label className="field agent-url-field"><span>模型 URL <small>HTTPS / 本机回环</small></span><input disabled={busy || probing} onChange={(event) => setBaseUrl(event.target.value)} placeholder={defaultBaseUrls[runtime]} value={baseUrl} /></label>
              <label className="field"><span>认证方式 <small>{authentication === 'none' ? '仅限本机回环' : 'Keychain'}</small></span><select disabled={busy || probing} onChange={(event) => { const next = event.target.value as AgentAuthenticationKind; setAuthentication(next); setApiKey(''); setClearApiKey(false) }} value={authentication}><option value="api-key">API Key</option><option disabled={provider !== 'ollama' && provider !== 'custom'} value="none">无认证（仅本机）</option></select></label>
              {authentication === 'api-key' ? <label className="field"><span>API Key <small>{keyState}</small></span><input autoComplete="new-password" disabled={busy || probing || clearApiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configuredKey ? '已保存；留空则不修改' : '输入 Key（仅写入 macOS 钥匙串）'} type="password" value={apiKey} /></label> : <div className="local-auth-note"><Icon name="shield" size={16} /><span><strong>本机无认证</strong><small>只允许回环地址，不会创建 Keychain 条目</small></span></div>}
              </div>
              {runtime === 'claude-code' && <p className="agent-test-hint">Claude 自定义 URL 必须兼容 Anthropic Messages API，OpenAI-compatible URL 不能直接使用。</p>}
            </div>
          )}
          {mode === 'custom-model' && authentication === 'api-key' && (
            <label className="clear-key-row"><input checked={clearApiKey} disabled={busy || probing || !configuredKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey('') }} type="checkbox" /><span><strong>清除当前 Runtime 与 URL 的 Key</strong><small>仅在保存时从 macOS 钥匙串删除</small></span></label>
          )}
          {mode === 'custom-model' && <div className="byok-security-strip"><span><Icon name="shield" size={14} />Key 仅存钥匙串</span><span><Icon name="check" size={14} />Endpoint 变更需重输</span><span><Icon name="check" size={14} />测试不访问业务数据</span></div>}
        </div>

        {validationError && <div className="inline-alert danger"><Icon name="warning" size={16} /><div><strong>配置未通过检查</strong><p>{validationError}</p></div></div>}
        <div className="agent-test-row">
          <div aria-live="polite" className={`agent-test-state${testing ? ' checking' : !testResultIsStale && agentTestResult ? ' succeeded' : !testResultIsStale && agentTestError ? ' failed' : ''}`}>
            <span />
            <div>
              <strong>{testing ? '正在隔离 Worker 中测试…' : testResultIsStale ? '配置已更改，测试结果已失效' : agentTestResult ? '最近一次测试成功' : agentTestError ? '最近一次测试失败' : '尚未测试模型配置'}</strong>
              <small>{testResultIsStale ? '请先保存当前配置，再重新测试' : agentTestResult ? `${agentTestResult.detail} · ${agentTestResult.durationMs} ms${agentTestResult.runtimeVersion ? ` · ${agentTestResult.runtimeVersion}` : ''}` : agentTestError || '保存并检测 Runtime 后，可执行一次不访问业务数据的最小模型请求；远程 Provider 可能产生少量费用'}</small>
            </div>
          </div>
          <button className="button secondary" disabled={busy || probing || testing || !canTest} onClick={onTest} type="button"><Icon name="send" size={14} /> {testing ? '测试中…' : '测试模型配置'}</button>
        </div>
        {!formMatchesSavedConfiguration && <p className="agent-test-hint">请先保存当前配置，再运行模型测试。</p>}
        <div className="agent-save-bar"><div><Icon name="shield" size={17} /><span><strong>安全保存</strong><small>更新配置不会将 Key 传回页面</small></span></div><button className="button primary" disabled={busy || probing || testing} type="submit">{busy ? '正在保存…' : '保存应用配置'}</button></div>
      </form>
    </div>
  )
}

const isAllowedModelUrl = (value: string): boolean => {
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(value)) return false
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

const isLoopbackModelUrl = (value: string): boolean => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(value).hostname)
  } catch {
    return false
  }
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationConfigurationPanel } from '../../src/renderer/src/components/ApplicationConfigurationPanel'
import { DEFAULT_CONFIG } from '../../src/shared/contracts'

describe('ApplicationConfigurationPanel runtime detection', () => {
  const renderPanel = (configuration = structuredClone(DEFAULT_CONFIG.agent)): string => renderToStaticMarkup(
    <ApplicationConfigurationPanel
      agentTestError={null}
      agentTestResult={null}
      busy={false}
      configuration={configuration}
      daemon={undefined}
      onProbe={vi.fn()}
      onSave={vi.fn()}
      onTest={vi.fn()}
      probing={false}
      runtimeStatuses={{}}
      testing={false}
    />
  )

  it('展示所选 Codex Runtime 的就绪状态和版本，并允许重新检测', () => {
    const configuration = structuredClone(DEFAULT_CONFIG.agent)
    configuration.runtime = 'codex'
    const markup = renderToStaticMarkup(
      <ApplicationConfigurationPanel
        agentTestError={null}
        agentTestResult={null}
        busy={false}
        configuration={configuration}
        daemon={undefined}
        onProbe={vi.fn()}
        onSave={vi.fn()}
        onTest={vi.fn()}
        probing={false}
        runtimeStatuses={{
          codex: {
            runtime: 'codex',
            available: true,
            detail: 'Codex CLI 已就绪',
            checkedAt: '2026-08-11T00:00:00.000Z',
            version: 'codex-cli 0.147.0-alpha.6.5'
          }
        }}
        testing={false}
      />
    )

    expect(markup).toContain('Codex CLI 已就绪')
    expect(markup).toContain('codex-cli 0.147.0-alpha.6.5')
    expect(markup).toMatch(/<button class="button secondary" type="button">[^<]*<svg[^>]*>.*检测 Runtime<\/button>/u)
  })

  it('展示三种配置路径和当前 Runtime 对应的已验证协议', () => {
    const markup = renderPanel()

    expect(markup).toContain('沿用 Runtime')
    expect(markup).toContain('Provider 预设')
    expect(markup).toContain('自定义 Endpoint')
    expect(markup).toContain('OpenAI Responses')
    expect(markup).toContain('一期已验证协议 2')
  })

  it('Ollama 无认证配置只展示本机安全提示，不渲染 Key 输入框', () => {
    const configuration = structuredClone(DEFAULT_CONFIG.agent)
    configuration.mode = 'custom-model'
    configuration.model = {
      provider: 'ollama',
      protocol: 'openai-responses',
      authentication: 'none',
      name: 'qwen3',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyConfigured: false
    }
    const markup = renderPanel(configuration)

    expect(markup).toContain('Ollama')
    expect(markup).toContain('本机无认证')
    expect(markup).toContain('只允许回环地址，不会创建 Keychain 条目')
    expect(markup).not.toContain('type="password"')
  })
})

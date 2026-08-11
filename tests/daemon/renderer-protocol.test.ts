import { describe, expect, it } from 'vitest'
import {
  isTrustedRendererDocumentUrl,
  PRODUCTION_RENDERER_CSP,
  RENDERER_ENTRY_URL,
  resolveRendererAssetPath
} from '../../src/main/renderer-protocol'

describe('secure Renderer protocol', () => {
  it('只把 app://luckytag 资源映射到签名 Renderer 根目录', () => {
    expect(resolveRendererAssetPath('/Applications/LuckyTag/renderer', RENDERER_ENTRY_URL))
      .toBe('/Applications/LuckyTag/renderer/index.html')
    expect(resolveRendererAssetPath(
      '/Applications/LuckyTag/renderer',
      'app://luckytag/assets/index-AbCd.js?cache=1'
    )).toBe('/Applications/LuckyTag/renderer/assets/index-AbCd.js')
  })

  it.each([
    'file:///Users/test/Library/Application%20Support/LuckyTag/daemon/install-token',
    'https://luckytag/index.html',
    'app://evil/index.html',
    'app://luckytag/%2e%2e/daemon/install-token',
    'app://luckytag/%252e%252e/daemon/install-token',
    'app://luckytag/assets/%2Fetc/passwd',
    'app://luckytag/assets/%5C..%5Csecret',
    'app://luckytag/assets/%00secret'
  ])('拒绝非应用来源或路径穿越：%s', (url) => {
    expect(() => resolveRendererAssetPath('/Applications/LuckyTag/renderer', url)).toThrow()
  })

  it('生产 IPC 只信任精确主文档，开发态只信任 Vite origin', () => {
    expect(isTrustedRendererDocumentUrl(RENDERER_ENTRY_URL)).toBe(true)
    expect(isTrustedRendererDocumentUrl('app://luckytag/assets/index.js')).toBe(false)
    expect(isTrustedRendererDocumentUrl('app://luckytag/index.html?injected=1')).toBe(false)
    expect(isTrustedRendererDocumentUrl(
      'http://localhost:5173/src/main.tsx',
      'http://localhost:5173'
    )).toBe(true)
    expect(isTrustedRendererDocumentUrl(
      'http://127.0.0.1:5173/src/main.tsx',
      'http://localhost:5173'
    )).toBe(false)
  })

  it('生产 CSP 禁止 Renderer 主动连接网络或本机端口', () => {
    expect(PRODUCTION_RENDERER_CSP).toContain("connect-src 'none'")
    expect(PRODUCTION_RENDERER_CSP).not.toContain('localhost')
    expect(PRODUCTION_RENDERER_CSP).not.toContain('ws:')
  })
})

import { describe, expect, it } from 'vitest'
import { createMainWindowOptions } from '../../src/main/window-options'

describe('main BrowserWindow options', () => {
  it('保留 macOS 原生窗口按钮并使用 hiddenInset 布局', () => {
    const options = createMainWindowOptions('/signed/preload/index.cjs')

    expect(options.frame).not.toBe(false)
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.trafficLightPosition).toEqual({ x: 18, y: 18 })
  })

  it('保持 Preload 路径和 Renderer 安全边界', () => {
    const options = createMainWindowOptions('/signed/preload/index.cjs')

    expect(options.webPreferences).toMatchObject({
      preload: '/signed/preload/index.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
  })
})

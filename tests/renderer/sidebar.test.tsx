import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'

describe('Sidebar', () => {
  it('为原生标题栏保留布局空间，但不重复绘制 macOS 窗口按钮', () => {
    const markup = renderToStaticMarkup(
      <Sidebar active="overview" workerRunning={false} onNavigate={vi.fn()} />
    )

    expect(markup).toContain('class="sidebar"')
    expect(markup).toContain('class="titlebar-spacer"')
    expect(markup).toContain('aria-label="主导航"')
    expect(markup).not.toContain('traffic-lights')
    expect(markup).not.toContain('traffic-light')
  })
})

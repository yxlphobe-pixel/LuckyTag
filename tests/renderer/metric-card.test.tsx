import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MetricCard } from '../../src/renderer/src/components/MetricCard'

describe('MetricCard', () => {
  it('将比例值作为一个不可拆分的主指标，并保留完整详情提示', () => {
    const markup = renderToStaticMarkup(
      <MetricCard
        detail="仍有连接待配置；SampleDevice 为后续能力"
        icon="shield"
        label="可用连接"
        tone="green"
        value="0 / 3"
      />
    )

    expect(markup).toContain('<strong class="metric-card-value">0 / 3</strong>')
    expect(markup).toContain('class="metric-card-detail"')
    expect(markup).toContain('title="仍有连接待配置；SampleDevice 为后续能力"')
  })
})

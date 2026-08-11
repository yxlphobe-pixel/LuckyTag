import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  new URL('../../src/renderer/src/styles.css', import.meta.url),
  'utf8'
)

function declarationsFor(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  if (start === -1) return ''
  const end = styles.indexOf('}', start)
  return styles.slice(start, end).replace(/\s+/g, ' ')
}

describe('overview metric card layout', () => {
  it('优先保留主数值宽度，并让较长的说明文字在剩余空间省略', () => {
    expect(declarationsFor('.metric-card-body')).toContain(
      'grid-template-columns: auto minmax(0, 1fr)'
    )
    expect(declarationsFor('.metric-card-value')).toContain('min-width: 0')
    expect(declarationsFor('.metric-card-value')).toContain('text-overflow: ellipsis')
    expect(declarationsFor('.metric-card-value')).toContain('white-space: nowrap')
    expect(declarationsFor('.metric-card-detail')).toContain('min-width: 0')
    expect(declarationsFor('.metric-card-detail')).toContain('text-overflow: ellipsis')
  })
})

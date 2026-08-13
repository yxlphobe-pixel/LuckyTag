import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const runRealLayout = process.env['LUCKYTAG_RUN_METRIC_LAYOUT_E2E'] === '1' && process.platform === 'darwin'
const testLayout = runRealLayout ? it : it.skip

const scenarios = [
  { width: 1260, zoom: 1 },
  { width: 1181, zoom: 1 },
  { width: 1180, zoom: 1 },
  { width: 980, zoom: 1 },
  { width: 650, zoom: 1 },
  { width: 320, zoom: 1 },
  { width: 1260, zoom: 1.25 },
  { width: 1260, zoom: 1.5 },
  { width: 1260, zoom: 2 }
]

function card(label: string, value: string, detail: string, tone: string): string {
  return `<article class="metric-card"><span class="metric-icon ${tone}"></span><div class="metric-card-body"><span class="metric-card-label">${label}</span><strong class="metric-card-value">${value}</strong><small class="metric-card-detail" title="${detail}">${detail}</small></div></article>`
}

describe('MetricCard Electron layout', () => {
  testLayout('在临界宽度、窄布局和字体缩放下保持主值单行且卡片不溢出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-metric-layout-'))
    try {
      const styles = await readFile(
        new URL('../../src/renderer/src/styles.css', import.meta.url),
        'utf8'
      )
      const cards = [
        card('知识文档', '12,345', '128 个片段', 'violet'),
        card('已授权群聊', '3', '共配置 3 个', 'blue'),
        card('可用连接', '0 / 3', '仍有连接待配置；SampleDevice 为后续能力', 'green'),
        card('最近运行', '24天前', '7/18 22:05', 'amber')
      ].join('')
      const htmlPath = join(root, 'metric-layout.html')
      await writeFile(htmlPath, `<!doctype html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body><div class="app-shell"><aside class="sidebar"></aside><main class="main-content"><div class="page-content"><section class="metric-grid">${cards}</section></div></main></div></body></html>`)

      const require = createRequire(import.meta.url)
      const electronPath = require('electron') as string
      const runnerPath = fileURLToPath(
        new URL('./fixtures/metric-card-electron-runner.cjs', import.meta.url)
      )
      const { stdout } = await execFileAsync(
        electronPath,
        [runnerPath, htmlPath, JSON.stringify(scenarios)],
        { maxBuffer: 1024 * 1024, timeout: 30_000 }
      )
      const resultLine = stdout.split('\n').find((line) => line.startsWith('LUCKYTAG_METRIC_RESULT='))
      expect(resultLine).toBeDefined()
      const results = JSON.parse(resultLine!.slice('LUCKYTAG_METRIC_RESULT='.length)) as Array<{
        measurement: {
          longValue: LayoutMeasurement
          ratio: LayoutMeasurement
        }
        width: number
        zoom: number
      }>

      expect(results).toHaveLength(scenarios.length)
      for (const result of results) {
        expect(result.measurement.ratio, `${result.width}px @ ${result.zoom}x ratio`).toMatchObject({
          bodyOverflow: false,
          cardOverflow: false,
          lineCount: 1,
          valueOverflow: false,
          valueTextOverflow: 'ellipsis',
          valueWhiteSpace: 'nowrap'
        })
        expect(result.measurement.longValue, `${result.width}px @ ${result.zoom}x long value`).toMatchObject({
          bodyOverflow: false,
          cardOverflow: false,
          lineCount: 1,
          valueOverflow: true,
          valueTextOverflow: 'ellipsis',
          valueWhiteSpace: 'nowrap'
        })
        expect(result.measurement.ratio.detailTextOverflow).toBe('ellipsis')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)
})

interface LayoutMeasurement {
  bodyOverflow: boolean
  cardOverflow: boolean
  detailTextOverflow: string
  lineCount: number
  valueOverflow: boolean
  valueTextOverflow: string
  valueWhiteSpace: string
}

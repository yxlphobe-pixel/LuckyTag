import { describe, expect, it } from 'vitest'
import { AgentRuntimeRegistry } from '../../src/daemon/agent-runtime'

const runRealCodexProbe = process.env['LUCKYTAG_RUN_REAL_CODEX_E2E'] === '1' && process.platform === 'darwin'
const testRealCodexProbe = runRealCodexProbe ? it : it.skip

describe('Codex CLI real runtime probe', () => {
  testRealCodexProbe('通过生产路径解析器读取本机 Codex CLI 版本', async () => {
    const status = await new AgentRuntimeRegistry().probe('codex', true)

    expect(status).toMatchObject({
      runtime: 'codex',
      available: true,
      detail: 'Codex CLI 已就绪'
    })
    expect(status.version).toMatch(/^codex-cli\s+\S+/u)
  })
})

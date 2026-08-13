import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DAEMON_REQUEST_TIMEOUTS, DaemonClient } from '../../src/main/daemon-client'
import {
  DAEMON_NATIVE_APPROVAL,
  DAEMON_NATIVE_APPROVAL_HEADER
} from '../../src/daemon/protocol'
import { DEFAULT_CONFIG, type DashboardSnapshot } from '../../src/shared/contracts'
import { SAMPLE_AUTH_LOGIN_TIMEOUT_MS } from '../../src/main/identity/sampleauth-cli-adapter'

const servers: Server[] = []
const roots: string[] = []
const BUILD_IDENTITY = 'a'.repeat(64)

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DaemonClient Unix Domain Socket transport', () => {
  it('使用安装级 Bearer Token 访问本地服务', async () => {
    const { client } = await createFixture()

    await expect(client.health()).resolves.toMatchObject({
      connected: true,
      transport: 'unix-socket'
    })
  })

  it('拒绝错误 Token，不会将 401 伪装成网络异常', async () => {
    const { socketPath } = await createFixture()
    const unauthorized = new DaemonClient(
      socketPath,
      'wrong-install-token-that-is-at-least-32-bytes',
      BUILD_IDENTITY
    )

    await expect(unauthorized.health()).rejects.toMatchObject({ code: 'DAEMON_UNAUTHORIZED' })
  })

  it('通过 SSE 接收 Daemon 快照更新', async () => {
    const { client, requests } = await createFixture()
    const snapshot = fixtureSnapshot()
    const received = new Promise<DashboardSnapshot>((resolve) => {
      const dispose = client.subscribe((value) => {
        dispose()
        resolve(value)
      })
    })

    await expect(received).resolves.toMatchObject({
      config: { version: 3 },
      daemon: { connected: true }
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(requests.filter((value) => value === 'GET /v1/events')).toHaveLength(1)
    expect(snapshot.config.version).toBe(3)
  })

  it('拒绝不兼容的 Daemon 协议版本', async () => {
    const { socketPath, token } = await createFixture({ protocolVersion: 999 })
    const client = new DaemonClient(socketPath, token, BUILD_IDENTITY)

    await expect(client.health()).rejects.toMatchObject({ code: 'DAEMON_PROTOCOL_MISMATCH' })
  })

  it('代理 Agent 配置实测路由且响应不包含模型输出或凭据', async () => {
    const { client, requests } = await createFixture()

    await expect(client.testAgentConfiguration()).resolves.toMatchObject({
      runtime: 'codex',
      mode: 'custom-model',
      status: 'succeeded'
    })
    expect(requests).toContain('POST /v1/agent/test')
  })

  it('探测用户当前选择的 Runtime，而不是服务中已保存的 Runtime', async () => {
    const { client, probedRuntimes } = await createFixture()

    await expect(client.probeAgentRuntime('codex')).resolves.toMatchObject({
      runtime: 'codex',
      available: true,
      version: 'codex-cli fixture'
    })
    expect(probedRuntimes).toEqual(['codex'])
  })

  it('拒绝协议相同但构建标识过期的 Daemon', async () => {
    const { socketPath, token } = await createFixture({ buildIdentity: 'b'.repeat(64) })
    const client = new DaemonClient(socketPath, token, BUILD_IDENTITY)

    await expect(client.health()).rejects.toMatchObject({ code: 'DAEMON_BUILD_MISMATCH' })
  })

  it('为交互认证与长任务保留足够的绝对截止时间', () => {
    expect(DAEMON_REQUEST_TIMEOUTS.authentication).toBeGreaterThanOrEqual(
      SAMPLE_AUTH_LOGIN_TIMEOUT_MS + 30_000
    )
    expect(DAEMON_REQUEST_TIMEOUTS.agentTest).toBeGreaterThanOrEqual(120_000)
    expect(DAEMON_REQUEST_TIMEOUTS.longRunningJob).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('只在 Main 明确批准时为敏感 Daemon 请求附带原生批准断言', async () => {
    const { client, approvals } = await createFixture()

    await client.saveConfig(structuredClone(DEFAULT_CONFIG))
    await client.saveConfig(structuredClone(DEFAULT_CONFIG), { approveLiveSending: true })
    await client.disconnectSampleAuth({ approved: true })
    await client.startWorker({ approveLiveSending: true })
    await client.runOnce({ approveLiveSending: true })

    expect(approvals).toEqual([
      undefined,
      DAEMON_NATIVE_APPROVAL.enableLiveSending,
      DAEMON_NATIVE_APPROVAL.disconnectSampleAuth,
      DAEMON_NATIVE_APPROVAL.enableLiveSending,
      DAEMON_NATIVE_APPROVAL.enableLiveSending
    ])
  })
})

const createFixture = async (
  options: { protocolVersion?: number; buildIdentity?: string } = {}
): Promise<{
  client: DaemonClient
  socketPath: string
  token: string
  requests: string[]
  approvals: Array<string | undefined>
  probedRuntimes: string[]
}> => {
  const root = await mkdtemp(join(tmpdir(), 'luckytag-daemon-client-'))
  roots.push(root)
  const socketPath = join(root, 'daemon.sock')
  const token = 'fixture-install-token-at-least-32-bytes'
  const requests: string[] = []
  const approvals: Array<string | undefined> = []
  const probedRuntimes: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method || 'GET'} ${request.url || '/'}`)
    if (
      request.url === '/v1/config' ||
      request.url === '/v1/connections/sampleauth/disconnect' ||
      request.url === '/v1/worker/start' ||
      request.url === '/v1/worker/run-once'
    ) {
      const approval = request.headers[DAEMON_NATIVE_APPROVAL_HEADER]
      approvals.push(typeof approval === 'string' ? approval : undefined)
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'DAEMON_UNAUTHORIZED', message: '未授权' } }))
      return
    }
    if (request.url === '/v1/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify(fixtureSnapshot())}\n\n`)
      return
    }
    if (request.url === '/v1/agent/test') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        data: {
          runtime: 'codex',
          mode: 'custom-model',
          status: 'succeeded',
          testedAt: '2026-08-10T00:00:01.000Z',
          durationMs: 123,
          detail: 'Agent Runtime 与模型连接测试成功'
        }
      }))
      return
    }
    if (request.url === '/v1/agent/probe') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { runtime?: string }
        probedRuntimes.push(body.runtime || '')
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          data: {
            runtime: body.runtime,
            available: true,
            detail: 'Codex CLI 已就绪',
            checkedAt: '2026-08-11T00:00:00.000Z',
            version: 'codex-cli fixture'
          }
        }))
      })
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      data: {
        ...fixtureDaemonStatus(socketPath),
        protocolVersion: options.protocolVersion ?? 1,
        buildIdentity: options.buildIdentity ?? BUILD_IDENTITY
      }
    }))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return {
    client: new DaemonClient(socketPath, token, BUILD_IDENTITY),
    socketPath,
    token,
    requests,
    approvals,
    probedRuntimes
  }
}

const fixtureDaemonStatus = (endpoint = '/tmp/luckytag.sock') => ({
  connected: true as const,
  pid: 42,
  startedAt: '2026-08-10T00:00:00.000Z',
  transport: 'unix-socket' as const,
  endpoint
})

const fixtureSnapshot = (): DashboardSnapshot => ({
  config: structuredClone(DEFAULT_CONFIG),
  connections: [],
  knowledge: { documentCount: 0, chunkCount: 0, sourceErrors: [] },
  runtime: { running: false, processing: false, instanceId: 'fixture' },
  recentReplies: [],
  daemon: fixtureDaemonStatus()
})

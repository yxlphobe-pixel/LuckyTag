import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import type {
  AgentConfigurationInput,
  AgentConfigurationTestResult,
  AgentRuntimeKind,
  AgentRuntimeStatus,
  ApiResult,
  AppConfig,
  ConnectionStatus,
  DaemonStatus,
  DashboardSnapshot,
  DimaRequirementCreateInput,
  DimaRequirementInput,
  DimaRequirementPreview,
  DimaRequirementResult,
  RunSummary,
  RuntimeStatus,
  SyncSummary
} from '../shared/contracts'
import {
  DAEMON_NATIVE_APPROVAL,
  DAEMON_NATIVE_APPROVAL_HEADER,
  DAEMON_PROTOCOL_VERSION,
  type DaemonHealthEnvelope
} from '../daemon/protocol'

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024
const HEALTH_TIMEOUT_MS = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DAEMON_SSE_WATCHDOG_TIMEOUT_MS = 45_000

export const DAEMON_REQUEST_TIMEOUTS = Object.freeze({
  agentTest: 130_000,
  // OpenAuth intentionally allows a five-minute browser login window. Keep the
  // desktop deadline beyond the adapter's 330-second process timeout so the UI
  // never reports failure while the CLI can still mutate login state.
  authentication: 360_000,
  connectorProbe: 150_000,
  dimaWorkflow: 10 * 60_000,
  longRunningJob: 30 * 60_000
})

type DaemonHealthResponse = DaemonStatus & DaemonHealthEnvelope

export class DaemonClient {
  constructor(
    readonly socketPath: string,
    private readonly token: string,
    private readonly expectedBuildIdentity: string
  ) {
    if (!socketPath.trim()) throw new Error('LuckyTag 本机服务 Socket 路径不能为空')
    if (token.length < 32) throw new Error('LuckyTag 本机服务安装令牌无效')
    if (!/^[a-f0-9]{64}$/u.test(expectedBuildIdentity)) {
      throw new Error('LuckyTag 本机服务构建标识无效')
    }
  }

  async health(): Promise<DaemonStatus> {
    const health = await this.request<DaemonHealthResponse>('GET', '/v1/health', undefined, HEALTH_TIMEOUT_MS)
    if (health.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw Object.assign(new Error('LuckyTag 本机服务协议版本不兼容'), {
        code: 'DAEMON_PROTOCOL_MISMATCH'
      })
    }
    if (health.buildIdentity !== this.expectedBuildIdentity) {
      throw Object.assign(new Error('LuckyTag 本机服务构建版本与桌面端不一致'), {
        code: 'DAEMON_BUILD_MISMATCH'
      })
    }
    const { protocolVersion: _protocolVersion, buildIdentity: _buildIdentity, ...status } = health
    return status
  }

  getSnapshot(): Promise<DashboardSnapshot> {
    return this.request('GET', '/v1/snapshot')
  }

  saveConfig(
    config: AppConfig,
    options: { approveLiveSending?: boolean } = {}
  ): Promise<DashboardSnapshot> {
    return this.request('PUT', '/v1/config', config, DEFAULT_REQUEST_TIMEOUT_MS, options.approveLiveSending
      ? { [DAEMON_NATIVE_APPROVAL_HEADER]: DAEMON_NATIVE_APPROVAL.enableLiveSending }
      : undefined)
  }

  saveAgentConfiguration(input: AgentConfigurationInput): Promise<DashboardSnapshot> {
    return this.request('PUT', '/v1/agent/configuration', input)
  }

  probeAgentRuntime(runtime: AgentRuntimeKind): Promise<AgentRuntimeStatus> {
    return this.request('POST', '/v1/agent/probe', { runtime })
  }

  testAgentConfiguration(): Promise<AgentConfigurationTestResult> {
    return this.request('POST', '/v1/agent/test', undefined, DAEMON_REQUEST_TIMEOUTS.agentTest)
  }

  syncKnowledge(): Promise<SyncSummary> {
    return this.request('POST', '/v1/knowledge/sync', undefined, DAEMON_REQUEST_TIMEOUTS.longRunningJob)
  }

  probeConnections(): Promise<ConnectionStatus[]> {
    return this.request('POST', '/v1/connections/probe', undefined, DAEMON_REQUEST_TIMEOUTS.connectorProbe)
  }

  authenticate(kind: 'dingtalk' | 'yuque' | 'openauth'): Promise<ConnectionStatus> {
    return this.request(
      'POST',
      '/v1/connections/authenticate',
      { kind },
      DAEMON_REQUEST_TIMEOUTS.authentication
    )
  }

  disconnectOpenAuth(options: { approved?: boolean } = {}): Promise<DashboardSnapshot> {
    return this.request(
      'POST',
      '/v1/connections/openauth/disconnect',
      undefined,
      DEFAULT_REQUEST_TIMEOUT_MS,
      options.approved
        ? { [DAEMON_NATIVE_APPROVAL_HEADER]: DAEMON_NATIVE_APPROVAL.disconnectOpenAuth }
        : undefined
    )
  }

  startWorker(options: { approveLiveSending?: boolean } = {}): Promise<RuntimeStatus> {
    return this.request('POST', '/v1/worker/start', undefined, DEFAULT_REQUEST_TIMEOUT_MS,
      options.approveLiveSending
        ? { [DAEMON_NATIVE_APPROVAL_HEADER]: DAEMON_NATIVE_APPROVAL.enableLiveSending }
        : undefined)
  }

  stopWorker(): Promise<RuntimeStatus> {
    return this.request('POST', '/v1/worker/stop', undefined, DAEMON_REQUEST_TIMEOUTS.longRunningJob)
  }

  runOnce(options: { approveLiveSending?: boolean } = {}): Promise<RunSummary> {
    return this.request(
      'POST',
      '/v1/worker/run-once',
      undefined,
      DAEMON_REQUEST_TIMEOUTS.longRunningJob,
      options.approveLiveSending
        ? { [DAEMON_NATIVE_APPROVAL_HEADER]: DAEMON_NATIVE_APPROVAL.enableLiveSending }
        : undefined
    )
  }

  shutdown(): Promise<null> {
    return this.request('POST', '/v1/admin/shutdown', undefined, 5_000)
  }

  previewDimaRequirement(input: DimaRequirementInput): Promise<DimaRequirementPreview> {
    return this.request('POST', '/v1/dima/preview', input, DAEMON_REQUEST_TIMEOUTS.dimaWorkflow)
  }

  createDimaRequirement(input: DimaRequirementCreateInput): Promise<DimaRequirementResult> {
    return this.request('POST', '/v1/dima/create', input, DAEMON_REQUEST_TIMEOUTS.dimaWorkflow)
  }

  subscribe(onSnapshot: (snapshot: DashboardSnapshot) => void): () => void {
    let disposed = false
    let activeRequest: ClientRequest | undefined
    let activeResponse: IncomingMessage | undefined
    let reconnectTimer: NodeJS.Timeout | undefined
    let watchdogTimer: NodeJS.Timeout | undefined
    let reconnectDelayMs = 250

    const clearWatchdog = (): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = undefined
    }

    const resetWatchdog = (): void => {
      clearWatchdog()
      watchdogTimer = setTimeout(() => {
        activeResponse?.destroy(Object.assign(new Error('LuckyTag 本机服务事件流心跳超时'), {
          code: 'DAEMON_EVENT_HEARTBEAT_TIMEOUT'
        }))
      }, DAEMON_SSE_WATCHDOG_TIMEOUT_MS)
      watchdogTimer.unref()
    }

    const connect = (): void => {
      if (disposed) return
      activeRequest = httpRequest({
        socketPath: this.socketPath,
        path: '/v1/events',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream'
        }
      })
      activeRequest.on('response', (response) => {
        activeResponse = response
        if (
          response.statusCode !== 200 ||
          !String(response.headers['content-type'] || '').toLowerCase().startsWith('text/event-stream')
        ) {
          response.resume()
          clearWatchdog()
          if (response.statusCode !== 401 && response.statusCode !== 403) scheduleReconnect()
          return
        }
        reconnectDelayMs = 250
        resetWatchdog()
        parseEventStream(response, onSnapshot, resetWatchdog)
        response.once('end', scheduleReconnect)
        response.once('error', scheduleReconnect)
        response.once('close', scheduleReconnect)
      })
      activeRequest.once('error', scheduleReconnect)
      activeRequest.end()
    }

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimer) return
      clearWatchdog()
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, reconnectDelayMs)
      reconnectTimer.unref()
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000)
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearWatchdog()
      activeResponse?.destroy()
      activeRequest?.destroy()
    }
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    additionalHeaders?: Readonly<Record<string, string>>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          Connection: 'close',
          ...additionalHeaders,
          ...(encoded ? {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(encoded.length)
          } : {})
        },
        timeout: timeoutMs
      }, (response) => {
        void readResponse<T>(response).then((result) => {
          if (!result.ok) {
            reject(Object.assign(new Error(result.error.message), {
              code: result.error.code,
              ...(result.error.detail ? { detail: result.error.detail } : {})
            }))
            return
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(Object.assign(new Error(`本机服务返回 HTTP ${response.statusCode ?? 0}`), {
              code: 'DAEMON_HTTP_ERROR'
            }))
            return
          }
          resolve(result.data)
        }).catch(reject)
      })
      request.once('timeout', () => request.destroy(Object.assign(new Error('LuckyTag 本机服务请求超时'), {
        code: 'DAEMON_REQUEST_TIMEOUT'
      })))
      request.once('error', reject)
      if (encoded) request.write(encoded)
      request.end()
    })
  }
}

const readResponse = async <T>(response: IncomingMessage): Promise<ApiResult<T>> => {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_RESPONSE_BYTES) throw new Error('本机服务返回数据过大')
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!isApiResult(value)) throw new Error('invalid envelope')
    return value as ApiResult<T>
  } catch {
    throw Object.assign(new Error('本机服务返回了无效响应'), { code: 'INVALID_DAEMON_RESPONSE' })
  }
}

const isApiResult = (value: unknown): value is ApiResult<unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record['ok'] === true) return Object.hasOwn(record, 'data')
  if (record['ok'] !== false) return false
  const error = record['error']
  return typeof error === 'object' && error !== null && !Array.isArray(error) &&
    typeof (error as Record<string, unknown>)['code'] === 'string' &&
    typeof (error as Record<string, unknown>)['message'] === 'string'
}

const parseEventStream = (
  response: IncomingMessage,
  onSnapshot: (snapshot: DashboardSnapshot) => void,
  onActivity: () => void
): void => {
  response.setEncoding('utf8')
  let buffer = ''
  response.on('data', (chunk: string) => {
    onActivity()
    buffer += chunk.replaceAll('\r\n', '\n')
    if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
      response.destroy(Object.assign(new Error('本机服务事件数据过大'), {
        code: 'DAEMON_EVENT_TOO_LARGE'
      }))
      return
    }
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = event
        .split('\n')
        .filter((line) => line === 'data:' || line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) {
        try {
          onSnapshot(JSON.parse(data) as DashboardSnapshot)
        } catch {
          // Ignore a malformed event and keep the authenticated stream alive.
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  })
}

import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRuntimeRegistry, IsolatedAgentRunner } from '../../src/daemon/agent-runtime'
import type { AgentConfiguration } from '../../src/shared/contracts'

const RUN_REAL_E2E = process.env['LUCKYTAG_RUN_REAL_CLAUDE_E2E'] === '1'
const EXPECTED_VERSION = process.env['LUCKYTAG_CLAUDE_E2E_VERSION']?.trim() || '2.1.112'
const FIXED_PROMPT = 'Reply with exactly: LUCKYTAG_OK'
const FAKE_API_KEY = 'luckytag-local-e2e-fake-key'

interface CapturedMessageRequest {
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  path: string
}

describe.skipIf(!RUN_REAL_E2E)('Claude Code real CLI local-provider E2E', () => {
  it('通过 IsolatedAgentRunner 调用本机 Messages Provider 且不留下会话目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-real-claude-e2e-'))
    const dataRoot = join(root, 'data')
    const maliciousNode = join(root, 'node')
    const maliciousNodeMarker = join(root, 'malicious-node-invoked')
    const messages: CapturedMessageRequest[] = []
    const provider = createFakeAnthropicProvider(messages)
    const originalEnvironment = captureEnvironment([
      'LUCKYTAG_CLAUDE_PATH',
      'PATH',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      'NO_PROXY',
      'no_proxy'
    ])

    try {
      await writeFile(maliciousNode, maliciousNodeScript(), { encoding: 'utf8', mode: 0o700 })
      const port = await listenOnLoopback(provider)
      // A shebang-based invocation would resolve this malicious `node`. Production must instead
      // execute the trusted cli.js through its validated process.execPath.
      delete process.env['LUCKYTAG_CLAUDE_PATH']
      process.env['PATH'] = `${root}${delimiter}${process.env['PATH'] || ''}`
      delete process.env['HTTP_PROXY']
      delete process.env['HTTPS_PROXY']
      delete process.env['http_proxy']
      delete process.env['https_proxy']
      process.env['NO_PROXY'] = '127.0.0.1,localhost'
      process.env['no_proxy'] = '127.0.0.1,localhost'

      const runtimeStatus = await new AgentRuntimeRegistry().probe('claude-code', true)
      expect(runtimeStatus).toMatchObject({ runtime: 'claude-code', available: true })
      expect(runtimeStatus.version).toContain(EXPECTED_VERSION)

      const runner = new IsolatedAgentRunner(dataRoot)
      let result
      try {
        result = await runner.run({
          sessionId: 'real-claude-local-provider',
          prompt: FIXED_PROMPT,
          configuration: customClaudeConfiguration(`http://127.0.0.1:${port}`),
          apiKey: FAKE_API_KEY,
          timeoutMs: 45_000
        })
      } catch (error) {
        const summary = messages.map((message) => message.path).join(', ') || 'none'
        throw new Error(
          `真实 Claude E2E 失败；本地 Provider 收到 ${messages.length} 个 Messages 请求（${summary}）：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }

      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.output.trim()).toBe('LUCKYTAG_OK')
      expect(messages).toHaveLength(1)
      const request = messages[0]!
      expect(request.path).toBe('/v1/messages')
      expect(authValue(request.headers)).toBe(FAKE_API_KEY)
      expect(extractSubmittedPrompt(request.body)).toBe(FIXED_PROMPT)
      expect(request.body.model).toBe('claude-local-e2e')
      expect(await readdir(join(dataRoot, 'workers'))).toEqual([])
      expect(await listRelativeFiles(dataRoot)).toEqual([])
      await expect(access(maliciousNodeMarker)).rejects.toBeTruthy()
    } finally {
      restoreEnvironment(originalEnvironment)
      await closeServer(provider)
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

const maliciousNodeScript = (): string => `#!/bin/sh
marker="\${0%/*}/malicious-node-invoked"
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
  printf 'key-present' > "$marker"
else
  printf 'key-absent' > "$marker"
fi
exit 97
`

const customClaudeConfiguration = (baseUrl: string): AgentConfiguration => ({
  enabled: true,
  runtime: 'claude-code',
  mode: 'custom-model',
  model: {
    provider: 'custom',
    protocol: 'anthropic-messages',
    authentication: 'api-key',
    name: 'claude-local-e2e',
    baseUrl,
    apiKeyConfigured: true
  }
})

const createFakeAnthropicProvider = (messages: CapturedMessageRequest[]): Server =>
  createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }))
        return
      }
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>
      messages.push({ headers: { ...request.headers }, body, path: url.pathname })
      if (body.stream === true) writeStreamingMessage(response)
      else writeJsonMessage(response)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid request' } }))
    })
  })

const writeStreamingMessage = (response: import('node:http').ServerResponse): void => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close'
  })
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_luckytag_local_e2e',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-local-e2e',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 }
      }
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }],
    ['ping', { type: 'ping' }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'LUCKYTAG_OK' }
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 }
    }],
    ['message_stop', { type: 'message_stop' }]
  ] as const
  for (const [event, data] of events) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  response.end()
}

const writeJsonMessage = (response: import('node:http').ServerResponse): void => {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({
    id: 'msg_luckytag_local_e2e',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'LUCKYTAG_OK' }],
    model: 'claude-local-e2e',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 3 }
  }))
}

const readBody = async (request: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 2 * 1024 * 1024) throw new Error('Fake Provider 请求超过 2 MiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const authValue = (headers: IncomingHttpHeaders): string => {
  const apiKey = headers['x-api-key']
  if (typeof apiKey === 'string') return apiKey
  const authorization = headers.authorization || ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization
}

const extractSubmittedPrompt = (body: Record<string, unknown>): string => {
  if (!Array.isArray(body.messages)) return ''
  const user = [...body.messages].reverse().find((message) =>
    isRecord(message) && message.role === 'user'
  )
  if (!isRecord(user)) return ''
  const text = typeof user.content === 'string'
    ? user.content
    : Array.isArray(user.content)
      ? user.content.flatMap((block) =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        ).join('')
      : ''
  // Claude Code injects a runtime-owned date reminder ahead of stdin. Remove
  // only anchored system-reminder wrappers; the remaining text must exactly
  // equal the prompt supplied by LuckyTag.
  return text.replace(/^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/u, '')
}

const listenOnLoopback = (server: Server): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error('Fake Provider 没有获得 TCP 端口'))
      return
    }
    resolve(address.port)
  })
})

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => {
  if (!server.listening) {
    resolve()
    return
  }
  server.close(() => resolve())
  server.closeAllConnections()
})

const listRelativeFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative)
      else files.push(relative)
    }
  }
  await visit(root, '')
  return files.sort()
}

const captureEnvironment = (names: string[]): Map<string, string | undefined> =>
  new Map(names.map((name) => [name, process.env[name]]))

const restoreEnvironment = (values: Map<string, string | undefined>): void => {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

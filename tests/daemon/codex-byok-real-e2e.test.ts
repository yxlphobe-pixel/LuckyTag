import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRuntimeRegistry, IsolatedAgentRunner } from '../../src/daemon/agent-runtime'
import type { AgentConfiguration } from '../../src/shared/contracts'

const RUN_REAL_E2E = process.env['LUCKYTAG_RUN_REAL_BYOK_E2E'] === '1' && process.platform === 'darwin'
const FIXED_PROMPT = 'Reply with exactly: LUCKYTAG_OK'
const FAKE_API_KEY = 'luckytag-local-byok-e2e-fake-key'

interface CapturedResponseRequest {
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  path: string
}

describe.skipIf(!RUN_REAL_E2E)('Codex real CLI BYOK local-provider E2E', () => {
  it('通过生产 Runtime 调用 OpenAI Responses 兼容服务且不留下会话数据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-real-byok-e2e-'))
    const dataRoot = join(root, 'data')
    const requests: CapturedResponseRequest[] = []
    const provider = createFakeResponsesProvider(requests)
    const originalEnvironment = captureEnvironment([
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'
    ])

    try {
      const port = await listenOnLoopback(provider)
      delete process.env['HTTP_PROXY']
      delete process.env['HTTPS_PROXY']
      delete process.env['http_proxy']
      delete process.env['https_proxy']
      process.env['NO_PROXY'] = '127.0.0.1,localhost'
      process.env['no_proxy'] = '127.0.0.1,localhost'

      const runtimeStatus = await new AgentRuntimeRegistry().probe('codex', true)
      expect(runtimeStatus).toMatchObject({ runtime: 'codex', available: true })

      const runner = new IsolatedAgentRunner(dataRoot)
      const result = await runner.run({
        sessionId: 'real-codex-byok-local-provider',
        prompt: FIXED_PROMPT,
        configuration: customCodexConfiguration(`http://127.0.0.1:${port}/v1`),
        apiKey: FAKE_API_KEY,
        timeoutMs: 45_000
      })

      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.output.trim()).toBe('LUCKYTAG_OK')
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      expect(request.path).toBe('/v1/responses')
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_API_KEY}`)
      expect(request.body.model).toBe('byok-local-e2e')
      expect(JSON.stringify(request.body)).toContain(FIXED_PROMPT)
      expect(await readdir(join(dataRoot, 'workers'))).toEqual([])
      await expect(access(join(dataRoot, 'workers', 'real-codex-byok-local-provider'))).rejects.toBeTruthy()
    } finally {
      restoreEnvironment(originalEnvironment)
      await closeServer(provider)
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

const customCodexConfiguration = (baseUrl: string): AgentConfiguration => ({
  enabled: true,
  runtime: 'codex',
  mode: 'custom-model',
  model: {
    provider: 'custom',
    protocol: 'openai-responses',
    authentication: 'api-key',
    name: 'byok-local-e2e',
    baseUrl,
    apiKeyConfigured: true
  }
})

const createFakeResponsesProvider = (requests: CapturedResponseRequest[]): Server =>
  createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method !== 'POST' || url.pathname !== '/v1/responses') {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }))
        return
      }
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>
      requests.push({ headers: { ...request.headers }, body, path: url.pathname })
      writeStreamingResponse(response)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid request', type: 'invalid_request_error' } }))
    })
  })

const writeStreamingResponse = (response: import('node:http').ServerResponse): void => {
  const createdAt = Math.floor(Date.now() / 1000)
  const message = {
    id: 'msg_luckytag_byok_e2e',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'LUCKYTAG_OK', annotations: [], logprobs: [] }]
  }
  const completed = {
    id: 'resp_luckytag_byok_e2e',
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'byok-local-e2e',
    output: [message],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    service_tier: 'default',
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 },
    user: null,
    metadata: {}
  }
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', sequence_number: 0, response: { ...completed, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', sequence_number: 2, item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    { type: 'response.output_text.delta', sequence_number: 3, item_id: message.id, output_index: 0, content_index: 0, delta: 'LUCKYTAG_OK', logprobs: [] },
    { type: 'response.output_text.done', sequence_number: 4, item_id: message.id, output_index: 0, content_index: 0, text: 'LUCKYTAG_OK', logprobs: [] },
    { type: 'response.content_part.done', sequence_number: 5, item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: message },
    { type: 'response.completed', sequence_number: 7, response: completed }
  ]
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close'
  })
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

const readBody = async (request: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const listenOnLoopback = (server: Server): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject)
    const address = server.address()
    if (!address || typeof address === 'string') reject(new Error('无法取得本机测试端口'))
    else resolve(address.port)
  })
})

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => {
  if (!server.listening) resolve()
  else server.close(() => resolve())
})

const captureEnvironment = (names: string[]): Map<string, string | undefined> =>
  new Map(names.map((name) => [name, process.env[name]]))

const restoreEnvironment = (snapshot: Map<string, string | undefined>): void => {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

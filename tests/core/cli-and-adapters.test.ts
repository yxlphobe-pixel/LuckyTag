import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCliSearchPath,
  CliExecutionError,
  CliRunner,
  parseJsonOutput,
  type JsonCliRunner,
  type RunJsonOptions
} from '../../src/main/core/cli-runner'
import { DwsAdapter } from '../../src/main/core/dws-adapter'
import { buildYuqueCliEnvironment, YuqueAdapter } from '../../src/main/core/yuque-adapter'
import { stableUuid } from '../../src/main/core/worker'

class RecordingRunner implements JsonCliRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options?: RunJsonOptions }> = []
  responses: unknown[] = []

  async runJson<T>(executable: string, args: readonly string[], options?: RunJsonOptions): Promise<T> {
    this.calls.push({ executable, args, ...(options ? { options } : {}) })
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response as T
  }
}

describe('CLI JSON boundary', () => {
  it('safely parses a notice prefix followed by pretty-printed JSON', () => {
    const output = '发现新版本，请稍后升级\n{\n  "success": true,\n  "body": {"name": "Lucky"}\n}\n'
    expect(parseJsonOutput<{ success: boolean }>(output).success).toBe(true)
  })

  it('rejects output that has no complete JSON suffix', () => {
    expect(() => parseJsonOutput('notice only {not-json')).toThrow()
  })

  it('never recovers a valid nested object from a malformed outer JSON envelope', () => {
    const malformed =
      '{"success":false,"message":"truncated response","data":{"openTaskId":"must-not-pass"}'
    const multilineMalformed =
      '{\n"success":false,\n"message":"truncated response",\n"data":\n{"openTaskId":"must-not-pass"}'

    expect(() => parseJsonOutput(malformed)).toThrow()
    expect(() => parseJsonOutput(multilineMalformed)).toThrow()
  })

  it('adds common macOS CLI directories to a Finder-like PATH without duplicates', () => {
    const path = buildCliSearchPath({
      currentPath: '/usr/bin:/bin:/usr/bin',
      homeDirectory: '/Users/example',
      platform: 'darwin'
    })
    const entries = path.split(':')

    expect(entries.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
    expect(entries).toContain('/Users/example/.local/bin')
    expect(entries).toContain('/opt/homebrew/bin')
    expect(entries).toContain('/usr/local/bin')
    expect(entries.filter((entry) => entry === '/usr/bin')).toHaveLength(1)
  })

  it('supplies the managed macOS enterprise CA to Finder-launched CLIs when absent', () => {
    const environment = buildYuqueCliEnvironment(
      { PATH: '/usr/bin:/bin' },
      'darwin',
      (path) => path === '/Library/Application Support/starpoint/CertManager/certificate.crt'
    )

    expect(environment.NODE_EXTRA_CA_CERTS).toBe(
      '/Library/Application Support/starpoint/CertManager/certificate.crt'
    )
  })

  it('never overrides an explicit CA value or injects a missing managed certificate', () => {
    const explicit = buildYuqueCliEnvironment(
      { PATH: '/usr/bin:/bin', NODE_EXTRA_CA_CERTS: '/custom/company-ca.pem' },
      'darwin',
      () => true
    )
    const missing = buildYuqueCliEnvironment({ PATH: '/usr/bin:/bin' }, 'darwin', () => false)
    const linux = buildYuqueCliEnvironment({ PATH: '/usr/bin:/bin' }, 'linux', () => true)

    expect(explicit.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(missing.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(linux.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it('finds a user-local JSON CLI when the inherited GUI PATH is minimal', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'luckytag-cli-home-'))
    const binDirectory = join(homeDirectory, '.local', 'bin')
    const executable = join(binDirectory, 'fixture-json-cli')

    try {
      await mkdir(binDirectory, { recursive: true })
      await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' \'{"connected":true}\'\n', 'utf8')
      await chmod(executable, 0o700)
      const runner = new CliRunner({
        environment: { PATH: '/usr/bin:/bin' },
        homeDirectory,
        platform: 'darwin'
      })

      await expect(runner.runJson('fixture-json-cli', [])).resolves.toEqual({ connected: true })
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  it('keeps ENOENT machine-readable while returning an actionable message', async () => {
    const runner = new CliRunner({
      environment: { PATH: '/usr/bin:/bin' },
      homeDirectory: '/tmp/luckytag-missing-cli-home',
      platform: 'darwin'
    })

    const failure = await runner.runJson('luckytag-command-that-does-not-exist', []).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CliExecutionError)
    expect(failure).toMatchObject({ exitCode: 'ENOENT' })
    expect((failure as Error).message).toContain('已检查常用 CLI 安装目录')
    expect((failure as Error).message).not.toContain('spawn')
  })

  it('prefers a structured CLI error over a preceding upgrade notice', () => {
    const cause = Object.assign(new Error('command failed'), { code: 1, cmd: 'yuque whoami --json' })
    const error = new CliExecutionError({
      executable: 'yuque',
      args: ['whoami', '--json'],
      stderr: 'Update available for yuque-cli\n{"status":"error","code":"GENERAL_ERROR","message":"Authorization request failed: read ECONNRESET"}',
      cause
    })

    expect(error.message).toContain('Authorization request failed: read ECONNRESET [GENERAL_ERROR]')
    expect(error.message).not.toContain('Update available')
  })

  it('reads a structured error from stdout when a CLI exits non-zero', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luckytag-cli-stdout-error-'))
    const executable = join(directory, 'stdout-error-cli')

    try {
      await writeFile(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"error","code":"AUTH_REQUIRED","message":"please login"}\'\nprintf \'%s\\n\' \'wrapper failed\' >&2\nexit 7\n',
        'utf8'
      )
      await chmod(executable, 0o700)

      const failure = await new CliRunner().runJson(executable, []).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CliExecutionError)
      expect(failure).toMatchObject({ exitCode: 7 })
      expect((failure as Error).message).toContain('please login [AUTH_REQUIRED]')
      expect((failure as Error).message).not.toContain('wrapper failed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('always rejects after the hard deadline even when SIGTERM is caught and exits zero', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luckytag-cli-timeout-'))
    const script = join(directory, 'catch-term.mjs')

    try {
      await writeFile(
        script,
        "process.on('SIGTERM', () => { process.stdout.write('{\\\"success\\\":true}\\n'); process.exit(0) })\nsetInterval(() => {}, 1_000)\n",
        'utf8'
      )
      const runner = new CliRunner({ defaultTimeoutMs: 100 })

      const failure = await runner.runJson(process.execPath, [script]).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CliExecutionError)
      expect(failure).toMatchObject({ exitCode: 'ETIMEDOUT' })
      expect((failure as Error).message).toContain('已终止')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds plain-text CLI error details', () => {
    const cause = Object.assign(new Error('command failed'), { code: 1, cmd: 'fixture' })
    const error = new CliExecutionError({
      executable: 'fixture',
      args: [],
      stderr: 'x'.repeat(20_000),
      cause
    })

    expect(error.message.length).toBeLessThan(2_200)
    expect(error.message).toContain('已截断')
    expect(error.stderr.length).toBeLessThan(8_300)
  })
})

describe('YuqueAdapter', () => {
  it('does not report an empty whoami response as connected', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({})

    await expect(new YuqueAdapter(runner).probe()).resolves.toEqual({
      authenticated: false,
      detail: '语雀尚未认证'
    })
    expect(runner.calls[0]?.options?.environment).toMatchObject({
      CLI_SDK_DISABLE_BROWSER: '1',
      YUQUE_DISABLE_UPDATE_CHECK: '1'
    })
  })

  it('reuses or starts authentication without destructively forcing token removal', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({ login: 'lucky' })

    await expect(new YuqueAdapter(runner).authenticate()).resolves.toMatchObject({
      authenticated: true,
      detail: '已登录：lucky'
    })
    expect(runner.calls[0]).toMatchObject({
      executable: 'yuque',
      args: ['whoami', '--json'],
      options: {
        environment: { YUQUE_DISABLE_UPDATE_CHECK: '1' }
      }
    })
    // The adapter uses one absolute deadline, so a millisecond spent between
    // creating that deadline and invoking the runner is legitimate.
    expect(runner.calls[0]?.options?.timeoutMs).toBeGreaterThanOrEqual(179_900)
    expect(runner.calls[0]?.options?.timeoutMs).toBeLessThanOrEqual(180_000)
  })

  it('passes the managed CA only in the Yuque command environment', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({ login: 'lucky' })

    await new YuqueAdapter(
      runner,
      'yuque',
      'yuque-cli',
      async () => undefined,
      Date.now,
      { NODE_EXTRA_CA_CERTS: '/managed/starpoint-ca.pem' }
    ).authenticate()

    expect(runner.calls[0]?.options?.environment).toEqual({
      NODE_EXTRA_CA_CERTS: '/managed/starpoint-ca.pem',
      YUQUE_DISABLE_UPDATE_CHECK: '1'
    })
  })

  it('retries an initial authorization reset and then completes without using force', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      yuqueFailure('Authorization request failed: read ECONNRESET'),
      { login: 'lucky' }
    )
    const waits: number[] = []

    await expect(
      new YuqueAdapter(runner, 'yuque', 'yuque-cli', async (delayMs) => {
        waits.push(delayMs)
      }).authenticate()
    ).resolves.toMatchObject({
      authenticated: true,
      detail: '已登录：lucky'
    })
    expect(waits).toEqual([400])
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['whoami', '--json'],
      ['whoami', '--json']
    ])
  })

  it('bounds initial authorization network retries and keeps the actionable error', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      yuqueFailure('Authorization request failed: read ECONNRESET'),
      yuqueFailure('Authorization request failed: connect EHOSTUNREACH'),
      yuqueFailure('Authorization request failed: socket hang up')
    )
    const waits: number[] = []

    await expect(
      new YuqueAdapter(runner, 'yuque', 'yuque-cli', async (delayMs) => {
        waits.push(delayMs)
      }).authenticate()
    ).rejects.toMatchObject({
      code: 'YUQUE_AUTH_NETWORK',
      message: expect.stringContaining('内网或 VPN')
    })
    expect(runner.calls).toHaveLength(3)
    expect(waits).toEqual([400, 1_200])
    expect(runner.calls.every((call) => !call.args.includes('--force'))).toBe(true)
  })

  it('uses one absolute authentication deadline across retries', async () => {
    let clock = 0
    const calls: Array<RunJsonOptions | undefined> = []
    const runner: JsonCliRunner = {
      async runJson<T>(
        _executable: string,
        _args: readonly string[],
        options?: RunJsonOptions
      ): Promise<T> {
        calls.push(options)
        clock += 100_000
        if (calls.length === 1) {
          throw yuqueFailure('Authorization request failed: read ECONNRESET')
        }
        return { login: 'lucky' } as T
      }
    }

    await expect(
      new YuqueAdapter(
        runner,
        'yuque',
        'yuque-cli',
        async (delayMs) => {
          clock += delayMs
        },
        () => clock,
        {}
      ).authenticate()
    ).resolves.toMatchObject({ authenticated: true })

    expect(calls[0]?.timeoutMs).toBe(180_000)
    expect(calls[1]?.timeoutMs).toBe(79_600)
  })

  it.each([
    'Poll request failed: read ECONNRESET',
    'Authorization rejected with status code 401',
    'Authorization request failed: timeout of 30000ms exceeded',
    'request failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ])('does not retry a post-authorization or permanent failure: %s', async (detail) => {
    const runner = new RecordingRunner()
    runner.responses.push(yuqueFailure(detail))

    await expect(
      new YuqueAdapter(runner, 'yuque', 'yuque-cli', async () => undefined).authenticate()
    ).rejects.toBeInstanceOf(Error)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args).toEqual(['whoami', '--json'])
  })

  it('keeps the yuque-cli fallback selected across a transient authorization retry', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      new CliExecutionError({
        executable: 'yuque',
        args: ['whoami', '--json'],
        stderr: '',
        cause: Object.assign(new Error('spawn yuque ENOENT'), {
          code: 'ENOENT',
          cmd: 'yuque whoami --json'
        })
      }),
      yuqueFailure('Authorization request failed: read ECONNRESET', 'yuque-cli'),
      { login: 'lucky' }
    )

    await expect(
      new YuqueAdapter(runner, 'yuque', 'yuque-cli', async () => undefined).authenticate()
    ).resolves.toMatchObject({ authenticated: true })
    expect(runner.calls.map((call) => call.executable)).toEqual([
      'yuque',
      'yuque-cli',
      'yuque-cli'
    ])
  })

  it.each([
    'Authorization timeout.',
    'Authorization request failed: timeout'
  ])('turns an authorization timeout into browser completion guidance: %s', async (detail) => {
    const runner = new RecordingRunner()
    runner.responses.push(
      new CliExecutionError({
        executable: 'yuque',
        args: ['whoami', '--json'],
        stderr: JSON.stringify({ status: 'error', code: 'GENERAL_ERROR', message: detail }),
        cause: Object.assign(new Error('command failed'), {
          code: 1,
          cmd: 'yuque whoami --json'
        })
      })
    )

    await expect(new YuqueAdapter(runner).authenticate()).rejects.toMatchObject({
      code: 'YUQUE_AUTH_TIMEOUT'
    })
  })

  it('turns the wrapper hard deadline into actionable Yuque guidance', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      new CliExecutionError({
        executable: 'yuque',
        args: ['whoami', '--json'],
        stderr: '',
        cause: Object.assign(new Error('hard deadline'), {
          code: 'ETIMEDOUT',
          cmd: 'yuque whoami --json'
        })
      })
    )

    await expect(new YuqueAdapter(runner).authenticate()).rejects.toMatchObject({
      code: 'YUQUE_AUTH_TIMEOUT',
      message: expect.stringContaining('内网或 VPN')
    })
    expect(runner.calls).toHaveLength(1)
  })

  it('paginates document listings with offset and limit', async () => {
    const runner = new RecordingRunner()
    runner.responses.push(
      { data: { docs: Array.from({ length: 100 }, (_, index) => ({ slug: `doc-${index}` })) } },
      { data: { docs: [{ slug: 'doc-100' }, { slug: 'doc-101' }] } }
    )

    const documents = await new YuqueAdapter(runner).listDocuments('team/book')

    expect(documents).toHaveLength(102)
    expect(documents.at(-1)).toEqual({ route: 'team/book/doc-101' })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['list', 'docs', 'team/book', '--offset', '0', '--limit', '100', '--json'],
      ['list', 'docs', 'team/book', '--offset', '100', '--limit', '100', '--json']
    ])
  })

  it('stops on a repeated document page and returns each route only once', async () => {
    const runner = new RecordingRunner()
    const page = { data: { docs: Array.from({ length: 100 }, (_, index) => ({ slug: `doc-${index}` })) } }
    runner.responses.push(page, page, { data: { docs: [{ slug: 'should-not-be-read' }] } })

    const documents = await new YuqueAdapter(runner).listDocuments('team/book')

    expect(documents).toHaveLength(100)
    expect(new Set(documents.map((document) => document.route)).size).toBe(100)
    expect(runner.calls).toHaveLength(2)
  })

  it('caps a document listing at two thousand entries', async () => {
    const runner = new RecordingRunner()
    for (let page = 0; page < 20; page += 1) {
      runner.responses.push({
        data: {
          docs: Array.from({ length: 100 }, (_, index) => ({ slug: `doc-${page * 100 + index}` }))
        }
      })
    }
    runner.responses.push({ data: { docs: [{ slug: 'doc-2000' }] } })

    const documents = await new YuqueAdapter(runner).listDocuments('team/book')

    expect(documents).toHaveLength(2_000)
    expect(runner.calls).toHaveLength(20)
  })
})

const yuqueFailure = (detail: string, executable = 'yuque'): CliExecutionError =>
  new CliExecutionError({
    executable,
    args: ['whoami', '--json'],
    stderr: JSON.stringify({ status: 'error', code: 'GENERAL_ERROR', message: detail }),
    cause: Object.assign(new Error('command failed'), {
      code: 1,
      cmd: `${executable} whoami --json`
    })
  })

describe('DwsAdapter', () => {
  it.each([
    { success: true, authenticated: false, message: '未登录' },
    { success: true, authenticated: false, message: '未登录', data: { status: 'ok' } },
    { success: true, data: { status: 'ok' } }
  ])('never treats command success as an authenticated DWS session: %j', async (response) => {
    const runner = new RecordingRunner()
    runner.responses.push(response)

    await expect(new DwsAdapter(runner).probe()).resolves.toMatchObject({
      authenticated: false
    })
  })

  it('does not report an empty auth response as connected', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({})

    await expect(new DwsAdapter(runner).probe()).resolves.toEqual({
      authenticated: false,
      detail: '钉钉 DWS 尚未认证'
    })
  })

  it('uses allowlisted group commands, JSON output, and defensive normalization', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({
      success: true,
      body: {
        items: [
          {
            openMessageId: 'msg-1',
            openConversationId: 'group-1',
            content: '{"text":"请问自动回复怎么配置"}',
            createTime: 1_700_000_000_000,
            sender: { userId: 'user-1', name: '小明' }
          }
        ],
        hasMore: false
      }
    })
    runner.responses.push({ success: true, body: { openTaskId: 'task-1' } })
    const adapter = new DwsAdapter(runner)
    adapter.setAllowlistedGroups(['group-1'])

    const page = await adapter.listMentions({
      groupId: 'group-1',
      start: '2026-07-17T00:00:00+08:00',
      end: '2026-07-17T01:00:00+08:00'
    })
    expect(page.messages[0]).toMatchObject({
      id: 'msg-1',
      groupId: 'group-1',
      text: '请问自动回复怎么配置',
      senderId: 'user-1',
      senderLabel: '小明'
    })

    await adapter.sendMessage({
      groupId: 'group-1',
      text: '答案',
      uuid: stableUuid('msg-1')
    })
    expect(runner.calls).toHaveLength(2)
    for (const call of runner.calls) {
      expect(call.executable).toBe('dws')
      expect(call.args.slice(-2)).toEqual(['--format', 'json'])
    }
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining(['chat', 'message', 'list-mentions', '--group', 'group-1'])
    )
    expect(runner.calls[1]?.args).toEqual(
      expect.arrayContaining(['chat', 'message', 'send', '--uuid', stableUuid('msg-1')])
    )
  })

  it('rejects a group outside the allow-list before invoking DWS', async () => {
    const runner = new RecordingRunner()
    const adapter = new DwsAdapter(runner)
    adapter.setAllowlistedGroups(['group-1'])

    await expect(
      adapter.listMentions({ groupId: 'group-2', start: '2026-01-01', end: '2026-01-02' })
    ).rejects.toThrow('白名单')
    expect(runner.calls).toHaveLength(0)
  })

  it.each([
    { requestId: 'ambiguous-request' },
    { duplicate: true },
    { deduplicated: false }
  ])('rejects a send response without a verifiable receipt: %j', async (body) => {
    const runner = new RecordingRunner()
    runner.responses.push({ success: true, body })
    const adapter = new DwsAdapter(runner)
    adapter.setAllowlistedGroups(['group-1'])

    await expect(
      adapter.sendMessage({ groupId: 'group-1', text: '答案', uuid: stableUuid('msg-1') })
    ).rejects.toMatchObject({ code: 'DWS_SEND_RECEIPT_UNCONFIRMED' })
  })

  it('accepts an explicitly deduplicated send response without another identifier', async () => {
    const runner = new RecordingRunner()
    runner.responses.push({ success: true, body: { deduplicated: true } })
    const adapter = new DwsAdapter(runner)
    adapter.setAllowlistedGroups(['group-1'])

    await expect(
      adapter.sendMessage({ groupId: 'group-1', text: '答案', uuid: stableUuid('msg-1') })
    ).resolves.toEqual({ deduplicated: true })
  })
})

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOGIN_TIMEOUT_MS,
  ExecFileSampleAuthCommandRunner,
  SampleAuthCliAdapter,
  type SampleAuthCommandOptions,
  type SampleAuthCommandResult,
  type SampleAuthCommandRunner
} from '../../src/main/identity/sampleauth-cli-adapter'

const ok = (payload: unknown): SampleAuthCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify(payload),
  stderr: '',
  timedOut: false
})

class RecordingSampleAuthRunner implements SampleAuthCommandRunner {
  readonly calls: Array<{
    executable: string
    args: readonly string[]
    options: SampleAuthCommandOptions
  }> = []
  readonly responses: Array<SampleAuthCommandResult | Promise<SampleAuthCommandResult>> = []

  async run(
    executable: string,
    args: readonly string[],
    options: SampleAuthCommandOptions
  ): Promise<SampleAuthCommandResult> {
    this.calls.push({ executable, args: [...args], options: { ...options } })
    const response = this.responses.shift()
    if (!response) throw new Error('测试未配置 SampleAuth CLI 响应')
    return response
  }
}

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

const createChildReadinessMarker = async (): Promise<{
  path: string
  ready: Promise<void>
  close: () => Promise<void>
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'luckytag-sampleauth-runner-'))
  const markerPath = join(directory, 'ready')

  return {
    path: markerPath,
    ready: waitForMarker(markerPath),
    close: () => rm(directory, { recursive: true, force: true })
  }
}

const waitForMarker = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const poll = (): void => {
      if (existsSync(path)) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('子进程未在 10 秒内写入测试就绪标记'))
        return
      }
      // setImmediate deliberately remains real while only the runner's
      // setTimeout/clearTimeout pair is under Vitest's synthetic clock.
      setImmediate(poll)
    }
    poll()
  })

const runReadyTimeoutFixture = async (
  sigtermHandler: string,
  advanceMs: number
): Promise<SampleAuthCommandResult> => {
  const readiness = await createChildReadinessMarker()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const runner = new ExecFileSampleAuthCommandRunner({ terminationGraceMs: 50 })
    const result = runner.run(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');process.on('SIGTERM',${sigtermHandler});fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`,
        readiness.path
      ],
      { timeoutMs: 100 }
    )

    // `spawn` only means the OS created the process. This application-level
    // handshake proves that Node evaluated the SIGTERM handler before the
    // synthetic clock reaches the deadline, eliminating startup-load races.
    await readiness.ready
    await vi.advanceTimersByTimeAsync(advanceMs)
    return await result
  } finally {
    vi.useRealTimers()
    await readiness.close()
  }
}

describe('SampleAuthCliAdapter', () => {
  it('parses a logged-in status into the renderer-safe identity allow-list', async () => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push(
      ok({
        loggedIn: true,
        user: {
          name: 'Lucky',
          account: '012345',
          accessToken: 'must-not-leak-from-user'
        },
        sessionExpiresAt: 2_000_000_000,
        renewalExpiresAt: 2_000_003_600,
        accessToken: 'must-not-leak',
        renewalToken: 'must-not-leak-either'
      })
    )

    const session = await new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).status()

    expect(session).toEqual({
      authenticated: true,
      displayName: 'Lucky',
      accountNumber: '012345',
      expiresAt: new Date(2_000_000_000_000).toISOString(),
      refreshExpiresAt: new Date(2_000_003_600_000).toISOString()
    })
    expect(JSON.stringify(session)).not.toContain('must-not-leak')
    expect(runner.calls).toEqual([
      {
        executable: 'sample-auth-fixture',
        args: ['status', '--json'],
        options: { timeoutMs: 30_000 }
      }
    ])
  })

  it('accepts the official exit-1 JSON contract for a logged-out status', async () => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push({
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: false, reason: 'not_logged_in' }),
      stderr: '',
      timedOut: false
    })

    await expect(new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).probe()).resolves.toEqual({
      authenticated: false
    })
  })

  it('runs browser login once for concurrent callers with --yes and a timeout beyond five minutes', async () => {
    const runner = new RecordingSampleAuthRunner()
    const response = deferred<SampleAuthCommandResult>()
    runner.responses.push(
      response.promise,
      ok({
        loggedIn: true,
        user: { name: 'Lucky', account: '012345' },
        sessionExpiresAt: 2_000_000_000,
        renewalExpiresAt: null
      })
    )
    const adapter = new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' })

    const first = adapter.login()
    const second = adapter.authenticate()

    expect(first).toBe(second)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]).toMatchObject({
      executable: 'sample-auth-fixture',
      args: ['login', '--yes', '--json'],
      options: { timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS }
    })
    expect(runner.calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
    expect(DEFAULT_LOGIN_TIMEOUT_MS).toBeGreaterThan(5 * 60 * 1000)

    response.resolve(
      ok({
        success: true,
        user: {
          name: 'Lucky',
          account: '012345',
          sub: 'sample:account:012345',
          token: 'must-not-leak'
        },
        ticket: 'must-not-leak'
      })
    )
    await expect(first).resolves.toEqual({
      authenticated: true,
      displayName: 'Lucky',
      accountNumber: '012345',
      subject: 'sample:account:012345',
      expiresAt: new Date(2_000_000_000_000).toISOString()
    })
    expect(runner.calls[1]).toMatchObject({
      executable: 'sample-auth-fixture',
      args: ['status', '--json'],
      options: { timeoutMs: 30_000 }
    })

    runner.responses.push(
      ok({ success: true, user: { account: '012345' } }),
      ok({ loggedIn: true, user: { account: '012345' }, sessionExpiresAt: 2_000_000_000 })
    )
    await adapter.login()
    expect(runner.calls).toHaveLength(4)
  })

  it('refreshes an session_expired session before considering interactive login', async () => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push(
      {
        exitCode: 1,
        stdout: JSON.stringify({ loggedIn: false, reason: 'session_expired' }),
        stderr: '',
        timedOut: false
      },
      ok({ success: true, user: { name: 'Lucky', account: '012345', sub: 'sample:account:012345' } }),
      ok({
        loggedIn: true,
        user: { name: 'Lucky', account: '012345' },
        sessionExpiresAt: 2_000_000_000,
        renewalExpiresAt: null
      })
    )

    await expect(new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).authenticate()).resolves.toMatchObject({
      authenticated: true,
      displayName: 'Lucky',
      accountNumber: '012345'
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['status', '--json'],
      ['refresh', '--json'],
      ['status', '--json']
    ])
  })

  it('falls back to browser login only after an session_expired refresh fails', async () => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push(
      {
        exitCode: 1,
        stdout: JSON.stringify({ loggedIn: false, reason: 'session_expired' }),
        stderr: '',
        timedOut: false
      },
      {
        exitCode: 1,
        stdout: JSON.stringify({ error: true, code: 'AUTH_ERROR', message: 'refresh rejected' }),
        stderr: '',
        timedOut: false
      },
      ok({ success: true, user: { name: 'Lucky', account: '012345', sub: 'sample:account:012345' } }),
      ok({
        loggedIn: true,
        user: { name: 'Lucky', account: '012345' },
        sessionExpiresAt: 2_000_000_000
      })
    )

    await expect(new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).authenticate()).resolves.toMatchObject({
      authenticated: true,
      subject: 'sample:account:012345'
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['status', '--json'],
      ['refresh', '--json'],
      ['login', '--yes', '--json'],
      ['status', '--json']
    ])
  })

  it('cancels and settles an in-flight login before logout so logout wins', async () => {
    const runner = new RecordingSampleAuthRunner()
    const loginResponse = deferred<SampleAuthCommandResult>()
    runner.responses.push(loginResponse.promise, ok({ success: true, sessionsRemoved: 2 }))
    const adapter = new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' })

    const loginResult = adapter.login().catch((error: unknown) => error)
    const logout = adapter.logout()
    expect(runner.calls.map((call) => call.args)).toEqual([['login', '--yes', '--json']])
    expect(runner.calls[0]?.options.signal?.aborted).toBe(true)

    loginResponse.resolve(
      ok({ success: true, user: { name: 'Lucky', account: '012345', sub: 'sample:account:012345' } })
    )

    await expect(loginResult).resolves.toMatchObject({ code: 'SAMPLE_AUTH_CANCELLED' })
    await expect(logout).resolves.toBeUndefined()
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['login', '--yes', '--json'],
      ['logout', '--json']
    ])
  })

  it('uses the official idempotent logout JSON contract', async () => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push(ok({ success: false, reason: 'not_logged_in' }))

    await expect(new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).logout()).resolves.toBeUndefined()
    expect(runner.calls[0]).toEqual({
      executable: 'sample-auth-fixture',
      args: ['logout', '--json'],
      options: { timeoutMs: 30_000 }
    })
  })

  it.each([
    {
      label: 'missing executable',
      result: {
        exitCode: null,
        stdout: '',
        stderr: '',
        spawnErrorCode: 'ENOENT',
        timedOut: false
      },
      code: 'SAMPLE_AUTH_UNAVAILABLE'
    },
    {
      label: 'network failure',
      result: {
        exitCode: 1,
        stdout: JSON.stringify({
          error: true,
          code: 'AUTH_ERROR',
          message: 'request failed: read ECONNRESET'
        }),
        stderr: '',
        timedOut: false
      },
      code: 'SAMPLE_AUTH_NETWORK'
    },
    {
      label: 'network connection timeout',
      result: {
        exitCode: 1,
        stdout: JSON.stringify({
          error: true,
          code: 'AUTH_ERROR',
          message: 'connect ETIMEDOUT'
        }),
        stderr: '',
        timedOut: false
      },
      code: 'SAMPLE_AUTH_NETWORK'
    },
    {
      label: 'browser cancellation',
      result: {
        exitCode: 1,
        stdout: JSON.stringify({
          error: true,
          code: 'AUTH_ERROR',
          message: 'Browser was closed before login completed'
        }),
        stderr: '',
        timedOut: false
      },
      code: 'SAMPLE_AUTH_CANCELLED'
    },
    {
      label: 'wrapper timeout',
      result: {
        exitCode: null,
        stdout: '',
        stderr: '',
        signal: 'SIGTERM' as const,
        timedOut: true
      },
      code: 'SAMPLE_AUTH_TIMEOUT'
    },
    {
      label: 'invalid protocol',
      result: {
        exitCode: 0,
        stdout: 'not-json',
        stderr: '',
        timedOut: false
      },
      code: 'SAMPLE_AUTH_PROTOCOL'
    }
  ])('returns a typed $label error without exposing CLI diagnostics', async ({ result, code }) => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push(result)

    const failure = await new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).login().catch((error: unknown) => error)

    expect(failure).toMatchObject({ code })
    expect((failure as Error).message).not.toContain('ECONNRESET')
    expect((failure as Error).message).not.toContain('Browser was closed')
  })

  it.each([
    { exitCode: 2, reason: 'not_logged_in' },
    { exitCode: 1, reason: 'unexpected_reason' },
    { exitCode: 0, reason: 'not_logged_in' }
  ])(
    'rejects a forged logged-out status (exit $exitCode, reason $reason)',
    async ({ exitCode, reason }) => {
      const runner = new RecordingSampleAuthRunner()
      runner.responses.push({
        exitCode,
        stdout: JSON.stringify({ loggedIn: false, reason }),
        stderr: '',
        timedOut: false
      })

      await expect(new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).status()).rejects.toMatchObject({
        code: 'SAMPLE_AUTH_PROTOCOL'
      })
    }
  )

  it.each([
    {
      label: 'missing identity',
      payload: { loggedIn: true, sessionExpiresAt: 2_000_000_000 }
    },
    {
      label: 'missing expiry',
      payload: { loggedIn: true, user: { name: 'Lucky', account: '012345' } }
    },
    {
      label: 'expired identity',
      payload: { loggedIn: true, user: { name: 'Lucky', account: '012345' }, sessionExpiresAt: 1 }
    }
  ])('fails closed for a logged-in status with $label', async ({ payload }) => {
    const runner = new RecordingSampleAuthRunner()
    runner.responses.push(ok(payload))

    await expect(new SampleAuthCliAdapter(runner, { executable: 'sample-auth-fixture' }).status()).rejects.toMatchObject({
      code: 'SAMPLE_AUTH_PROTOCOL'
    })
  })

  it('keeps arguments literal in the production runner (shell is disabled)', async () => {
    const runner = new ExecFileSampleAuthCommandRunner()
    const literal = '$(printf should-never-execute)'
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', literal],
      { timeoutMs: 5_000 }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([literal])
  })

  it('removes inherited SAMPLE_AUTH_DEMO_TOKEN while preserving SAMPLE_AUTH_FIXTURE_HOME', async () => {
    const runner = new ExecFileSampleAuthCommandRunner({
      environment: {
        PATH: process.env.PATH,
        SAMPLE_AUTH_DEMO_TOKEN: 'password-equivalent-ticket',
        SAMPLE_AUTH_FIXTURE_HOME: '/private/tmp/luckytag-sampleauth-home'
      }
    })
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({ticket:process.env.SAMPLE_AUTH_DEMO_TOKEN??null,home:process.env.SAMPLE_AUTH_FIXTURE_HOME??null}))'
      ],
      { timeoutMs: 5_000 }
    )

    expect(JSON.parse(result.stdout)).toEqual({
      ticket: null,
      home: '/private/tmp/luckytag-sampleauth-home'
    })
    expect(result.stdout).not.toContain('password-equivalent-ticket')
  })

  it('enforces a hard timeout even when a child ignores SIGTERM', async () => {
    const result = await runReadyTimeoutFixture('()=>{}', 150)

    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
  })

  it('keeps timeout classification when a SIGTERM handler exits with code 130', async () => {
    const result = await runReadyTimeoutFixture('()=>process.exit(130)', 100)

    expect(result).toMatchObject({ exitCode: 130, timedOut: true })
  })
})

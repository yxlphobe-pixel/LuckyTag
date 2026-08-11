import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentRuntimeRegistry,
  IsolatedAgentRunner,
  MacKeychainCredentialStore,
  resolveTrustedClaudeInvocation,
  resolveTrustedClaudeCli,
  validateTrustedCodexCli,
  type ClaudeCliTrustPolicy,
  safeAgentExecutionError
} from '../../src/daemon/agent-runtime'
import type { AgentConfiguration, AgentRuntimeKind } from '../../src/shared/contracts'

const roots: string[] = []
const execFileAsync = promisify(execFile)
const realCliProcessTimeoutMs = 15_000
const realCliTestTimeoutMs = realCliProcessTimeoutMs + 5_000
const originalOverrides = {
  codex: process.env['LUCKYTAG_CODEX_PATH'],
  claude: process.env['LUCKYTAG_CLAUDE_PATH'],
  codexHome: process.env['CODEX_HOME'],
  claudeHome: process.env['CLAUDE_CONFIG_DIR'],
  home: process.env['HOME'],
  path: process.env['PATH']
}

afterEach(async () => {
  restoreEnvironment('LUCKYTAG_CODEX_PATH', originalOverrides.codex)
  restoreEnvironment('LUCKYTAG_CLAUDE_PATH', originalOverrides.claude)
  restoreEnvironment('CODEX_HOME', originalOverrides.codexHome)
  restoreEnvironment('CLAUDE_CONFIG_DIR', originalOverrides.claudeHome)
  restoreEnvironment('HOME', originalOverrides.home)
  restoreEnvironment('PATH', originalOverrides.path)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.sequential('IsolatedAgentRunner', () => {
  it.each([
    ['codex', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    ['claude-code', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']
  ] as const)('自定义 %s 仅通过环境变量注入 Key，且使用 0700 隔离目录', async (runtime, keyName, urlName) => {
    const fixture = await createRuntimeFixture(runtime)
    const fakeKey = 'fixture-key-not-a-real-secret'
    const runner = new IsolatedAgentRunner(fixture.dataRoot, { [runtime]: fixture.executable })

    const result = await runner.run({
      sessionId: 'safe-session',
      prompt: 'Reply exactly LUCKYTAG_OK',
      configuration: customConfiguration(runtime),
      apiKey: fakeKey
    })
    const observed = JSON.parse(result.output) as RuntimeObservation

    expect(observed.args).not.toContain(fakeKey)
    expect(observed.args.join(' ')).not.toContain('models.example.test')
    expect(observed.keyName).toBe(keyName)
    expect(observed.keyConfigured).toBe(true)
    expect(observed.urlName).toBe(urlName)
    expect(observed.url).toBe('https://models.example.test/v1')
    expect(observed.homeMatchesCwd).toBe(true)
    expect(observed.directoryMode).toBe('700')
    expect(observed.prompt).toBe('Reply exactly LUCKYTAG_OK')
    expect(observed.args).not.toContain('Reply exactly LUCKYTAG_OK')
    if (runtime === 'claude-code') {
      expectClaudeSafetyArgs(observed.args, true)
      expectClaudeEphemeralEnvironment(observed.environment)
    }
    expect(await readdir(join(fixture.dataRoot, 'workers'))).toEqual([])
  })

  it.each(['codex', 'claude-code'] as const)('%s 默认模式不注入模型、URL 或 Key', async (runtime) => {
    const fixture = await createRuntimeFixture(runtime)
    if (runtime === 'claude-code') process.env['CLAUDE_CONFIG_DIR'] = '/tmp/must-not-be-forwarded'
    const runner = new IsolatedAgentRunner(fixture.dataRoot, { [runtime]: fixture.executable })

    const result = await runner.run({
      sessionId: 'default-session',
      prompt: 'Reply exactly LUCKYTAG_OK',
      configuration: defaultConfiguration(runtime)
    })
    const observed = JSON.parse(result.output) as RuntimeObservation

    expect(observed.args).not.toContain('--model')
    expect(observed.keyConfigured).toBe(false)
    expect(observed.url).toBe('')
    if (runtime === 'claude-code') {
      expectClaudeSafetyArgs(observed.args, false)
      expectClaudeEphemeralEnvironment(observed.environment)
      expect(observed.environment['CLAUDE_CONFIG_DIR']).toBeUndefined()
    }
  })

  it('Codex 本机无认证模式使用非秘密占位值，不要求用户 Key', async () => {
    const fixture = await createRuntimeFixture('codex')
    const runner = new IsolatedAgentRunner(fixture.dataRoot, { codex: fixture.executable })
    const configuration = customConfiguration('codex')
    configuration.model = {
      ...configuration.model,
      provider: 'ollama',
      authentication: 'none',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyConfigured: false
    }

    const result = await runner.run({
      sessionId: 'local-no-auth',
      prompt: 'Reply exactly LUCKYTAG_OK',
      configuration
    })
    const observed = JSON.parse(result.output) as RuntimeObservation

    expect(observed.keyConfigured).toBe(true)
    expect(observed.url).toBe('http://127.0.0.1:11434/v1')
    expect(observed.args.join(' ')).not.toContain('luckytag-local-no-auth')
  })

  it.each(['codex', 'claude-code'] as const)('%s 超时后终止进程组并回收会话目录', async (runtime) => {
    const fixture = await createRuntimeFixture(runtime, true)
    const runner = new IsolatedAgentRunner(fixture.dataRoot, { [runtime]: fixture.executable })

    await expect(runner.run({
      sessionId: 'timeout-session',
      prompt: 'never completes',
      configuration: defaultConfiguration(runtime),
      timeoutMs: 50
    })).rejects.toMatchObject({ code: 'AGENT_TIMEOUT' })
    expect(await readdir(join(fixture.dataRoot, 'workers'))).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 700))
    await expect(access(fixture.markerPath)).rejects.toBeTruthy()
  })

  it('探测 Runtime 有明确可用状态，执行错误可脱敏', async () => {
    const fixture = await createRuntimeFixture('codex')
    const status = await new AgentRuntimeRegistry({ codex: fixture.executable }).probe('codex', true)
    const probeEnvironment = JSON.parse(await readFile(fixture.probeEnvironmentPath, 'utf8')) as Record<string, string>

    expect(status).toMatchObject({ runtime: 'codex', available: true })
    expect(status.version).toContain('fixture-runtime 1.0.0')
    expect(probeEnvironment).toMatchObject({
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    })
    expect(safeAgentExecutionError(Object.assign(new Error('provider leaked fixture-key'), {
      code: 'AGENT_EXECUTION_FAILED'
    })).message).not.toContain('fixture-key')
    expect(safeAgentExecutionError(Object.assign(new Error('/tmp/untrusted/claude'), {
      code: 'AGENT_RUNTIME_UNTRUSTED'
    }))).toMatchObject({
      code: 'AGENT_RUNTIME_UNTRUSTED',
      message: '未找到受信任的 Claude Code 2.1.112'
    })
    expect(fixture.dataRoot).toBeTruthy()
  })

  it('shutdown 会终止全部活动进程组、等待目录回收并拒绝新会话', async () => {
    const fixture = await createRuntimeFixture('codex', true)
    const runner = new IsolatedAgentRunner(fixture.dataRoot, { codex: fixture.executable })
    const operation = runner.run({
      sessionId: 'shutdown-session',
      prompt: 'never completes',
      configuration: defaultConfiguration('codex'),
      timeoutMs: 10_000
    })
    const rejection = expect(operation).rejects.toMatchObject({ code: 'AGENT_RUNNER_SHUTDOWN' })
    await waitForPath(fixture.startedPath)

    await runner.shutdown()
    await rejection
    expect(await readdir(join(fixture.dataRoot, 'workers'))).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 700))
    await expect(access(fixture.markerPath)).rejects.toBeTruthy()
    await expect(runner.run({
      sessionId: 'rejected-after-shutdown',
      prompt: 'must not start',
      configuration: defaultConfiguration('codex')
    })).rejects.toMatchObject({ code: 'AGENT_RUNNER_SHUTDOWN' })
  })

  it('Claude execute/probe 使用固定 Node 搜索路径，忽略 PATH 前置的恶意 node', async () => {
    const fixture = await createRuntimeFixture('claude-code')
    const maliciousRoot = await mkdtemp(join(tmpdir(), 'luckytag-malicious-node-'))
    roots.push(maliciousRoot)
    const markerPath = join(maliciousRoot, 'captured-key')
    const maliciousNode = join(maliciousRoot, 'node')
    await writeFile(maliciousNode, `#!/bin/sh\nprintf "%s" "$ANTHROPIC_API_KEY" > '${markerPath}'\nexit 97\n`, {
      encoding: 'utf8',
      mode: 0o700
    })
    process.env['PATH'] = `${maliciousRoot}:${originalOverrides.path || ''}`

    const runner = new IsolatedAgentRunner(fixture.dataRoot, { 'claude-code': fixture.executable })
    const result = await runner.run({
      sessionId: 'malicious-path',
      prompt: 'Reply exactly LUCKYTAG_OK',
      configuration: customConfiguration('claude-code'),
      apiKey: 'fixture-key-not-a-real-secret'
    })
    const observed = JSON.parse(result.output) as RuntimeObservation
    const status = await new AgentRuntimeRegistry({ 'claude-code': fixture.executable })
      .probe('claude-code', true)
    const probeEnvironment = JSON.parse(await readFile(fixture.probeEnvironmentPath, 'utf8')) as Record<string, string>

    expect(status.available).toBe(true)
    expect(observed.path).toBe(`${dirname(await realpath(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin`)
    expect(probeEnvironment['PATH']).toBe(observed.path)
    await expect(access(markerPath)).rejects.toBeTruthy()
  })
})

describe.sequential('Claude Code runtime trust policy', () => {
  it('只接受 realpath 后满足固定包、版本、owner、权限和哈希的官方 cli.js', async () => {
    const fixture = await createTrustedClaudeFixture()

    expect(resolveTrustedClaudeCli([fixture.binPath], fixture.policy)).toBe(fixture.cliPath)
    expect(resolveTrustedClaudeCli(['/definitely/not/claude', fixture.binPath], fixture.policy))
      .toBe(fixture.cliPath)
  })

  it('可信 Claude invocation 固定使用校验后的绝对 process.execPath 执行 cli.js', async () => {
    const fixture = await createTrustedClaudeFixture()
    const invocation = resolveTrustedClaudeInvocation([fixture.binPath], process.execPath, fixture.policy)

    expect(invocation.command).toBe(await realpath(process.execPath))
    expect(invocation.argumentPrefix).toEqual([fixture.cliPath])
  })

  const packagedNode = join(
    process.cwd(),
    'release',
    'mac-arm64',
    'LuckyTag.app',
    'Contents',
    'Resources',
    'luckytag-daemon',
    'bin',
    'node'
  )
  const installedClaude = join(
    process.env['HOME'] || '/Users/example',
    '.petclaw',
    'node',
    'bin',
    'claude'
  )

  it.runIf(existsSync(packagedNode) && existsSync(installedClaude))(
    '重签名后的 packaged sidecar Node 可直接执行受信任 Claude cli.js',
    async () => {
      const invocation = resolveTrustedClaudeInvocation([installedClaude], packagedNode)
      const { stdout } = await execFileAsync(invocation.command, [
        ...invocation.argumentPrefix,
        '--version'
      ], {
        encoding: 'utf8',
        timeout: realCliProcessTimeoutMs,
        env: {
          PATH: `${dirname(await realpath(packagedNode))}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: process.env['HOME'],
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
        }
      })

      expect(stdout.trim()).toBe('2.1.112 (Claude Code)')
    },
    realCliTestTimeoutMs
  )

  it('cli.js 被篡改后即使路径与 package 元数据不变也会拒绝', async () => {
    const fixture = await createTrustedClaudeFixture()
    await writeFile(fixture.cliPath, `${fixture.source}\n// tampered\n`, { mode: 0o700 })

    expect(() => resolveTrustedClaudeCli([fixture.binPath], fixture.policy))
      .toThrowError(/受信任的/u)
  })

  it('package.json 内容被改写时即使 name/version 未变也会拒绝', async () => {
    const fixture = await createTrustedClaudeFixture()
    await writeFile(join(dirname(fixture.cliPath), 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code',
      version: '2.1.112'
    }, null, 2), { encoding: 'utf8', mode: 0o600 })

    expect(() => resolveTrustedClaudeCli([fixture.binPath], fixture.policy))
      .toThrowError(/受信任的/u)
  })

  it('拒绝错误 package、group-writable 文件、错误 owner policy 与同名任意路径', async () => {
    const wrongPackage = await createTrustedClaudeFixture({ packageName: 'not-anthropic/claude' })
    expect(() => resolveTrustedClaudeCli([wrongPackage.binPath], wrongPackage.policy))
      .toThrowError(/受信任的/u)

    const wrongVersion = await createTrustedClaudeFixture({ version: '2.1.113' })
    expect(() => resolveTrustedClaudeCli([wrongVersion.binPath], wrongVersion.policy))
      .toThrowError(/受信任的/u)

    const writable = await createTrustedClaudeFixture()
    await chmod(writable.cliPath, 0o722)
    expect(() => resolveTrustedClaudeCli([writable.binPath], writable.policy))
      .toThrowError(/受信任的/u)

    const wrongOwner = await createTrustedClaudeFixture()
    expect(() => resolveTrustedClaudeCli([wrongOwner.binPath], {
      ...wrongOwner.policy,
      uid: wrongOwner.policy.uid + 1
    })).toThrowError(/受信任的/u)

    const arbitraryRoot = await mkdtemp(join(tmpdir(), 'luckytag-arbitrary-claude-'))
    roots.push(arbitraryRoot)
    const arbitrary = join(arbitraryRoot, 'claude')
    await writeFile(arbitrary, wrongOwner.source, { mode: 0o700 })
    expect(() => resolveTrustedClaudeCli([arbitrary], wrongOwner.policy))
      .toThrowError(/受信任的/u)
  })
})

describe.sequential('Codex BYOK runtime trust policy', () => {
  it('只接受固定路径、owner、权限和 SHA-256 全部匹配的内置 Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-trusted-codex-'))
    roots.push(root)
    const cliPath = join(root, 'codex')
    const source = '#!/bin/sh\nprintf "codex fixture\\n"\n'
    await writeFile(cliPath, source, { encoding: 'utf8', mode: 0o700 })
    const uid = process.getuid?.()
    if (uid === undefined) throw new Error('fixture requires uid')
    const policy = {
      path: cliPath,
      sha256: createHash('sha256').update(source).digest('hex'),
      uid
    }

    await expect(validateTrustedCodexCli(cliPath, policy)).resolves.toBe(await realpath(cliPath))

    await writeFile(cliPath, `${source}# tampered\n`, { encoding: 'utf8', mode: 0o700 })
    await expect(validateTrustedCodexCli(cliPath, policy)).rejects.toMatchObject({ code: 'AGENT_RUNTIME_UNTRUSTED' })
  })
})

describe.sequential('MacKeychainCredentialStore', () => {
  it('通过 stdin 写入 Key，进程参数不包含明文，并按 Runtime + URL 隔离', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-keychain-fixture-'))
    roots.push(root)
    const executable = join(root, 'security-fixture')
    const statePath = join(root, 'stored-secret')
    const argvPath = join(root, 'observed-argv.json')
    const fakeKey = 'fixture-key-not-a-real-secret'
    const script = `#!${process.execPath}\n` +
      `import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'\n` +
      `const args=process.argv.slice(2), state=${JSON.stringify(statePath)}, observed=${JSON.stringify(argvPath)}\n` +
      `if(args[0]==='add-generic-password'){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{writeFileSync(observed,JSON.stringify(args));writeFileSync(state,input.split(/\\r?\\n/u)[0]||'');process.exit(0)});}\n` +
      `else if(args[0]==='find-generic-password'){if(!existsSync(state))process.exit(44);process.stdout.write(readFileSync(state,'utf8')+'\\n');}\n` +
      `else if(args[0]==='delete-generic-password'){if(!existsSync(state))process.exit(44);unlinkSync(state);}\n`
    await writeFile(executable, script, { encoding: 'utf8', mode: 0o700 })
    await chmod(executable, 0o700)
    const store = new MacKeychainCredentialStore(executable, 'fixture-account')
    const scope = { runtime: 'codex' as const, baseUrl: 'https://models.example.test/v1' }

    await store.set(scope, fakeKey)

    const observedArgs = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
    expect(observedArgs).not.toContain(fakeKey)
    expect(observedArgs.at(-1)).toBe('-w')
    await expect(store.get(scope)).resolves.toBe(fakeKey)
    await store.set({ ...scope, baseUrl: 'https://other.example.test/v1' }, 'second-fixture-key')
    const otherArgs = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
    expect(otherArgs[otherArgs.indexOf('-s') + 1]).not.toBe(observedArgs[observedArgs.indexOf('-s') + 1])
    await store.delete(scope)
    await expect(store.get(scope)).resolves.toBeNull()
  })
})

interface RuntimeObservation {
  args: string[]
  prompt: string
  keyName: string
  keyConfigured: boolean
  urlName: string
  url: string
  homeMatchesCwd: boolean
  directoryMode: string
  environment: Record<string, string>
  path: string
}

const createRuntimeFixture = async (
  runtime: AgentRuntimeKind,
  hangs = false
): Promise<{
  dataRoot: string
  markerPath: string
  startedPath: string
  probeEnvironmentPath: string
  executable: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'luckytag-agent-runtime-'))
  roots.push(root)
  const executable = join(root, runtime === 'codex' ? 'codex-fixture' : 'claude-fixture')
  const markerPath = join(root, 'orphan-marker')
  const startedPath = join(root, 'runtime-started')
  const probeEnvironmentPath = join(root, 'probe-environment.json')
  const keyName = runtime === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  const urlName = runtime === 'codex' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'
  const source = hangs
    ? `#!${process.execPath}\n` +
      `import { writeFileSync } from 'node:fs'\n` +
      `import { spawn } from 'node:child_process'\n` +
      `writeFileSync(${JSON.stringify(startedPath)},'started')\n` +
      `spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'orphan'),400)`)}],{stdio:'ignore'})\n` +
      `setTimeout(() => undefined, 10_000)\n`
    : `#!${process.execPath}\n` +
      `import { realpathSync, statSync, writeFileSync } from 'node:fs'\n` +
      `if (process.argv.includes('--version')) { writeFileSync(${JSON.stringify(probeEnvironmentPath)},JSON.stringify(process.env));process.stdout.write('fixture-runtime 1.0.0\\n');process.exit(0) }\n` +
      `const cwd = process.cwd()\n` +
      `let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),prompt,keyName:${JSON.stringify(keyName)},keyConfigured:Boolean(process.env[${JSON.stringify(keyName)}]),urlName:${JSON.stringify(urlName)},url:process.env[${JSON.stringify(urlName)}]||'',homeMatchesCwd:realpathSync(process.env.HOME)===realpathSync(cwd),directoryMode:(statSync(cwd).mode & 0o777).toString(8),path:process.env.PATH,environment:Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('CLAUDE_')||name.startsWith('DISABLE_')||name==='MCP_CONNECTION_NONBLOCKING'))})))\n`
  await writeFile(executable, source, { encoding: 'utf8', mode: 0o700 })
  await chmod(executable, 0o700)
  return { dataRoot: join(root, 'data'), markerPath, startedPath, probeEnvironmentPath, executable }
}

const expectClaudeSafetyArgs = (args: string[], bare: boolean): void => {
  expect(args).toContain('-p')
  expect(args.includes('--bare')).toBe(bare)
  const toolsIndex = args.indexOf('--tools')
  expect(toolsIndex).toBeGreaterThanOrEqual(0)
  expect(args[toolsIndex + 1]).toBe('')
  expect(args).toContain('--strict-mcp-config')
  const mcpConfigIndex = args.indexOf('--mcp-config')
  expect(mcpConfigIndex).toBeGreaterThanOrEqual(0)
  expect(JSON.parse(args[mcpConfigIndex + 1] ?? '{}')).toEqual({ mcpServers: {} })
  expect(args).toContain('--no-session-persistence')
  expect(args).toContain('--disable-slash-commands')
  expect(args).toContain('--no-chrome')
  expect(args).not.toContain('--safe-mode')
  expect(args).not.toContain('--max-turns')
  const settingSourcesIndex = args.indexOf('--setting-sources')
  if (bare) expect(settingSourcesIndex).toBe(-1)
  else {
    expect(settingSourcesIndex).toBeGreaterThanOrEqual(0)
    expect(args[settingSourcesIndex + 1]).toBe('')
  }
  const settingsIndex = args.indexOf('--settings')
  expect(settingsIndex).toBeGreaterThanOrEqual(0)
  expect(JSON.parse(args[settingsIndex + 1] ?? '{}')).toEqual({ disableAllHooks: true })
}

const expectClaudeEphemeralEnvironment = (environment: Record<string, string>): void => {
  expect(environment).toMatchObject({
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    MCP_CONNECTION_NONBLOCKING: 'true'
  })
}

const createTrustedClaudeFixture = async (
  options: { packageName?: string; version?: string } = {}
): Promise<{
  binPath: string
  cliPath: string
  source: string
  policy: ClaudeCliTrustPolicy
}> => {
  const root = await mkdtemp(join(tmpdir(), 'luckytag-trusted-claude-'))
  roots.push(root)
  const packageDirectory = join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
  const cliPath = join(packageDirectory, 'cli.js')
  const binPath = join(root, 'bin', 'claude')
  const source = `#!${process.execPath}\nprocess.stdout.write('fixture claude 2.1.112\\n')\n`
  const packageSource = JSON.stringify({
    name: options.packageName ?? '@anthropic-ai/claude-code',
    version: options.version ?? '2.1.112'
  })
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 })
  await mkdir(dirname(binPath), { recursive: true, mode: 0o700 })
  await writeFile(cliPath, source, { encoding: 'utf8', mode: 0o700 })
  await writeFile(join(packageDirectory, 'package.json'), packageSource, { encoding: 'utf8', mode: 0o600 })
  await symlink(cliPath, binPath)
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('fixture requires uid')
  return {
    binPath,
    cliPath: await realpath(cliPath),
    source,
    policy: {
      packageName: '@anthropic-ai/claude-code',
      version: '2.1.112',
      sha256: createHash('sha256').update(source).digest('hex'),
      packageSha256: createHash('sha256').update(packageSource).digest('hex'),
      uid
    }
  }
}

const waitForPath = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`等待 fixture 启动超时：${path}`)
}

const customConfiguration = (runtime: AgentRuntimeKind): AgentConfiguration => ({
  enabled: true,
  runtime,
  mode: 'custom-model',
  model: {
    provider: runtime === 'codex' ? 'custom' : 'anthropic',
    protocol: runtime === 'codex' ? 'openai-responses' : 'anthropic-messages',
    authentication: 'api-key',
    name: 'fixture-model',
    baseUrl: 'https://models.example.test/v1',
    apiKeyConfigured: true
  }
})

const defaultConfiguration = (runtime: AgentRuntimeKind): AgentConfiguration => ({
  enabled: true,
  runtime,
  mode: 'runtime-default',
  model: {
    provider: runtime === 'codex' ? 'openai' : 'anthropic',
    protocol: runtime === 'codex' ? 'openai-responses' : 'anthropic-messages',
    authentication: 'api-key',
    name: '',
    baseUrl: '',
    apiKeyConfigured: false
  }
})

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

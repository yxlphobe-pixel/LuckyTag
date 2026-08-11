import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrderedAsyncDispatcher } from '../../src/daemon/protocol'
import {
  computeDaemonBuildIdentity,
  DAEMON_DETACHED_STOP_TIMEOUT_MS,
  daemonRequiresPackagedDaemonRestart,
  ensureInstallToken,
  installLaunchAgentWithPermissionFallback,
  isLaunchdPermissionRestriction,
  launchAgentPlist,
  promoteFallbackDaemon,
  replaceLaunchAgentJob,
  waitForDaemonStop
} from '../../src/main/daemon-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Daemon installation and lifecycle primitives', () => {
  it('生成稳定的 256-bit 安装级 Token 并强制文件权限为 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-token-'))
    roots.push(root)
    const daemonRoot = join(root, 'daemon')
    const tokenPath = join(daemonRoot, 'install-token')
    await mkdir(daemonRoot, { recursive: true, mode: 0o700 })

    const first = await ensureInstallToken(tokenPath)
    await chmod(tokenPath, 0o644)
    const second = await ensureInstallToken(tokenPath)

    expect(first).toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    expect((await readFile(tokenPath, 'utf8')).trim()).toBe(first)
  })

  it('原子替换崩溃遗留的空 Token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-token-empty-'))
    roots.push(root)
    const tokenPath = join(root, 'install-token')
    await writeFile(tokenPath, '', { mode: 0o600 })

    await expect(ensureInstallToken(tokenPath)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })

  it('launchd 直接执行独立 Node sidecar，不依赖 ELECTRON_RUN_AS_NODE', () => {
    const plist = launchAgentPlist({
      label: 'com.luckytag.daemon',
      executablePath: '/Applications/LuckyTag.app/Contents/Resources/luckytag-daemon/bin/node',
      daemonEntry: '/Applications/LuckyTag.app/Contents/Resources/luckytag-daemon/app/daemon.js',
      dataRoot: '/Users/test/Library/Application Support/LuckyTag',
      socketPath: '/Users/test/Library/Application Support/LuckyTag/daemon/luckytag-v1.sock',
      tokenPath: '/Users/test/Library/Application Support/LuckyTag/daemon/install-token',
      stdoutPath: '/Users/test/Library/Application Support/LuckyTag/daemon/stdout.log',
      stderrPath: '/Users/test/Library/Application Support/LuckyTag/daemon/stderr.log',
      homeDirectory: '/Users/test',
      buildIdentity: 'a'.repeat(64)
    })

    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
    expect(plist).toContain('luckytag-daemon/bin/node')
    expect(plist).toContain('luckytag-daemon/app/daemon.js')
    expect(plist).toContain('<key>Umask</key><integer>63</integer>')
    expect(plist).toContain('<key>LUCKYTAG_DAEMON_BUILD_IDENTITY</key>')
    expect(plist).toContain('/Users/test/.petclaw/node/bin')
    expect(plist).not.toContain('ELECTRON_RUN_AS_NODE')
  })

  it('串行发布异步快照，旧状态不会越过新状态', async () => {
    const published: string[] = []
    const dispatcher = new OrderedAsyncDispatcher()
    dispatcher.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      published.push('older')
    })
    dispatcher.enqueue(async () => {
      published.push('newer')
    })

    await dispatcher.drain()
    expect(published).toEqual(['older', 'newer'])
  })

  it('单次异步发布失败不会阻塞后续快照', async () => {
    const published: string[] = []
    const errors: unknown[] = []
    const dispatcher = new OrderedAsyncDispatcher((error) => errors.push(error))
    dispatcher.enqueue(async () => { throw new Error('fixture failure') })
    dispatcher.enqueue(async () => { published.push('recovered') })

    await dispatcher.drain()
    expect(errors).toHaveLength(1)
    expect(published).toEqual(['recovered'])
  })

  it('Daemon bundle 任一文件变化都会更新构建标识', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-build-identity-'))
    roots.push(root)
    const chunks = join(root, 'chunks')
    const daemonEntry = join(root, 'daemon.js')
    await mkdir(chunks)
    await writeFile(daemonEntry, 'import "./chunks/shared.js"\n')
    await writeFile(join(chunks, 'shared.js'), 'export const version = 1\n')

    const first = await computeDaemonBuildIdentity(daemonEntry)
    await writeFile(join(chunks, 'shared.js'), 'export const version = 2\n')
    const second = await computeDaemonBuildIdentity(daemonEntry)

    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(second).not.toBe(first)
  })

  it('等待旧 launchd job 完全消失后才加载新版服务', async () => {
    const calls: string[][] = []
    let now = 0
    let printCount = 0
    const notFound = Object.assign(new Error('Boot-out failed: 3: No such process'), {
      stderr: 'Could not find service in domain for com.luckytag.daemon'
    })

    await replaceLaunchAgentJob({
      domain: 'gui/501',
      serviceTarget: 'gui/501/com.luckytag.daemon',
      plistPath: '/Users/test/Library/LaunchAgents/com.luckytag.daemon.plist',
      run: async (arguments_) => {
        calls.push([...arguments_])
        if (arguments_[0] === 'print' && ++printCount >= 3) throw notFound
      },
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds }
    })

    expect(calls).toEqual([
      ['bootout', 'gui/501/com.luckytag.daemon'],
      ['print', 'gui/501/com.luckytag.daemon'],
      ['print', 'gui/501/com.luckytag.daemon'],
      ['print', 'gui/501/com.luckytag.daemon'],
      ['bootstrap', 'gui/501', '/Users/test/Library/LaunchAgents/com.luckytag.daemon.plist'],
      ['enable', 'gui/501/com.luckytag.daemon'],
      ['kickstart', '-k', 'gui/501/com.luckytag.daemon']
    ])
  })

  it('首次安装只忽略 launchd service-not-found，再继续 bootstrap', async () => {
    const calls: string[][] = []
    const notFound = Object.assign(new Error('Boot-out failed'), {
      stderr: 'Could not find service "com.luckytag.daemon" in domain for user gui: 501'
    })

    await replaceLaunchAgentJob({
      domain: 'gui/501',
      serviceTarget: 'gui/501/com.luckytag.daemon',
      plistPath: '/tmp/com.luckytag.daemon.plist',
      run: async (arguments_) => {
        calls.push([...arguments_])
        if (arguments_[0] === 'bootout') throw notFound
      }
    })

    expect(calls.map(([command]) => command)).toEqual(['bootout', 'bootstrap', 'enable', 'kickstart'])
  })

  it('launchd bootout 权限或超时错误不会被当作“服务不存在”吞掉', async () => {
    const calls: string[][] = []
    const permissionDenied = Object.assign(new Error('Boot-out failed: 1: Operation not permitted'), {
      stderr: 'Operation not permitted',
      code: 1
    })

    await expect(replaceLaunchAgentJob({
      domain: 'gui/501',
      serviceTarget: 'gui/501/com.luckytag.daemon',
      plistPath: '/tmp/com.luckytag.daemon.plist',
      run: async (arguments_) => {
        calls.push([...arguments_])
        throw permissionDenied
      }
    })).rejects.toBe(permissionDenied)
    expect(calls).toEqual([['bootout', 'gui/501/com.luckytag.daemon']])
  })

  it('LaunchAgents 写入受限时降级为 detached sidecar，且不会伪装成 launchd 安装成功', async () => {
    const calls: string[] = []
    const permissionDenied = Object.assign(new Error('无法写入 LaunchAgents'), {
      code: 'EACCES'
    })

    await expect(installLaunchAgentWithPermissionFallback({
      installLaunchAgent: async () => {
        calls.push('launchd')
        throw permissionDenied
      },
      spawnDetached: async () => { calls.push('detached') }
    })).resolves.toBe('detached')

    expect(calls).toEqual(['launchd', 'detached'])
    expect(isLaunchdPermissionRestriction(permissionDenied)).toBe(true)
  })

  it('launchctl 的 operation-not-permitted 会降级为 detached sidecar', async () => {
    const calls: string[] = []
    const launchctlDenied = Object.assign(new Error('Bootstrap failed: 1'), {
      code: 1,
      stderr: 'Bootstrap failed: 1: Operation not permitted'
    })

    await expect(installLaunchAgentWithPermissionFallback({
      installLaunchAgent: async () => {
        calls.push('launchd')
        throw launchctlDenied
      },
      spawnDetached: async () => { calls.push('detached') }
    })).resolves.toBe('detached')

    expect(calls).toEqual(['launchd', 'detached'])
    expect(isLaunchdPermissionRestriction(launchctlDenied)).toBe(true)
  })

  it('普通 launchd 配置、签名或超时错误不会触发降级', async () => {
    const failures = [
      Object.assign(new Error('LuckyTag 安装包缺少独立 Node sidecar'), {
        code: 'DAEMON_SIDECAR_MISSING'
      }),
      Object.assign(new Error('Bootstrap failed: 5: Input/output error'), {
        code: 5,
        stderr: 'Bootstrap failed: 5: Input/output error'
      }),
      Object.assign(new Error('launchctl timed out'), { code: 'ETIMEDOUT' })
    ]

    for (const failure of failures) {
      let spawned = false
      await expect(installLaunchAgentWithPermissionFallback({
        installLaunchAgent: async () => { throw failure },
        spawnDetached: async () => { spawned = true }
      })).rejects.toBe(failure)
      expect(spawned).toBe(false)
      expect(isLaunchdPermissionRestriction(failure)).toBe(false)
    }
  })

  it('受限启动留下的 detached daemon 会在后续启动按顺序重试升级 launchd', async () => {
    const calls: string[] = []
    await expect(promoteFallbackDaemon({
      shutdownDetached: async () => { calls.push('shutdown-detached') },
      waitUntilStopped: async () => { calls.push('wait-stopped') },
      startPreferred: async () => {
        calls.push('retry-launchd')
        return 'launchd'
      }
    })).resolves.toBe('launchd')

    expect(calls).toEqual(['shutdown-detached', 'wait-stopped', 'retry-launchd'])
  })

  it('升级时 launchd 仍受限会重新启动 detached daemon，而不是丢失本机服务', async () => {
    const calls: string[] = []
    await expect(promoteFallbackDaemon({
      shutdownDetached: async () => { calls.push('shutdown-detached') },
      waitUntilStopped: async () => { calls.push('wait-stopped') },
      startPreferred: () => installLaunchAgentWithPermissionFallback({
        installLaunchAgent: async () => {
          calls.push('launchd')
          throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
        },
        spawnDetached: async () => { calls.push('detached') }
      })
    })).resolves.toBe('detached')

    expect(calls).toEqual(['shutdown-detached', 'wait-stopped', 'launchd', 'detached'])
  })

  it('marker 对应的旧 build/protocol daemon 也会先停止再升级，避免旧 socket 阻塞新 sidecar', () => {
    expect(DAEMON_DETACHED_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000)
    expect(daemonRequiresPackagedDaemonRestart(true, Object.assign(new Error('old build'), {
      code: 'DAEMON_BUILD_MISMATCH'
    }))).toBe(true)
    expect(daemonRequiresPackagedDaemonRestart(true, Object.assign(new Error('old protocol'), {
      code: 'DAEMON_PROTOCOL_MISMATCH'
    }))).toBe(true)
    expect(daemonRequiresPackagedDaemonRestart(true, null)).toBe(true)
    expect(daemonRequiresPackagedDaemonRestart(false, null)).toBe(false)
    expect(daemonRequiresPackagedDaemonRestart(true, Object.assign(new Error('unauthorized'), {
      code: 'DAEMON_UNAUTHORIZED'
    }))).toBe(false)
    expect(daemonRequiresPackagedDaemonRestart(true, Object.assign(new Error('socket unavailable'), {
      code: 'ECONNREFUSED'
    }))).toBe(false)
  })

  it('无 marker 的 packaged 旧 build 在 launchd 受限时也会一次切换到 detached sidecar', async () => {
    const oldBuild = Object.assign(new Error('old build'), {
      code: 'DAEMON_BUILD_MISMATCH'
    })
    expect(daemonRequiresPackagedDaemonRestart(false, oldBuild)).toBe(true)

    const calls: string[] = []
    await expect(promoteFallbackDaemon({
      shutdownDetached: async () => { calls.push('shutdown-old-build') },
      waitUntilStopped: async () => { calls.push('wait-socket-gone') },
      startPreferred: () => installLaunchAgentWithPermissionFallback({
        installLaunchAgent: async () => {
          calls.push('launchd')
          throw Object.assign(new Error('LaunchAgents write denied'), { code: 'EACCES' })
        },
        spawnDetached: async () => { calls.push('detached') }
      })
    })).resolves.toBe('detached')

    expect(calls).toEqual([
      'shutdown-old-build',
      'wait-socket-gone',
      'launchd',
      'detached'
    ])
  })

  it('等待 daemon 停止时仅把 socket 消失类错误当作已退出', async () => {
    let now = 0
    const calls: string[] = []
    await expect(waitForDaemonStop({
      probe: async () => {
        calls.push('probe')
        if (calls.length === 1) {
          throw Object.assign(new Error('old build'), { code: 'DAEMON_BUILD_MISMATCH' })
        }
        throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
      },
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds },
      timeoutMs: 1_000
    })).resolves.toBeUndefined()
    expect(calls).toEqual(['probe', 'probe'])

    const unauthorized = Object.assign(new Error('unauthorized'), { code: 'DAEMON_UNAUTHORIZED' })
    await expect(waitForDaemonStop({
      probe: async () => { throw unauthorized }
    })).rejects.toBe(unauthorized)
  })

  it('健康检查持续超时不会被误判为 daemon 已停止', async () => {
    let now = 0
    const timeout = Object.assign(new Error('request timed out'), {
      code: 'DAEMON_REQUEST_TIMEOUT'
    })
    await expect(waitForDaemonStop({
      probe: async () => { throw timeout },
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds },
      timeoutMs: 250
    })).rejects.toMatchObject({ code: 'DAEMON_DETACHED_STOP_TIMEOUT' })
  })
})

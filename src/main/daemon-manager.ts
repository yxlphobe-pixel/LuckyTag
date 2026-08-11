import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { DAEMON_PROTOCOL_VERSION } from '../daemon/protocol'
import { DaemonClient } from './daemon-client'

const execFileAsync = promisify(execFile)

export const LAUNCHCTL_COMMAND_TIMEOUT_MS = 30_000
export const LAUNCHD_REMOVAL_TIMEOUT_MS = 15_000
// The daemon has a 10-second forced-shutdown deadline. Keep enough headroom
// for the final socket unlink rather than racing that deadline exactly.
export const DAEMON_DETACHED_STOP_TIMEOUT_MS = 15_000

export type LaunchctlRunner = (arguments_: readonly string[]) => Promise<void>

interface ReplaceLaunchAgentJobOptions {
  run: LaunchctlRunner
  domain: string
  serviceTarget: string
  plistPath: string
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  removalTimeoutMs?: number
}

interface LaunchAgentFallbackOptions {
  installLaunchAgent: () => Promise<void>
  spawnDetached: () => Promise<void>
}

interface FallbackPromotionOptions {
  shutdownDetached: () => Promise<void>
  waitUntilStopped: () => Promise<void>
  startPreferred: () => Promise<'launchd' | 'detached'>
}

interface WaitForDaemonStopOptions {
  probe: () => Promise<unknown>
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

export interface DaemonManagerOptions {
  dataRoot: string
  homeDirectory: string
  daemonEntry: string
  executablePath: string
  packaged: boolean
}

export class DaemonManager {
  readonly socketPath: string
  readonly tokenPath: string
  private readonly daemonRoot: string
  private readonly launchdFallbackMarkerPath: string
  private client: DaemonClient | undefined

  constructor(private readonly options: DaemonManagerOptions) {
    this.daemonRoot = join(options.dataRoot, 'daemon')
    this.socketPath = join(this.daemonRoot, `luckytag-v${DAEMON_PROTOCOL_VERSION}.sock`)
    this.tokenPath = join(this.daemonRoot, 'install-token')
    this.launchdFallbackMarkerPath = join(this.daemonRoot, 'launchd-fallback')
  }

  async ensureRunning(): Promise<DaemonClient> {
    await mkdir(this.daemonRoot, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.daemonRoot, 0o700)
    const [token, buildIdentity] = await Promise.all([
      ensureInstallToken(this.tokenPath),
      computeDaemonBuildIdentity(this.options.daemonEntry)
    ])
    const client = new DaemonClient(this.socketPath, token, buildIdentity)
    const healthError = await probeHealth(client)
    const packagedDarwin = this.options.packaged && process.platform === 'darwin'
    const fallbackMarked = packagedDarwin
      ? await hasLaunchdFallbackMarker(this.launchdFallbackMarkerPath)
      : false
    if (packagedDarwin && daemonRequiresPackagedDaemonRestart(fallbackMarked, healthError)) {
      await promoteFallbackDaemon({
        shutdownDetached: () => client.shutdown().then(() => undefined),
        waitUntilStopped: () => waitForDaemonStop({ probe: () => client.health() }),
        startPreferred: () => this.startPackagedDaemon(buildIdentity)
      })
      await waitForDaemon(client)
      this.client = client
      return client
    }
    if (!healthError) {
      this.client = client
      return client
    }

    if (this.options.packaged && process.platform === 'darwin') {
      await this.startPackagedDaemon(buildIdentity)
    } else {
      if (isVersionMismatch(healthError)) await stopIncompatibleDevelopmentDaemon(client)
      await this.spawnDetachedDaemon(buildIdentity)
    }
    await waitForDaemon(client)
    this.client = client
    return client
  }

  getClient(): DaemonClient {
    if (!this.client) throw Object.assign(new Error('LuckyTag 本机服务尚未连接'), {
      code: 'DAEMON_NOT_CONNECTED'
    })
    return this.client
  }

  private async spawnDetachedDaemon(buildIdentity: string): Promise<void> {
    const child = spawn(this.options.executablePath, [this.options.daemonEntry], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      env: daemonEnvironment(
        this.options.dataRoot,
        this.socketPath,
        this.tokenPath,
        this.options.homeDirectory,
        buildIdentity
      )
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  }

  private async startPackagedDaemon(buildIdentity: string): Promise<'launchd' | 'detached'> {
    const mode = await installLaunchAgentWithPermissionFallback({
      installLaunchAgent: () => this.installAndStartLaunchAgent(buildIdentity),
      spawnDetached: async () => {
        await writeLaunchdFallbackMarker(this.launchdFallbackMarkerPath)
        try {
          await this.spawnDetachedDaemon(buildIdentity)
        } catch (error) {
          await clearLaunchdFallbackMarker(this.launchdFallbackMarkerPath)
          throw error
        }
      }
    })
    if (mode === 'launchd') await clearLaunchdFallbackMarker(this.launchdFallbackMarkerPath)
    return mode
  }

  private async installAndStartLaunchAgent(buildIdentity: string): Promise<void> {
    const label = 'com.luckytag.daemon'
    const agentsDirectory = join(this.options.homeDirectory, 'Library', 'LaunchAgents')
    const plistPath = join(agentsDirectory, `${label}.plist`)
    await assertPackagedSidecar(this.options.executablePath, this.options.daemonEntry)
    await mkdir(agentsDirectory, { recursive: true, mode: 0o700 })
    const plist = launchAgentPlist({
      label,
      executablePath: this.options.executablePath,
      daemonEntry: this.options.daemonEntry,
      dataRoot: this.options.dataRoot,
      socketPath: this.socketPath,
      tokenPath: this.tokenPath,
      stdoutPath: join(this.daemonRoot, 'daemon.stdout.log'),
      stderrPath: join(this.daemonRoot, 'daemon.stderr.log'),
      homeDirectory: this.options.homeDirectory,
      buildIdentity
    })
    const temporaryPath = `${plistPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, plist, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, plistPath)
    await chmod(plistPath, 0o600)

    const domain = `gui/${process.getuid?.() ?? 0}`
    const serviceTarget = `${domain}/${label}`
    // Re-bootstrap instead of merely kickstarting so an application update
    // cannot leave launchd pointing at an older sidecar or daemon bundle.
    await replaceLaunchAgentJob({
      run: runLaunchctl,
      domain,
      serviceTarget,
      plistPath
    })
  }
}

/**
 * Sandboxed or managed macOS sessions can deny access to the user's
 * LaunchAgents directory or to the gui launchd domain. In that narrow case we
 * keep LuckyTag usable by starting the already-validated sidecar as a detached
 * process. A daemon-root marker records that reduced lifecycle mode, so every
 * later desktop launch retries the preferred launchd installation.
 *
 * All other failures are preserved. In particular, a missing/tampered
 * sidecar, malformed launchd job, timeout, or ordinary launchctl failure must
 * remain a startup error instead of silently weakening lifecycle guarantees.
 */
export const installLaunchAgentWithPermissionFallback = async (
  options: LaunchAgentFallbackOptions
): Promise<'launchd' | 'detached'> => {
  try {
    await options.installLaunchAgent()
    return 'launchd'
  } catch (error) {
    if (!isLaunchdPermissionRestriction(error)) throw error
    await options.spawnDetached()
    return 'detached'
  }
}

export const isLaunchdPermissionRestriction = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) return true
  const details = [
    error.message,
    'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
    'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  ].join('\n')
  return /operation not permitted|permission denied/iu.test(details)
}

/** A marked daemon is intentionally restarted so a later unrestricted login
 * can promote it back to launchd. If launchd remains restricted,
 * startPreferred performs the same detached fallback and keeps the marker. */
export const promoteFallbackDaemon = async (
  options: FallbackPromotionOptions
): Promise<'launchd' | 'detached'> => {
  await options.shutdownDetached()
  await options.waitUntilStopped()
  return options.startPreferred()
}

export const daemonRequiresPackagedDaemonRestart = (
  fallbackMarked: boolean,
  healthError: unknown | null
): boolean => isVersionMismatch(healthError) || (fallbackMarked && !healthError)

/**
 * Replaces a launchd job without racing its graceful shutdown. launchctl may
 * return before the old job has disappeared from the domain, particularly
 * when the daemon is draining an active Agent process or SQLite checkpoint.
 */
export const replaceLaunchAgentJob = async (
  options: ReplaceLaunchAgentJobOptions
): Promise<void> => {
  let previouslyLoaded = true
  try {
    await options.run(['bootout', options.serviceTarget])
  } catch (error) {
    if (!isLaunchAgentNotFound(error)) throw error
    previouslyLoaded = false
  }

  if (previouslyLoaded) await waitForLaunchAgentRemoval(options)
  await options.run(['bootstrap', options.domain, options.plistPath])
  await options.run(['enable', options.serviceTarget])
  await options.run(['kickstart', '-k', options.serviceTarget])
}

const waitForLaunchAgentRemoval = async (
  options: ReplaceLaunchAgentJobOptions
): Promise<void> => {
  const now = options.now ?? Date.now
  const wait = options.wait ?? delay
  const deadline = now() + (options.removalTimeoutMs ?? LAUNCHD_REMOVAL_TIMEOUT_MS)
  while (now() < deadline) {
    try {
      await options.run(['print', options.serviceTarget])
    } catch (error) {
      if (isLaunchAgentNotFound(error)) return
      throw error
    }
    await wait(100)
  }
  throw Object.assign(new Error('旧 LuckyTag launchd 服务未能在截止时间内退出'), {
    code: 'DAEMON_LAUNCHD_STOP_TIMEOUT'
  })
}

const isLaunchAgentNotFound = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const details = [
    error.message,
    'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
    'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  ].join('\n')
  return /could not find service|service not found|not found in domain|no such process/iu.test(details)
}

const runLaunchctl: LaunchctlRunner = async (arguments_) => {
  await execFileAsync('/bin/launchctl', [...arguments_], launchctlOptions())
}

export const ensureInstallToken = async (tokenPath: string): Promise<string> => {
  try {
    const metadata = await lstat(tokenPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw Object.assign(new Error('Daemon 安装令牌路径不是普通文件'), {
        code: 'UNSAFE_DAEMON_TOKEN_PATH'
      })
    }
    const existing = (await readFile(tokenPath, 'utf8')).trim()
    if (/^[A-Za-z0-9_-]{43,}$/u.test(existing)) {
      if (process.platform !== 'win32') await chmod(tokenPath, 0o600)
      return existing
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('base64url')
  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${token}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, tokenPath)
    if (process.platform !== 'win32') await chmod(tokenPath, 0o600)
    return token
  } finally {
    await handle?.close()
    await unlink(temporaryPath).catch(() => undefined)
  }
}

const probeHealth = async (client: DaemonClient): Promise<unknown | null> => {
  try {
    await client.health()
    return null
  } catch (error) {
    return error
  }
}

const isVersionMismatch = (error: unknown): boolean =>
  error instanceof Error && 'code' in error &&
  (String(error.code) === 'DAEMON_PROTOCOL_MISMATCH' || String(error.code) === 'DAEMON_BUILD_MISMATCH')

const stopIncompatibleDevelopmentDaemon = async (client: DaemonClient): Promise<void> => {
  try {
    await client.shutdown()
  } catch {
    throw Object.assign(new Error(
      '检测到不兼容的开发版 Daemon，且无法安全停止。请结束旧 LuckyTag Daemon 后重试'
    ), { code: 'DAEMON_DEVELOPMENT_RESTART_REQUIRED' })
  }
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      await client.health()
    } catch (error) {
      if (!isVersionMismatch(error)) return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Object.assign(new Error('旧 LuckyTag Daemon 未能在截止时间内退出'), {
    code: 'DAEMON_DEVELOPMENT_RESTART_REQUIRED'
  })
}

const waitForDaemon = async (client: DaemonClient): Promise<void> => {
  const deadline = Date.now() + 20_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await client.health()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw Object.assign(new Error(`LuckyTag 本机服务未能启动：${errorMessage(lastError)}`), {
    code: 'DAEMON_START_FAILED'
  })
}

export const waitForDaemonStop = async (options: WaitForDaemonStopOptions): Promise<void> => {
  const now = options.now ?? Date.now
  const wait = options.wait ?? delay
  const deadline = now() + (options.timeoutMs ?? DAEMON_DETACHED_STOP_TIMEOUT_MS)
  while (now() < deadline) {
    try {
      await options.probe()
    } catch (error) {
      if (isDaemonEndpointGone(error)) return
      if (!isDaemonStopProbeRetryable(error)) throw error
    }
    await wait(100)
  }
  throw Object.assign(new Error('detached LuckyTag Daemon 未能在截止时间内退出'), {
    code: 'DAEMON_DETACHED_STOP_TIMEOUT'
  })
}

const isDaemonEndpointGone = (error: unknown): boolean => {
  if (!isNodeError(error)) return false
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(String(error.code))
}

const isDaemonStopProbeRetryable = (error: unknown): boolean => {
  if (!isNodeError(error)) return false
  return [
    'DAEMON_PROTOCOL_MISMATCH',
    'DAEMON_BUILD_MISMATCH',
    'DAEMON_REQUEST_TIMEOUT'
  ].includes(String(error.code))
}

const hasLaunchdFallbackMarker = async (markerPath: string): Promise<boolean> => {
  try {
    const metadata = await lstat(markerPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw Object.assign(new Error('launchd 降级标记路径不是普通文件'), {
        code: 'UNSAFE_DAEMON_FALLBACK_MARKER'
      })
    }
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const writeLaunchdFallbackMarker = async (markerPath: string): Promise<void> => {
  const temporaryPath = `${markerPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporaryPath, `${new Date().toISOString()}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await rename(temporaryPath, markerPath)
    if (process.platform !== 'win32') await chmod(markerPath, 0o600)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

const clearLaunchdFallbackMarker = async (markerPath: string): Promise<void> => {
  await unlink(markerPath).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  })
}

const daemonEnvironment = (
  dataRoot: string,
  socketPath: string,
  tokenPath: string,
  homeDirectory: string,
  buildIdentity: string
): NodeJS.ProcessEnv => ({
  PATH: daemonSearchPath(homeDirectory),
  HOME: homeDirectory,
  ...(process.env['USER'] ? { USER: process.env['USER'] } : {}),
  LANG: process.env['LANG'] || 'en_US.UTF-8',
  LUCKYTAG_DATA_ROOT: dataRoot,
  LUCKYTAG_DAEMON_SOCKET: socketPath,
  LUCKYTAG_DAEMON_TOKEN_PATH: tokenPath,
  LUCKYTAG_DAEMON_BUILD_IDENTITY: buildIdentity
})

interface LaunchAgentPlistOptions {
  label: string
  executablePath: string
  daemonEntry: string
  dataRoot: string
  socketPath: string
  tokenPath: string
  stdoutPath: string
  stderrPath: string
  homeDirectory: string
  buildIdentity: string
}

export const launchAgentPlist = (options: LaunchAgentPlistOptions): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.executablePath)}</string>
    <string>${xml(options.daemonEntry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LUCKYTAG_DATA_ROOT</key><string>${xml(options.dataRoot)}</string>
    <key>LUCKYTAG_DAEMON_SOCKET</key><string>${xml(options.socketPath)}</string>
    <key>LUCKYTAG_DAEMON_TOKEN_PATH</key><string>${xml(options.tokenPath)}</string>
    <key>LUCKYTAG_DAEMON_BUILD_IDENTITY</key><string>${xml(options.buildIdentity)}</string>
    <key>HOME</key><string>${xml(options.homeDirectory)}</string>
    <key>PATH</key><string>${xml(daemonSearchPath(options.homeDirectory))}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(dirname(options.socketPath))}</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(options.stderrPath)}</string>
</dict>
</plist>
`

const assertPackagedSidecar = async (executablePath: string, daemonEntry: string): Promise<void> => {
  if (!isAbsolute(executablePath) || !isAbsolute(daemonEntry)) {
    throw Object.assign(new Error('打包后的 Daemon sidecar 路径无效'), {
      code: 'DAEMON_SIDECAR_INVALID'
    })
  }
  try {
    await Promise.all([
      access(executablePath, constants.R_OK | constants.X_OK),
      access(daemonEntry, constants.R_OK)
    ])
  } catch {
    throw Object.assign(new Error('LuckyTag 安装包缺少独立 Node sidecar 或 Daemon bundle'), {
      code: 'DAEMON_SIDECAR_MISSING'
    })
  }
}

const daemonSearchPath = (homeDirectory: string): string => [
  join(homeDirectory, '.local', 'bin'),
  join(homeDirectory, '.petclaw', 'node', 'bin'),
  join(homeDirectory, '.npm-global', 'bin'),
  join(homeDirectory, '.volta', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
].join(':')

export const computeDaemonBuildIdentity = async (daemonEntry: string): Promise<string> => {
  const root = dirname(daemonEntry)
  const files = await listRegularFiles(root)
  const hash = createHash('sha256')
  for (const filePath of files) {
    hash.update(relative(root, filePath))
    hash.update('\0')
    hash.update(await readFile(filePath))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const listRegularFiles = async (root: string): Promise<string[]> => {
  const collected: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(filePath)
      else if (entry.isFile()) collected.push(filePath)
      else throw Object.assign(new Error('Daemon bundle 不得包含符号链接或特殊文件'), {
        code: 'DAEMON_BUNDLE_INVALID'
      })
    }
  }
  await visit(root)
  return collected.sort()
}

const launchctlOptions = () => ({
  encoding: 'utf8' as const,
  // The daemon itself has a 10 second graceful drain deadline. Give launchctl
  // enough headroom to observe that shutdown and report a real failure.
  timeout: LAUNCHCTL_COMMAND_TIMEOUT_MS,
  maxBuffer: 256 * 1024,
  windowsHide: true,
  env: { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] }
})

const xml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isNodeError = (value: unknown): value is NodeJS.ErrnoException => value instanceof Error && 'code' in value
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds)
  timer.unref?.()
})

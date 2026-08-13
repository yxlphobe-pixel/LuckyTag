const { spawn, execFile } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const { constants } = require('node:fs')
const { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { request } = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { promisify } = require('node:util')
const { FuseState, FuseV1Options, getCurrentFuseWire } = require('@electron/fuses')

const execFileAsync = promisify(execFile)
const PROTOCOL_VERSION = 1

async function main() {
  const projectRoot = resolve(__dirname, '..')
  const appPath = resolve(process.argv[2] || join(projectRoot, 'release', 'mac-arm64', 'LuckyTag.app'))
  const sidecarRoot = join(appPath, 'Contents', 'Resources', 'luckytag-daemon')
  const nodeExecutable = join(sidecarRoot, 'bin', 'node')
  const daemonEntry = join(sidecarRoot, 'app', 'daemon.js')
  const licensePath = join(sidecarRoot, 'LICENSE.node.txt')
  const noticePath = join(sidecarRoot, 'NOTICE.node.txt')
  const infoPlist = join(appPath, 'Contents', 'Info.plist')

  await Promise.all([
    access(nodeExecutable, constants.R_OK | constants.X_OK),
    access(daemonEntry, constants.R_OK),
    access(licensePath, constants.R_OK),
    access(noticePath, constants.R_OK)
  ])
  const [{ stdout: version }] = await Promise.all([
    execFileAsync(nodeExecutable, ['--version'], { encoding: 'utf8', timeout: 5_000 }),
    execFileAsync('/usr/bin/codesign', ['--verify', '--strict', nodeExecutable], { timeout: 10_000 }),
    execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeout: 20_000 })
  ])
  if (!/^v\d+\.\d+\.\d+/u.test(version.trim())) throw new Error('打包的 Node sidecar 无法执行')
  if (!(await readFile(licensePath, 'utf8')).trim()) throw new Error('Node LICENSE 为空')
  await assertHardenedElectronFuses(appPath)
  await assertHardenedTransportSecurity(infoPlist)

  const root = await mkdtemp(join(tmpdir(), 'luckytag-packaged-daemon-'))
  const daemonRoot = join(root, 'daemon')
  const socketPath = join(daemonRoot, `luckytag-v${PROTOCOL_VERSION}.sock`)
  const tokenPath = join(daemonRoot, 'install-token')
  const token = randomBytes(32).toString('base64url')
  const buildIdentity = createHash('sha256').update(await readFile(daemonEntry)).digest('hex')
  await mkdir(daemonRoot, { recursive: true, mode: 0o700 })
  await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(tokenPath, 0o600)

  const child = spawn(nodeExecutable, [daemonEntry], {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: process.env.LANG || 'en_US.UTF-8',
      LUCKYTAG_DATA_ROOT: root,
      LUCKYTAG_DAEMON_SOCKET: socketPath,
      LUCKYTAG_DAEMON_TOKEN_PATH: tokenPath,
      LUCKYTAG_DAEMON_BUILD_IDENTITY: buildIdentity
    }
  })
  let stderr = ''
  let spawnError
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
  child.once('error', (error) => { spawnError = error })
  try {
    if (spawnError) throw spawnError
    const health = await waitForHealth(socketPath, token)
    if (
      health.protocolVersion !== PROTOCOL_VERSION ||
      health.buildIdentity !== buildIdentity ||
      health.transport !== 'unix-socket'
    ) {
      throw new Error('Daemon 健康检查协议不匹配')
    }
    const [tokenMetadata, socketMetadata] = await Promise.all([stat(tokenPath), stat(socketPath)])
    if ((tokenMetadata.mode & 0o777) !== 0o600) throw new Error('安装级 Token 权限不是 0600')
    if ((socketMetadata.mode & 0o777) !== 0o600) throw new Error('Unix Socket 权限不是 0600')
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 12_000))
      ])
    }
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
  process.stdout.write(`Packaged daemon verified (${version.trim()}).\n`)
}

async function assertHardenedTransportSecurity(infoPlist) {
  const readBoolean = async (key) => {
    const { stdout } = await execFileAsync('/usr/bin/plutil', [
      '-extract',
      key,
      'raw',
      '-o',
      '-',
      infoPlist
    ], { encoding: 'utf8', timeout: 5_000 })
    return stdout.trim()
  }
  const [arbitraryLoads, localNetworking] = await Promise.all([
    readBoolean('NSAppTransportSecurity.NSAllowsArbitraryLoads'),
    readBoolean('NSAppTransportSecurity.NSAllowsLocalNetworking')
  ])
  if (arbitraryLoads !== 'false' || localNetworking !== 'false') {
    throw new Error('Info.plist 的 App Transport Security 未收紧')
  }
  try {
    await execFileAsync('/usr/bin/plutil', [
      '-extract',
      'NSAppTransportSecurity.NSExceptionDomains',
      'raw',
      '-o',
      '-',
      infoPlist
    ], { timeout: 5_000 })
    throw new Error('Info.plist 不得包含 ATS 例外域名')
  } catch (error) {
    if (error instanceof Error && error.message === 'Info.plist 不得包含 ATS 例外域名') throw error
  }
}

async function assertHardenedElectronFuses(appPath) {
  const wire = await getCurrentFuseWire(appPath)
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE]
  ])
  for (const [option, expectedState] of expected) {
    if (wire[option] !== expectedState) {
      throw new Error(`Electron fuse ${FuseV1Options[option]} 未达到加固要求`)
    }
  }
}

async function waitForHealth(socketPath, token) {
  const deadline = Date.now() + 20_000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await getHealth(socketPath, token)
    } catch (error) {
      lastError = error
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    }
  }
  throw lastError || new Error('Daemon 启动超时')
}

function getHealth(socketPath, token) {
  return new Promise((resolveHealth, reject) => {
    const req = request({
      socketPath,
      path: '/v1/health',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 1_000
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!payload.ok) throw new Error(payload.error?.message || 'Daemon 健康检查失败')
          resolveHealth(payload.data)
        } catch (error) {
          reject(error)
        }
      })
    })
    req.once('timeout', () => req.destroy(new Error('Daemon 健康检查超时')))
    req.once('error', reject)
    req.end()
  })
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})

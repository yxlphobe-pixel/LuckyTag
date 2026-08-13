const { join } = require('node:path')
const { execFile } = require('node:child_process')
const {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  realpath,
  writeFile
} = require('node:fs/promises')
const { constants } = require('node:fs')
const { promisify } = require('node:util')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

const execFileAsync = promisify(execFile)

module.exports = async function hardenElectronFuses(context) {
  if (context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${productName}.app`)
  const executable = join(
    appPath,
    'Contents',
    'MacOS',
    productName
  )
  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // LuckyTag does not ship a custom browser_v8_context_snapshot.bin. Enabling
    // this fuse without that artifact makes Electron abort during startup.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  })

  await installNodeDaemonSidecar(context, appPath)

  // electron-builder 26 unconditionally enables permissive localhost ATS entries
  // after applying mac.extendInfo. Tighten the final Info.plist here, before signing.
  const infoPlist = join(appPath, 'Contents', 'Info.plist')
  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    '-bool',
    'false',
    infoPlist
  ])
  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'NSAppTransportSecurity.NSAllowsLocalNetworking',
    '-bool',
    'false',
    infoPlist
  ])
  await execFileAsync('/usr/bin/plutil', [
    '-remove',
    'NSAppTransportSecurity.NSExceptionDomains',
    infoPlist
  ])

  // LuckyTag does not request capture or Bluetooth access. Remove Electron's
  // generic usage strings so the bundle does not advertise unused capabilities.
  for (const key of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) {
    await execFileAsync('/usr/bin/plutil', ['-remove', key, infoPlist])
  }
}

async function installNodeDaemonSidecar(context, appPath) {
  const projectDir = context.packager.projectDir
  const sourceMain = join(projectDir, 'out', 'main')
  const sourceDaemon = join(sourceMain, 'daemon.js')
  const nodeExecutable = await realpath(process.env.LUCKYTAG_NODE_SIDECAR_PATH || process.execPath)
  const nodeRoot = join(nodeExecutable, '..', '..')
  const licenseSource = process.env.LUCKYTAG_NODE_LICENSE_PATH || join(nodeRoot, 'LICENSE')

  await Promise.all([
    access(sourceDaemon, constants.R_OK),
    access(nodeExecutable, constants.R_OK | constants.X_OK),
    access(licenseSource, constants.R_OK)
  ])
  const { stdout: nodeVersion } = await execFileAsync(nodeExecutable, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024
  })
  const versionMatch = /^v(\d+)\.(\d+)\.(\d+)/u.exec(nodeVersion.trim())
  if (!versionMatch) {
    throw new Error(`LUCKYTAG_NODE_SIDECAR_PATH 不是有效 Node.js：${nodeExecutable}`)
  }
  const major = Number(versionMatch[1])
  const minor = Number(versionMatch[2])
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`LuckyTag Daemon sidecar 需要 Node.js >= 22.12.0，当前为 ${nodeVersion.trim()}`)
  }

  const sidecarRoot = join(appPath, 'Contents', 'Resources', 'luckytag-daemon')
  const sidecarBin = join(sidecarRoot, 'bin')
  const sidecarApp = join(sidecarRoot, 'app')
  await Promise.all([
    mkdir(sidecarBin, { recursive: true, mode: 0o755 }),
    mkdir(sidecarApp, { recursive: true, mode: 0o755 })
  ])
  await Promise.all([
    copyFile(nodeExecutable, join(sidecarBin, 'node')),
    cp(sourceMain, sidecarApp, { recursive: true, force: true }),
    copyFile(licenseSource, join(sidecarRoot, 'LICENSE.node.txt')),
    writeFile(
      join(sidecarRoot, 'NOTICE.node.txt'),
      `LuckyTag includes Node.js ${nodeVersion.trim()} as its local daemon runtime.\n` +
        'Node.js is distributed under the terms in LICENSE.node.txt.\n' +
        'Source and notices: https://github.com/nodejs/node\n',
      { encoding: 'utf8', mode: 0o644 }
    )
  ])
  await writeFile(
    join(sidecarApp, 'package.json'),
    '{"private":true,"type":"module"}\n',
    { encoding: 'utf8', mode: 0o644 }
  )
  await chmod(join(sidecarBin, 'node'), 0o755)
}

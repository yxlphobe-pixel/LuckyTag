import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import {
  IPC_CHANNELS,
  type AgentConfigurationInput,
  type AgentRuntimeKind,
  type ApiResult,
  type AppConfig,
  type DashboardSnapshot,
  type DimaRequirementCreateInput,
  type DimaRequirementInput
} from '@shared/contracts'
import {
  assertAgentConfigurationInput,
  assertAgentRuntimeKind,
  assertAppConfig,
  assertDimaRequirementCreateInput,
  assertDimaRequirementInput,
  assertDimaRequirementUrl
} from '@shared/validation'
import { DaemonClient } from './daemon-client'
import { DaemonManager } from './daemon-manager'
import {
  isTrustedRendererDocumentUrl,
  PRODUCTION_RENDERER_CSP,
  RENDERER_ENTRY_URL,
  RENDERER_SCHEME,
  resolveRendererAssetPath
} from './renderer-protocol'
import {
  isLiveSendingEnabled,
  LocalKnowledgePathAuthorizer,
  requiresLiveSendingApproval
} from './security-policy'
import { createMainWindowOptions } from './window-options'

let mainWindow: BrowserWindow | null = null
let daemonClient: DaemonClient | null = null
let disposeDaemonSubscription: (() => void) | undefined
let runtimeFolder = ''
const knowledgePathAuthorizer = new LocalKnowledgePathAuthorizer()

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data })

const failure = (error: unknown): ApiResult<never> => {
  const message = error instanceof Error ? error.message : '发生未知错误'
  return {
    ok: false,
    error: {
      code: error instanceof Error && 'code' in error ? String(error.code) : 'LUCKYTAG_ERROR',
      message
    }
  }
}

const requireDaemon = (): DaemonClient => {
  if (!daemonClient) throw new Error('LuckyTag 本机服务尚未连接')
  return daemonClient
}

const isTrustedSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id ||
    event.senderFrame !== event.sender.mainFrame
  ) return false

  try {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    return isTrustedRendererDocumentUrl(
      event.senderFrame.url,
      is.dev && rendererUrl ? rendererUrl : undefined
    )
  } catch {
    return false
  }
}

const trustedHandle = <TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult>
): void => {
  ipcMain.handle(channel, async (event, ...args: TArgs): Promise<ApiResult<TResult>> => {
    if (!isTrustedSender(event)) {
      return failure(Object.assign(new Error('已拒绝不可信页面的请求'), { code: 'UNTRUSTED_IPC_SENDER' }))
    }

    try {
      return ok(await handler(...args))
    } catch (error) {
      return failure(error)
    }
  })
}

const broadcastSnapshot = (snapshot: DashboardSnapshot): void => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.snapshotUpdated, snapshot)
  }
}

const registerIpc = (): void => {
  trustedHandle(IPC_CHANNELS.getSnapshot, async () => requireDaemon().getSnapshot())
  trustedHandle(IPC_CHANNELS.saveConfig, async (value: AppConfig) => {
    const proposed = assertAppConfig(value)
    const client = requireDaemon()
    const current = (await client.getSnapshot()).config
    knowledgePathAuthorizer.assertConfigTransition(current, proposed)
    const approveLiveSending = requiresLiveSendingApproval(current, proposed)
    if (approveLiveSending) {
      const approved = await confirmSensitiveAction({
        title: '确认开启真实自动回复',
        message: '开启后 LuckyTag 将向白名单钉钉群真实发送回复。',
        detail: '请先确认知识库、群聊白名单、置信度和小时限流均已检查。',
        confirmLabel: '开启真实发送'
      })
      if (!approved) throw actionCancelledError()
    }
    const saved = await client.saveConfig(proposed, { approveLiveSending })
    knowledgePathAuthorizer.commitConfig(saved.config)
    return saved
  })
  trustedHandle(IPC_CHANNELS.saveAgentConfiguration, async (value: AgentConfigurationInput) => {
    return requireDaemon().saveAgentConfiguration(assertAgentConfigurationInput(value))
  })
  trustedHandle(IPC_CHANNELS.probeAgentRuntime, async (runtime: AgentRuntimeKind) => {
    return requireDaemon().probeAgentRuntime(assertAgentRuntimeKind(runtime))
  })
  trustedHandle(IPC_CHANNELS.testAgentConfiguration, async () => {
    return requireDaemon().testAgentConfiguration()
  })
  trustedHandle(IPC_CHANNELS.chooseLocalFolder, async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择本地知识库文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const selectedPath = result.canceled ? null : (result.filePaths[0] ?? null)
    if (selectedPath) knowledgePathAuthorizer.authorizeSelectedPath(selectedPath)
    return selectedPath
  })
  trustedHandle(IPC_CHANNELS.syncKnowledge, async () => requireDaemon().syncKnowledge())
  trustedHandle(IPC_CHANNELS.probeConnections, async () => requireDaemon().probeConnections())
  trustedHandle(
    IPC_CHANNELS.authenticate,
    async (kind: 'dingtalk' | 'yuque' | 'openauth') => {
      if (kind !== 'dingtalk' && kind !== 'yuque' && kind !== 'openauth') {
        throw Object.assign(new Error('不支持的认证连接器'), {
          code: 'UNSUPPORTED_AUTH_CONNECTOR'
        })
      }
      return requireDaemon().authenticate(kind)
    }
  )
  trustedHandle(IPC_CHANNELS.disconnectOpenAuth, async () => {
    const approved = await confirmSensitiveAction({
      title: '确认退出统一身份',
      message: '退出后 OpenAuth 身份连接将断开。',
      detail: '需要使用统一身份能力时，必须重新完成登录授权。',
      confirmLabel: '确认退出'
    })
    if (!approved) throw actionCancelledError()
    return requireDaemon().disconnectOpenAuth({ approved: true })
  })
  trustedHandle(IPC_CHANNELS.startWorker, async () => {
    const approveLiveSending = await approveCurrentLiveSendingAction(
      '确认启动真实自动回复',
      '服务启动后会持续轮询白名单群，并在命中策略时真实发送回复。'
    )
    return requireDaemon().startWorker({ approveLiveSending })
  })
  trustedHandle(IPC_CHANNELS.stopWorker, async () => requireDaemon().stopWorker())
  trustedHandle(IPC_CHANNELS.runOnce, async () => {
    const approveLiveSending = await approveCurrentLiveSendingAction(
      '确认运行一次真实回复',
      '本轮会读取白名单群消息，并在命中策略时真实发送回复。'
    )
    return requireDaemon().runOnce({ approveLiveSending })
  })
  trustedHandle(IPC_CHANNELS.previewDimaRequirement, async (value: DimaRequirementInput) => {
    return requireDaemon().previewDimaRequirement(assertDimaRequirementInput(value))
  })
  trustedHandle(IPC_CHANNELS.createDimaRequirement, async (value: DimaRequirementCreateInput) => {
    return requireDaemon().createDimaRequirement(assertDimaRequirementCreateInput(value))
  })
  trustedHandle(IPC_CHANNELS.openDimaRequirement, async (value: string) => {
    await shell.openExternal(assertDimaRequirementUrl(value), { activate: true })
    return null
  })
  trustedHandle(IPC_CHANNELS.revealRuntimeFolder, async () => {
    const openError = await shell.openPath(runtimeFolder)
    if (openError) throw new Error(`无法打开运行目录：${openError}`)
    return null
  })
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow(
    createMainWindowOptions(join(__dirname, '../preload/index.cjs'))
  )

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadURL(RENDERER_ENTRY_URL)
  }
}

protocol.registerSchemesAsPrivileged([{
  scheme: RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    supportFetchAPI: false,
    corsEnabled: false,
    stream: true,
    codeCache: true
  }
}])

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow()
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })

  void app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.luckytag.desktop')
    app.setName('LuckyTag')
    app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    if (!is.dev) registerRendererProtocol()

    const dataRoot = app.getPath('userData')
    runtimeFolder = join(dataRoot, 'runtime')
    const daemonResources = join(process.resourcesPath, 'luckytag-daemon')
    const daemonEntry = app.isPackaged
      ? join(daemonResources, 'app', 'daemon.js')
      : join(__dirname, 'daemon.js')
    const daemonExecutable = app.isPackaged
      ? join(daemonResources, 'bin', 'node')
      : developmentNodeExecutable()
    const manager = new DaemonManager({
      dataRoot,
      homeDirectory: app.getPath('home'),
      daemonEntry,
      executablePath: daemonExecutable,
      packaged: app.isPackaged
    })
    daemonClient = await manager.ensureRunning()
    disposeDaemonSubscription = daemonClient.subscribe(broadcastSnapshot)
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(
      'LuckyTag 启动失败',
      `${message.slice(0, 2_000)}\n\n请检查本地 Daemon 日志，或联系维护者处理。`
    )
    app.exit(1)
  })
}

app.on('before-quit', () => {
  disposeDaemonSubscription?.()
  disposeDaemonSubscription = undefined
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

const developmentNodeExecutable = (): string =>
  process.env['LUCKYTAG_NODE_EXECUTABLE']?.trim() ||
  process.env['npm_node_execpath']?.trim() ||
  'node'

const registerRendererProtocol = (): void => {
  const rendererRoot = join(__dirname, '../renderer')
  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return secureRendererResponse('Method Not Allowed', 405, 'text/plain; charset=utf-8')
    }
    try {
      const assetPath = resolveRendererAssetPath(rendererRoot, request.url)
      const body = await readFile(assetPath)
      return secureRendererResponse(
        request.method === 'HEAD' ? null : body,
        200,
        rendererContentType(assetPath)
      )
    } catch {
      return secureRendererResponse('Not Found', 404, 'text/plain; charset=utf-8')
    }
  })
}

const secureRendererResponse = (
  body: ConstructorParameters<typeof Response>[0],
  status: number,
  contentType: string
): Response => new Response(body, {
  status,
  headers: {
    'Content-Type': contentType,
    'Content-Security-Policy': PRODUCTION_RENDERER_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer'
  }
})

const rendererContentType = (assetPath: string): string => ({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
})[extname(assetPath).toLowerCase()] ?? 'application/octet-stream'

const confirmSensitiveAction = async (options: {
  title: string
  message: string
  detail: string
  confirmLabel: string
}): Promise<boolean> => {
  const dialogOptions: Electron.MessageBoxOptions = {
    type: 'warning',
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: ['取消', options.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)
  return result.response === 1
}

const actionCancelledError = (): Error => Object.assign(
  new Error('操作已取消'),
  { code: 'ACTION_CANCELLED' }
)

const approveCurrentLiveSendingAction = async (
  title: string,
  detail: string
): Promise<boolean> => {
  const current = (await requireDaemon().getSnapshot()).config
  if (!isLiveSendingEnabled(current)) return false
  const approved = await confirmSensitiveAction({
    title,
    message: '当前策略已允许真实发送。',
    detail,
    confirmLabel: '确认继续'
  })
  if (!approved) throw actionCancelledError()
  return true
}

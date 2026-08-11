import { lstatSync } from 'node:fs'
import { CliExecutionError, type JsonCliRunner, type RunJsonOptions } from './cli-runner'
import type { YuqueAuthStatus, YuqueClient, YuqueDocument } from './types'
import { findArray, findBoolean, findString, isRecord, unwrapEnvelope } from './value-utils'

export class YuqueAdapter implements YuqueClient {
  private selectedExecutable: string

  constructor(
    private readonly runner: JsonCliRunner,
    executable = 'yuque',
    private readonly fallbackExecutable = executable === 'yuque' ? 'yuque-cli' : undefined,
    private readonly wait: (delayMs: number) => Promise<void> = waitFor,
    private readonly now: () => number = Date.now,
    private readonly environment: Readonly<Record<string, string>> = buildYuqueCliEnvironment()
  ) {
    this.selectedExecutable = executable
  }

  async probe(): Promise<YuqueAuthStatus> {
    const response = await this.run(['whoami'], undefined, { CLI_SDK_DISABLE_BROWSER: '1' })
    return normalizeAuthStatus(response, '语雀 CLI 已连接')
  }

  async authenticate(): Promise<YuqueAuthStatus> {
    // Plain whoami reuses a valid session and starts browser authorization when no
    // token exists. --force is destructive: the CLI clears access/refresh tokens
    // before contacting the authorization service, so a transient network failure
    // can otherwise turn a recoverable session into a forced logout.
    const response = await this.runWithTransientAuthorizationRetry(
      ['whoami'],
      this.now() + AUTHENTICATION_TIMEOUT_MS
    )
    return normalizeAuthStatus(response, '语雀认证完成')
  }

  async resolve(input: string): Promise<string> {
    if (!input.trim()) throw new Error('语雀地址不能为空')
    const response = await this.run(['resolve', input])
    const payload = unwrapEnvelope(response, 'Yuque resolve')
    const route = extractRoute(payload)
    if (!route) throw new Error('语雀 resolve 未返回可用文档路径')
    return route
  }

  async listDocuments(namespace: string): Promise<Array<{ route: string; title?: string }>> {
    if (!namespace.trim()) throw new Error('语雀知识库 namespace 不能为空')
    const documents: Array<{ route: string; title?: string }> = []
    const seenRoutes = new Set<string>()
    let offset = 0
    let previousPageSignature: string | undefined

    while (offset < MAX_LIST_DOCUMENTS) {
      const limit = Math.min(LIST_DOCUMENTS_PAGE_SIZE, MAX_LIST_DOCUMENTS - offset)
      const response = await this.run([
        'list',
        'docs',
        namespace,
        '--offset',
        String(offset),
        '--limit',
        String(limit)
      ])
      const payload = unwrapEnvelope(response, 'Yuque list docs')
      const items = findArray(payload)
      if (items.length === 0) break

      const page = items.flatMap((item) => {
        const route = extractRoute(item, namespace)
        if (!route) return []
        const title = findString(item, ['title', 'name'])
        return [{ route, ...(title ? { title } : {}) }]
      })
      const pageSignature = page.map((document) => document.route).join('\0')
      if (!pageSignature || pageSignature === previousPageSignature) break
      previousPageSignature = pageSignature

      let added = 0
      for (const document of page) {
        if (seenRoutes.has(document.route)) continue
        seenRoutes.add(document.route)
        documents.push(document)
        added += 1
        if (documents.length >= MAX_LIST_DOCUMENTS) break
      }

      if (documents.length >= MAX_LIST_DOCUMENTS || added === 0 || items.length < limit) break
      offset += items.length
    }

    return documents
  }

  async showDocument(route: string): Promise<YuqueDocument> {
    if (!route.trim()) throw new Error('语雀文档路径不能为空')
    const response = await this.run(['show', 'doc', route])
    const payload = unwrapEnvelope(response, 'Yuque show doc')
    const body = extractBody(payload)
    if (!body.trim()) throw new Error(`语雀文档正文为空：${route}`)
    const resolvedRoute = extractRoute(payload) ?? route
    const title = findString(payload, ['title', 'name']) ?? resolvedRoute.split('/').at(-1) ?? route
    const updatedAt = findString(payload, ['updatedAt', 'updated_at', 'modifiedAt'])
    return {
      route: resolvedRoute,
      title,
      body,
      ...(updatedAt ? { updatedAt } : {})
    }
  }

  private async run(
    args: readonly string[],
    timeoutMs?: number,
    environmentOverride: Readonly<Record<string, string>> = {}
  ): Promise<unknown> {
    const options: RunJsonOptions = {
      environment: {
        ...this.environment,
        YUQUE_DISABLE_UPDATE_CHECK: '1',
        ...environmentOverride
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    }
    try {
      return await this.runner.runJson(this.selectedExecutable, [...args, '--json'], options)
    } catch (error) {
      if (
        this.fallbackExecutable &&
        this.selectedExecutable !== this.fallbackExecutable &&
        error instanceof CliExecutionError &&
        error.exitCode === 'ENOENT'
      ) {
        this.selectedExecutable = this.fallbackExecutable
        try {
          return await this.runner.runJson(this.selectedExecutable, [...args, '--json'], options)
        } catch (fallbackError) {
          throw normalizeYuqueCliError(fallbackError)
        }
      }
      throw normalizeYuqueCliError(error)
    }
  }

  private async runWithTransientAuthorizationRetry(
    args: readonly string[],
    deadline: number
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const remainingMs = Math.max(1, deadline - this.now())
      try {
        return await this.run(args, remainingMs)
      } catch (error) {
        const retryDelay = AUTHORIZATION_RETRY_DELAYS_MS[attempt]
        if (
          retryDelay === undefined ||
          !isInitialAuthorizationNetworkFailure(error) ||
          deadline - this.now() <= retryDelay
        ) {
          throw error
        }
        await this.wait(retryDelay)
      }
    }
  }
}

const normalizeYuqueCliError = (error: unknown): unknown => {
  if (!(error instanceof Error)) return error
  const message = error.message
  if (error instanceof CliExecutionError && error.exitCode === 'ETIMEDOUT') {
    return Object.assign(
      new Error(
        '语雀请求超时。请确认已连接蚂蚁内网或 VPN；若正在授权，请在浏览器打开后 2 分钟内完成，再返回 LuckyTag 重试',
        { cause: error }
      ),
      { code: 'YUQUE_AUTH_TIMEOUT' }
    )
  }
  if (/Authorization(?:\s+request\s+failed\s*:?)?\s*timeout\b/iu.test(message)) {
    return Object.assign(
      new Error('语雀授权超时。请在浏览器打开后 2 分钟内完成授权，再返回 LuckyTag 重试', {
        cause: error
      }),
      { code: 'YUQUE_AUTH_TIMEOUT' }
    )
  }

  const networkCode = message.match(
    /\b(ECONNRESET|ECONNABORTED|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/iu
  )?.[1]?.toUpperCase()
  if (
    networkCode ||
    /socket hang up|network error|fetch failed|\bCERT_[A-Z_]+\b|UNABLE_TO_VERIFY|certificate/iu.test(
      message
    )
  ) {
    return Object.assign(
      new Error(
        `语雀授权服务连接失败${networkCode ? `（${networkCode}）` : ''}。请确认已连接蚂蚁内网或 VPN 后重试`,
        { cause: error }
      ),
      { code: 'YUQUE_AUTH_NETWORK' }
    )
  }

  return error
}

const isInitialAuthorizationNetworkFailure = (error: unknown): boolean => {
  const diagnostic = errorDiagnostic(error)
  return /Authorization request failed:[^\r\n]*(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed)/iu.test(
    diagnostic
  )
}

export const buildYuqueCliEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isRegularFile: (path: string) => boolean = isRegularCertificateFile
): Readonly<Record<string, string>> => {
  if (
    platform !== 'darwin' ||
    environment.NODE_EXTRA_CA_CERTS !== undefined ||
    !isRegularFile(MACOS_ENTERPRISE_CA_CERTIFICATE)
  ) {
    return {}
  }

  // Finder/LaunchServices omits shell exports on managed Macs. Append the installed
  // StarPoint CA only for Yuque's Node process; do not change TLS verification or
  // the trust environment of DWS/OpenAuth.
  return { NODE_EXTRA_CA_CERTS: MACOS_ENTERPRISE_CA_CERTIFICATE }
}

const isRegularCertificateFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

const errorDiagnostic = (error: unknown, depth = 0): string => {
  if (depth > 3 || !(error instanceof Error)) return ''
  const cliOutput =
    error instanceof CliExecutionError ? `${error.stdout}\n${error.stderr}` : ''
  const cause = 'cause' in error ? error.cause : undefined
  return `${error.message}\n${cliOutput}\n${errorDiagnostic(cause, depth + 1)}`
}

const waitFor = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })

const normalizeAuthStatus = (response: unknown, defaultDetail: string): YuqueAuthStatus => {
  const payload = unwrapEnvelope(response, 'Yuque whoami')
  const explicit = findBoolean(payload, ['authenticated', 'loggedIn', 'connected', 'valid'])
  const identity = findString(payload, ['login', 'name', 'userName', 'id'])
  const state = findString(payload, ['status', 'state'])?.toLowerCase()
  const authenticated =
    explicit ??
    Boolean(identity || (state && ['connected', 'authenticated', 'logged_in', 'ok'].includes(state)))
  const detail = identity
    ? `已登录：${identity}`
    : authenticated
      ? defaultDetail
      : '语雀尚未认证'
  const version = findString(payload, ['version', 'cliVersion'])
  return { authenticated, detail, ...(version ? { version } : {}) }
}

const extractRoute = (value: unknown, namespace?: string): string | undefined => {
  const direct = findString(value, ['route', 'fullPath', 'full_path', 'path'])
  if (direct) {
    const normalized = direct.replace(/^\/+|\/+$/gu, '')
    if (normalized.split('/').length >= 3) return normalized
    if (namespace && normalized && !normalized.includes('/')) return `${namespace}/${normalized}`
  }
  if (!isRecord(value)) return undefined
  const slug = findString(value, ['slug'])
  const bookNamespace = findString(value, ['namespace']) ?? namespace
  if (slug && bookNamespace) return `${bookNamespace.replace(/\/+$/u, '')}/${slug}`
  return undefined
}

const extractBody = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  for (const key of ['body', 'bodyMarkdown', 'body_markdown', 'markdown', 'content', 'text']) {
    const candidate = value[key]
    if (typeof candidate === 'string') return candidate
    if (isRecord(candidate)) {
      const nested = extractBody(candidate)
      if (nested) return nested
    }
  }
  return ''
}

const LIST_DOCUMENTS_PAGE_SIZE = 100
const MAX_LIST_DOCUMENTS = 2_000
const AUTHENTICATION_TIMEOUT_MS = 180_000
const AUTHORIZATION_RETRY_DELAYS_MS = [400, 1_200] as const
const MACOS_ENTERPRISE_CA_CERTIFICATE =
  '/Library/Application Support/starpoint/CertManager/certificate.crt'

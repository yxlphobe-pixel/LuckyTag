import { relative, resolve, sep } from 'node:path'

export const RENDERER_SCHEME = 'app'
export const RENDERER_HOST = 'luckytag'
export const RENDERER_ENTRY_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`

export const PRODUCTION_RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'"
].join('; ')

export const resolveRendererAssetPath = (rendererRoot: string, requestUrl: string): string => {
  // URL normalisation removes percent-encoded dot segments before pathname can
  // be inspected. Reject encodings that can change path structure (including a
  // second decoding pass) on the original request string first.
  if (/%(?:00|25|2e|2f|5c)/iu.test(requestUrl)) {
    throw rendererProtocolError('RENDERER_PATH_ENCODING_REJECTED', 'Renderer 资源路径编码已被拒绝')
  }
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    throw rendererProtocolError('RENDERER_URL_INVALID', 'Renderer 资源 URL 不合法')
  }
  if (
    url.protocol !== `${RENDERER_SCHEME}:` ||
    url.hostname !== RENDERER_HOST ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw rendererProtocolError('RENDERER_ORIGIN_REJECTED', 'Renderer 资源来源不受信任')
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    throw rendererProtocolError('RENDERER_PATH_INVALID', 'Renderer 资源路径编码不合法')
  }
  if (
    !decodedPath.startsWith('/') ||
    decodedPath.includes('//') ||
    decodedPath.includes('%') ||
    /[\u0000-\u001F\u007F-\u009F\\]/u.test(decodedPath) ||
    decodedPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw rendererProtocolError('RENDERER_PATH_REJECTED', 'Renderer 资源路径已被拒绝')
  }

  const asset = decodedPath === '/' ? 'index.html' : decodedPath.slice(1)
  const canonicalRoot = resolve(rendererRoot)
  const candidate = resolve(canonicalRoot, asset)
  const relationship = relative(canonicalRoot, candidate)
  if (!relationship || relationship === 'index.html') return candidate
  if (relationship === '..' || relationship.startsWith(`..${sep}`) || relationship.startsWith(sep)) {
    throw rendererProtocolError('RENDERER_PATH_ESCAPE', 'Renderer 资源路径越过应用边界')
  }
  return candidate
}

export const isTrustedRendererDocumentUrl = (
  value: string,
  developmentOrigin?: string
): boolean => {
  try {
    const url = new URL(value)
    if (developmentOrigin) return url.origin === new URL(developmentOrigin).origin
    return (
      url.protocol === `${RENDERER_SCHEME}:` &&
      url.hostname === RENDERER_HOST &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/index.html'
    )
  } catch {
    return false
  }
}

const rendererProtocolError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

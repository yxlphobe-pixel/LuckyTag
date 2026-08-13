export type UnknownRecord = Record<string, unknown>

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const unwrapEnvelope = (value: unknown, source: string): unknown => {
  if (!isRecord(value)) return value
  if (value.success === false || value.ok === false) {
    const detail = findString(value, ['message', 'msg', 'errorMessage', 'detail', 'error'])
    throw Object.assign(new Error(`${source} 返回失败${detail ? `：${detail}` : ''}`), {
      code: 'CLI_RESPONSE_FAILED'
    })
  }
  for (const key of ['body', 'data', 'result']) {
    const candidate = value[key]
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return value
}

export const findArray = (value: unknown, depth = 0): unknown[] => {
  if (Array.isArray(value)) return value
  if (!isRecord(value) || depth > 4) return []
  for (const key of ['items', 'messages', 'docs', 'documents', 'records', 'results', 'list', 'data', 'body']) {
    if (!(key in value)) continue
    const found = findArray(value[key], depth + 1)
    if (found.length > 0 || Array.isArray(value[key])) return found
  }
  return []
}

export const findString = (
  value: unknown,
  keys: readonly string[],
  depth = 0
): string | undefined => {
  if (!isRecord(value) || depth > 3) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  for (const nestedKey of ['user', 'sender', 'senderInfo', 'creator', 'owner', 'doc', 'book', 'repo']) {
    const found = findString(value[nestedKey], keys, depth + 1)
    if (found) return found
  }
  return undefined
}

export const findBoolean = (value: unknown, keys: readonly string[]): boolean | undefined => {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'boolean') return candidate
    if (candidate === 1 || candidate === '1' || candidate === 'true') return true
    if (candidate === 0 || candidate === '0' || candidate === 'false') return false
  }
  return undefined
}

export const toIsoDate = (value: unknown, fallback: Date): string => {
  let date: Date | undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value)
  } else if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    date = Number.isFinite(numeric)
      ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(value)
  }
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString()
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

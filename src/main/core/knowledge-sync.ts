import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { KnowledgeSource, SyncSummary } from '../../shared/contracts'
import type { JsonStore } from './json-store'
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSnapshotFile,
  YuqueClient
} from './types'
import { errorMessage, isRecord } from './value-utils'

const SUPPORTED_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.html', '.htm'])
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'out'])
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILES_PER_SOURCE = 2_000

export class KnowledgeSynchronizer {
  private syncQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: JsonStore<KnowledgeSnapshotFile>,
    private readonly yuque: YuqueClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  sync(sources: readonly KnowledgeSource[]): Promise<SyncSummary> {
    const snapshot = structuredClone(sources)
    const result = this.syncQueue.then(
      () => this.performSync(snapshot),
      () => this.performSync(snapshot)
    )
    this.syncQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async performSync(sources: readonly KnowledgeSource[]): Promise<SyncSummary> {
    const startedAt = this.now().toISOString()
    const previous = await this.store.read()
    const enabledSources = sources.filter((source) => source.enabled)
    const nextDocuments: KnowledgeDocument[] = []
    const sourceErrors: Array<{ sourceId: string; message: string }> = []

    for (const source of enabledSources) {
      try {
        const documents = await this.readSource(source)
        nextDocuments.push(...documents)
      } catch (error) {
        sourceErrors.push({ sourceId: source.id, message: errorMessage(error) })
        // A temporary CLI or filesystem failure must not erase the last good copy.
        nextDocuments.push(...previous.documents.filter((document) => document.sourceId === source.id))
      }
    }

    const uniqueDocuments = deduplicateDocuments(nextDocuments)
    const chunks = uniqueDocuments.flatMap((document) => chunkDocument(document))
    const finishedAt = this.now().toISOString()
    const nextSnapshot: KnowledgeSnapshotFile = {
      version: 1,
      generatedAt: finishedAt,
      documents: uniqueDocuments,
      chunks,
      sourceErrors
    }
    await this.store.write(nextSnapshot)

    return {
      startedAt,
      finishedAt,
      documentCount: uniqueDocuments.length,
      chunkCount: chunks.length,
      changedDocuments: countChangedDocuments(previous.documents, uniqueDocuments),
      sourceErrors
    }
  }

  private async readSource(source: KnowledgeSource): Promise<KnowledgeDocument[]> {
    switch (source.type) {
      case 'local-directory':
        return readLocalDirectory(source)
      case 'yuque-doc': {
        const route = /^https?:\/\//iu.test(source.routeOrUrl)
          ? await this.yuque.resolve(source.routeOrUrl)
          : source.routeOrUrl
        const document = await this.yuque.showDocument(route)
        return [toKnowledgeDocument(source, document.route, document.title, document.body, document.updatedAt)]
      }
      case 'yuque-book': {
        const entries = await this.yuque.listDocuments(source.namespace)
        const documents: KnowledgeDocument[] = []
        for (const entry of entries.slice(0, MAX_FILES_PER_SOURCE)) {
          const document = await this.yuque.showDocument(entry.route)
          documents.push(
            toKnowledgeDocument(
              source,
              document.route,
              document.title || entry.title || document.route,
              document.body,
              document.updatedAt
            )
          )
        }
        return documents
      }
    }
  }
}

const readLocalDirectory = async (
  source: Extract<KnowledgeSource, { type: 'local-directory' }>
): Promise<KnowledgeDocument[]> => {
  const root = resolve(source.path)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`本地知识源不是普通目录：${source.path}`)
  }

  const paths: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) break
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) pending.push(fullPath)
        continue
      }
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      paths.push(fullPath)
      if (paths.length > MAX_FILES_PER_SOURCE) {
        throw new Error(`本地知识源文件超过上限 ${MAX_FILES_PER_SOURCE}`)
      }
    }
  }

  paths.sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const documents: KnowledgeDocument[] = []
  for (const filePath of paths) {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    if (stat.size > MAX_FILE_BYTES) throw new Error(`知识文件超过 5MB：${filePath}`)
    const raw = await readFile(filePath, 'utf8')
    const extension = extname(filePath).toLowerCase()
    const body = extension === '.html' || extension === '.htm' ? htmlToText(raw) : normalizeText(raw)
    if (!body) continue
    const relativePath = filePath.slice(root.length + 1)
    const title = extractTitle(raw, extension) ?? basename(filePath, extension)
    documents.push(
      toKnowledgeDocument(
        source,
        relativePath,
        title,
        body,
        new Date(stat.mtimeMs).toISOString()
      )
    )
  }
  return documents
}

const toKnowledgeDocument = (
  source: KnowledgeSource,
  origin: string,
  title: string,
  body: string,
  updatedAt?: string
): KnowledgeDocument => {
  const normalizedBody = normalizeText(body)
  const id = stableHash(`${source.id}\0${origin}`)
  return {
    id,
    sourceId: source.id,
    sourceLabel: source.label,
    title: normalizeInline(title) || origin,
    origin,
    body: normalizedBody,
    hash: stableHash(`${title}\0${normalizedBody}`),
    ...(updatedAt ? { updatedAt } : {})
  }
}

export const chunkDocument = (document: KnowledgeDocument): KnowledgeChunk[] => {
  const body = normalizeText(document.body)
  if (!body) return []
  const chunks: KnowledgeChunk[] = []
  const maxLength = 900
  const overlap = 120
  let cursor = 0
  let position = 0

  while (cursor < body.length) {
    let end = Math.min(body.length, cursor + maxLength)
    if (end < body.length) {
      const candidate = findBoundary(body, cursor + Math.floor(maxLength * 0.6), end)
      if (candidate > cursor) end = candidate
    }
    const text = body.slice(cursor, end).trim()
    if (text) {
      chunks.push({
        id: stableHash(`${document.id}\0${position}\0${text}`),
        documentId: document.id,
        sourceId: document.sourceId,
        sourceLabel: document.sourceLabel,
        title: document.title,
        text,
        position
      })
      position += 1
    }
    if (end >= body.length) break
    const nextCursor = Math.max(cursor + 1, end - overlap)
    cursor = nextCursor
  }
  return chunks
}

const findBoundary = (text: string, minimum: number, maximum: number): number => {
  for (let index = maximum; index >= minimum; index -= 1) {
    if ('\n。！？.!?；;'.includes(text[index - 1] ?? '')) return index
  }
  return maximum
}

const extractTitle = (raw: string, extension: string): string | undefined => {
  if (extension === '.html' || extension === '.htm') {
    const match = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
    if (match?.[1]) return htmlToText(match[1])
  }
  const heading = raw.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/mu)
  return heading?.[1] ? normalizeInline(heading[1]) : undefined
}

const htmlToText = (html: string): string =>
  normalizeText(
    html
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/giu, '\n')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/&nbsp;/giu, ' ')
      .replace(/&amp;/giu, '&')
      .replace(/&lt;/giu, '<')
      .replace(/&gt;/giu, '>')
      .replace(/&quot;/giu, '"')
      .replace(/&#39;/giu, "'")
  )

const normalizeText = (value: string): string =>
  value
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

const normalizeInline = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const stableHash = (value: string): string => createHash('sha256').update(value).digest('hex')

const deduplicateDocuments = (documents: readonly KnowledgeDocument[]): KnowledgeDocument[] => {
  const byId = new Map<string, KnowledgeDocument>()
  for (const document of documents) byId.set(document.id, document)
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

const countChangedDocuments = (
  previous: readonly KnowledgeDocument[],
  next: readonly KnowledgeDocument[]
): number => {
  const previousHashes = new Map(previous.map((document) => [document.id, document.hash]))
  const nextHashes = new Map(next.map((document) => [document.id, document.hash]))
  const ids = new Set([...previousHashes.keys(), ...nextHashes.keys()])
  let changed = 0
  for (const id of ids) if (previousHashes.get(id) !== nextHashes.get(id)) changed += 1
  return changed
}

export const isKnowledgeSnapshotFile = (value: unknown): value is KnowledgeSnapshotFile => {
  if (!isRecord(value) || value.version !== 1) return false
  if (value.generatedAt !== undefined && typeof value.generatedAt !== 'string') return false
  if (!Array.isArray(value.documents) || !Array.isArray(value.chunks) || !Array.isArray(value.sourceErrors)) {
    return false
  }
  return (
    value.documents.every(isKnowledgeDocument) &&
    value.chunks.every(isKnowledgeChunk) &&
    value.sourceErrors.every(
      (error) => isRecord(error) && typeof error.sourceId === 'string' && typeof error.message === 'string'
    )
  )
}

const isKnowledgeDocument = (value: unknown): value is KnowledgeDocument =>
  isRecord(value) &&
  ['id', 'sourceId', 'sourceLabel', 'title', 'origin', 'body', 'hash'].every(
    (key) => typeof value[key] === 'string'
  ) &&
  (value.updatedAt === undefined || typeof value.updatedAt === 'string')

const isKnowledgeChunk = (value: unknown): value is KnowledgeChunk =>
  isRecord(value) &&
  ['id', 'documentId', 'sourceId', 'sourceLabel', 'title', 'text'].every(
    (key) => typeof value[key] === 'string'
  ) &&
  Number.isInteger(value.position)

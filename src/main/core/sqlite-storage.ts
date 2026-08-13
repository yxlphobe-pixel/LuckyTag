import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JsonStore } from './json-store'
import { isPersistedReplyRecord } from './state'
import type { CoreStateFile, PersistedReplyRecord } from './types'

const DATABASE_SCHEMA_VERSION = 1
const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const DOCUMENT_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u

interface JsonDocumentRow {
  value_json: string
  value_version: number
  revision: number
}

interface OutboxRow {
  payload_json: string
}

interface EventRow {
  id: number
  stream: string
  event_type: string
  payload_json: string
  created_at: string
}

export interface SqliteDatabaseOptions {
  filePath: string
  now?: () => Date
}

export interface SqliteJsonStoreOptions<T> {
  database: SqliteDatabase
  documentKey: string
  valueVersion?: number
  createDefault: () => T
  validate: (value: unknown) => value is T
  migrate?: (value: unknown) => T
  legacyFilePath?: string
}

export interface SqliteCoreStateStoreOptions {
  database: SqliteDatabase
  createDefault: () => CoreStateFile
  validate: (value: unknown) => value is CoreStateFile
  migrate?: (value: unknown) => CoreStateFile
  legacyFilePath?: string
}

export interface EventLogEntry {
  id: number
  stream: string
  eventType: string
  payload: unknown
  createdAt: string
}

export interface AppendEventInput {
  stream: string
  eventType: string
  payload?: unknown
}

export interface ListEventsOptions {
  stream?: string
  limit?: number
}

export interface ListOutboxOptions {
  statuses?: readonly PersistedReplyRecord['status'][]
  limit?: number
}

export interface OutboxAcknowledgement {
  id: string
  status: 'sent' | 'ignored' | 'needs_manual' | 'recalled' | 'dry_run' | 'failed'
  updatedAt: string
  reason?: string
  platformTaskId?: string
}

/**
 * Owns one local SQLite connection shared by all typed stores in the daemon.
 * Operations are serialized so an async JsonStore mutator cannot interleave with
 * another transaction on the same connection.
 */
export class SqliteDatabase {
  readonly filePath: string
  readonly events: SqliteEventLog
  readonly outbox: SqliteOutbox
  private readonly connection: DatabaseSync
  private readonly now: () => Date
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: SqliteDatabaseOptions) {
    if (!options.filePath.trim()) throw new Error('SQLite 数据库路径不能为空')
    this.filePath = options.filePath
    this.now = options.now ?? (() => new Date())
    if (this.filePath !== ':memory:') {
      const directory = dirname(this.filePath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') chmodSync(directory, 0o700)
    }

    const connection = new DatabaseSync(this.filePath, {
      enableForeignKeyConstraints: true,
      allowExtension: false
    })
    this.connection = connection
    try {
      configureConnection(connection)
      migrateSchema(connection, this.now)
      if (this.filePath !== ':memory:' && process.platform !== 'win32') {
        chmodSync(this.filePath, 0o600)
      }
    } catch (error) {
      connection.close()
      throw error
    }
    this.events = new SqliteEventLog(this)
    this.outbox = new SqliteOutbox(this)
  }

  withConnection<TResult>(operation: (database: DatabaseSync) => TResult | Promise<TResult>): Promise<TResult> {
    return this.exclusive(async () => {
      this.assertOpen()
      return operation(this.connection)
    })
  }

  transaction<TResult>(operation: (database: DatabaseSync) => TResult | Promise<TResult>): Promise<TResult> {
    return this.exclusive(async () => {
      this.assertOpen()
      this.connection.exec('BEGIN IMMEDIATE')
      try {
        const result = await operation(this.connection)
        this.connection.exec('COMMIT')
        return result
      } catch (error) {
        try {
          this.connection.exec('ROLLBACK')
        } catch {
          // Preserve the original operation error if SQLite already rolled back.
        }
        throw error
      }
    })
  }

  close(): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return
      this.connection.close()
      this.closed = true
    })
  }

  timestamp(): string {
    return this.now().toISOString()
  }

  private async exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this.queue
    let release: (() => void) | undefined
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private assertOpen(): void {
    if (this.closed) throw codedError('SQLITE_DATABASE_CLOSED', 'SQLite 数据库已经关闭')
  }
}

/** Versioned JSON document store for configuration and atomic knowledge snapshots. */
export class SqliteJsonStore<T> implements JsonStore<T> {
  private readonly database: SqliteDatabase
  private readonly documentKey: string
  private readonly valueVersion: number
  private readonly createDefault: () => T
  private readonly validate: (value: unknown) => value is T
  private readonly migrate: ((value: unknown) => T) | undefined
  private readonly legacyFilePath: string | undefined

  constructor(options: SqliteJsonStoreOptions<T>) {
    assertDocumentKey(options.documentKey)
    this.database = options.database
    this.documentKey = options.documentKey
    this.valueVersion = options.valueVersion ?? 1
    this.createDefault = options.createDefault
    this.validate = options.validate
    this.migrate = options.migrate
    this.legacyFilePath = options.legacyFilePath
  }

  read(): Promise<T> {
    return this.database.transaction(async (database) => {
      const value = this.readOrInitializeUnlocked(database)
      return structuredClone(value)
    })
  }

  write(value: T): Promise<T> {
    const next = structuredClone(value)
    this.assertValid(next)
    return this.database.transaction(async (database) => {
      const revision = writeDocumentUnlocked(
        database,
        this.documentKey,
        this.valueVersion,
        next,
        this.database.timestamp()
      )
      appendEventUnlocked(database, {
        stream: `store.${this.documentKey}`,
        eventType: 'store.written',
        payload: { revision, valueVersion: this.valueVersion },
        createdAt: this.database.timestamp()
      })
      return structuredClone(next)
    })
  }

  update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.database.transaction(async (database) => {
      const current = this.readOrInitializeUnlocked(database)
      const next = structuredClone(await mutator(structuredClone(current)))
      this.assertValid(next)
      const revision = writeDocumentUnlocked(
        database,
        this.documentKey,
        this.valueVersion,
        next,
        this.database.timestamp()
      )
      appendEventUnlocked(database, {
        stream: `store.${this.documentKey}`,
        eventType: 'store.updated',
        payload: { revision, valueVersion: this.valueVersion },
        createdAt: this.database.timestamp()
      })
      return structuredClone(next)
    })
  }

  private readOrInitializeUnlocked(database: DatabaseSync): T {
    const row = readDocumentRow(database, this.documentKey)
    if (!row) return this.initializeUnlocked(database)

    let parsed = parseStoredJson(row.value_json, `SQLite 文档 ${this.documentKey}`)
    if (!this.validate(parsed) && this.migrate) {
      parsed = structuredClone(this.migrate(parsed))
      this.assertValid(parsed)
      const revision = writeDocumentUnlocked(
        database,
        this.documentKey,
        this.valueVersion,
        parsed,
        this.database.timestamp()
      )
      appendEventUnlocked(database, {
        stream: `store.${this.documentKey}`,
        eventType: 'store.value_migrated',
        payload: { fromValueVersion: row.value_version, toValueVersion: this.valueVersion, revision },
        createdAt: this.database.timestamp()
      })
    }
    this.assertValid(parsed)
    return structuredClone(parsed)
  }

  private initializeUnlocked(database: DatabaseSync): T {
    const legacy = this.readLegacy()
    const value = structuredClone(legacy?.value ?? this.createDefault())
    this.assertValid(value)
    const revision = writeDocumentUnlocked(
      database,
      this.documentKey,
      this.valueVersion,
      value,
      this.database.timestamp()
    )
    if (legacy && this.legacyFilePath) {
      recordLegacyImportUnlocked(
        database,
        this.documentKey,
        this.legacyFilePath,
        legacy.hash,
        this.database.timestamp()
      )
    }
    appendEventUnlocked(database, {
      stream: `store.${this.documentKey}`,
      eventType: legacy ? 'store.legacy_json_imported' : 'store.initialized',
      payload: {
        revision,
        valueVersion: this.valueVersion,
        ...(legacy ? { legacySha256: legacy.hash } : {})
      },
      createdAt: this.database.timestamp()
    })
    return value
  }

  private readLegacy(): { value: T; hash: string } | undefined {
    if (!this.legacyFilePath || !existsSync(this.legacyFilePath)) return undefined
    const raw = readFileSync(this.legacyFilePath, 'utf8')
    let parsed = parseStoredJson(raw, `旧版 JSON ${this.legacyFilePath}`)
    if (!this.validate(parsed) && this.migrate) parsed = structuredClone(this.migrate(parsed))
    this.assertValid(parsed, 'INVALID_LEGACY_JSON_STORE')
    return {
      value: structuredClone(parsed),
      hash: createHash('sha256').update(raw).digest('hex')
    }
  }

  private assertValid(value: unknown, code = 'INVALID_SQLITE_STORE'): asserts value is T {
    if (!this.validate(value)) {
      throw codedError(code, `SQLite 文档结构不合法：${this.documentKey}`)
    }
  }
}

/**
 * Core state adapter. Runtime/group metadata lives in the state document while
 * reply delivery records live in the outbox table. Both are changed in one
 * SQLite transaction and reconstructed behind the JsonStore boundary.
 */
export class SqliteCoreStateStore implements JsonStore<CoreStateFile> {
  private readonly database: SqliteDatabase
  private readonly createDefault: () => CoreStateFile
  private readonly validate: (value: unknown) => value is CoreStateFile
  private readonly migrate: ((value: unknown) => CoreStateFile) | undefined
  private readonly legacyFilePath: string | undefined

  constructor(options: SqliteCoreStateStoreOptions) {
    this.database = options.database
    this.createDefault = options.createDefault
    this.validate = options.validate
    this.migrate = options.migrate
    this.legacyFilePath = options.legacyFilePath
  }

  read(): Promise<CoreStateFile> {
    return this.database.transaction(async (database) =>
      structuredClone(this.readOrInitializeUnlocked(database))
    )
  }

  write(value: CoreStateFile): Promise<CoreStateFile> {
    const next = structuredClone(value)
    this.assertValid(next)
    return this.database.transaction(async (database) => {
      const previous = this.readOrInitializeUnlocked(database)
      this.writeUnlocked(database, previous, next, 'store.written')
      return structuredClone(next)
    })
  }

  update(
    mutator: (current: CoreStateFile) => CoreStateFile | Promise<CoreStateFile>
  ): Promise<CoreStateFile> {
    return this.database.transaction(async (database) => {
      const current = this.readOrInitializeUnlocked(database)
      const next = structuredClone(await mutator(structuredClone(current)))
      this.assertValid(next)
      this.writeUnlocked(database, current, next, 'store.updated')
      return structuredClone(next)
    })
  }

  private readOrInitializeUnlocked(database: DatabaseSync): CoreStateFile {
    const row = readDocumentRow(database, 'state')
    if (!row) return this.initializeUnlocked(database)
    let base = parseStoredJson(row.value_json, 'SQLite 文档 state')
    const outbox = readOutboxUnlocked(database)
    let combined = combineState(base, outbox)
    if (!this.validate(combined) && this.migrate) combined = structuredClone(this.migrate(combined))
    this.assertValid(combined)

    // An early database build may have kept replies in the JSON document. Move
    // them to the dedicated outbox without losing or duplicating records.
    if (stateDocumentContainsReplies(base)) {
      const documentReplies = base.replies.filter(isPersistedReplyRecord)
      const mergedReplies = mergeReplyRecords(documentReplies, outbox)
      syncOutboxUnlocked(database, outbox, mergedReplies)
      combined = { ...combined, replies: mergedReplies }
      writeDocumentUnlocked(database, 'state', 1, stateMetadata(combined), this.database.timestamp())
      appendEventUnlocked(database, {
        stream: 'store.state',
        eventType: 'store.outbox_migrated',
        payload: {
          replyCount: combined.replies.length,
          documentReplyCount: documentReplies.length,
          existingOutboxCount: outbox.length
        },
        createdAt: this.database.timestamp()
      })
    }
    return combined
  }

  private initializeUnlocked(database: DatabaseSync): CoreStateFile {
    const legacy = this.readLegacy()
    const value = structuredClone(legacy?.value ?? this.createDefault())
    this.assertValid(value)
    writeDocumentUnlocked(database, 'state', 1, stateMetadata(value), this.database.timestamp())
    syncOutboxUnlocked(database, [], value.replies)
    if (legacy && this.legacyFilePath) {
      recordLegacyImportUnlocked(
        database,
        'state',
        this.legacyFilePath,
        legacy.hash,
        this.database.timestamp()
      )
    }
    appendEventUnlocked(database, {
      stream: 'store.state',
      eventType: legacy ? 'store.legacy_json_imported' : 'store.initialized',
      payload: { replyCount: value.replies.length, ...(legacy ? { legacySha256: legacy.hash } : {}) },
      createdAt: this.database.timestamp()
    })
    return value
  }

  private writeUnlocked(
    database: DatabaseSync,
    previous: CoreStateFile,
    next: CoreStateFile,
    eventType: string
  ): void {
    const revision = writeDocumentUnlocked(
      database,
      'state',
      1,
      stateMetadata(next),
      this.database.timestamp()
    )
    const changes = syncOutboxUnlocked(database, previous.replies, next.replies)
    appendEventUnlocked(database, {
      stream: 'store.state',
      eventType,
      payload: { revision, ...changes },
      createdAt: this.database.timestamp()
    })
  }

  private readLegacy(): { value: CoreStateFile; hash: string } | undefined {
    if (!this.legacyFilePath || !existsSync(this.legacyFilePath)) return undefined
    const raw = readFileSync(this.legacyFilePath, 'utf8')
    let parsed = parseStoredJson(raw, `旧版 JSON ${this.legacyFilePath}`)
    if (!this.validate(parsed) && this.migrate) parsed = structuredClone(this.migrate(parsed))
    this.assertValid(parsed, 'INVALID_LEGACY_JSON_STORE')
    return {
      value: structuredClone(parsed),
      hash: createHash('sha256').update(raw).digest('hex')
    }
  }

  private assertValid(
    value: unknown,
    code = 'INVALID_SQLITE_STORE'
  ): asserts value is CoreStateFile {
    if (!this.validate(value)) throw codedError(code, 'SQLite 核心状态结构不合法')
  }
}

/** Append-only audit boundary. SQLite triggers reject UPDATE and DELETE. */
export class SqliteEventLog {
  constructor(private readonly database: SqliteDatabase) {}

  append(input: AppendEventInput): Promise<EventLogEntry> {
    assertEventLabel(input.stream, '事件流')
    assertEventLabel(input.eventType, '事件类型')
    return this.database.transaction(async (database) => {
      const createdAt = this.database.timestamp()
      const id = appendEventUnlocked(database, {
        ...input,
        createdAt
      })
      return {
        id,
        stream: input.stream,
        eventType: input.eventType,
        payload: structuredClone(input.payload ?? {}),
        createdAt
      }
    })
  }

  list(options: ListEventsOptions = {}): Promise<EventLogEntry[]> {
    const limit = boundedLimit(options.limit, 100, 1_000)
    if (options.stream) assertEventLabel(options.stream, '事件流')
    return this.database.withConnection(async (database) => {
      const rows = (options.stream
        ? database.prepare(`
            SELECT id, stream, event_type, payload_json, created_at
            FROM event_log WHERE stream = ? ORDER BY id DESC LIMIT ?
          `).all(options.stream, limit)
        : database.prepare(`
            SELECT id, stream, event_type, payload_json, created_at
            FROM event_log ORDER BY id DESC LIMIT ?
          `).all(limit)) as unknown as EventRow[]
      return rows.map(toEventLogEntry)
    })
  }
}

/** Query/update boundary for durable reply delivery records. */
export class SqliteOutbox {
  constructor(private readonly database: SqliteDatabase) {}

  get(id: string): Promise<PersistedReplyRecord | undefined> {
    return this.database.withConnection(async (database) => {
      const row = database.prepare('SELECT payload_json FROM outbox WHERE id = ?').get(id) as
        | unknown as OutboxRow
        | undefined
      return row ? parseOutboxRecord(row.payload_json) : undefined
    })
  }

  list(options: ListOutboxOptions = {}): Promise<PersistedReplyRecord[]> {
    const limit = boundedLimit(options.limit, 100, 5_000)
    const statuses = [...new Set(options.statuses ?? [])]
    return this.database.withConnection(async (database) => {
      let rows: OutboxRow[]
      if (statuses.length > 0) {
        const placeholders = statuses.map(() => '?').join(', ')
        rows = database.prepare(`
          SELECT payload_json FROM outbox
          WHERE status IN (${placeholders})
          ORDER BY updated_at DESC, position ASC LIMIT ?
        `).all(...statuses, limit) as unknown as OutboxRow[]
      } else {
        rows = database.prepare(`
          SELECT payload_json FROM outbox
          ORDER BY updated_at DESC, position ASC LIMIT ?
        `).all(limit) as unknown as OutboxRow[]
      }
      return rows.map((row) => parseOutboxRecord(row.payload_json))
    })
  }

  upsert(record: PersistedReplyRecord): Promise<void> {
    if (!isPersistedReplyRecord(record)) throw codedError('INVALID_OUTBOX_RECORD', 'Outbox 记录结构不合法')
    return this.database.transaction(async (database) => {
      const existing = database.prepare('SELECT position FROM outbox WHERE id = ?').get(record.id) as
        | unknown as { position: number }
        | undefined
      const nextPosition = existing?.position ?? nextOutboxPosition(database)
      upsertOutboxUnlocked(database, record, nextPosition)
      appendEventUnlocked(database, {
        stream: 'outbox',
        eventType: 'outbox.upserted',
        payload: { recordId: record.id, status: record.status },
        createdAt: this.database.timestamp()
      })
    })
  }

  /** Marks a claimed delivery terminal while retaining it for local audit. */
  acknowledge(input: OutboxAcknowledgement): Promise<PersistedReplyRecord | undefined> {
    if (!input.id.trim() || !input.updatedAt.trim()) {
      throw codedError('INVALID_OUTBOX_ACK', 'Outbox 确认参数不合法')
    }
    return this.database.transaction(async (database) => {
      const row = database.prepare(`
        SELECT payload_json, position FROM outbox WHERE id = ?
      `).get(input.id) as unknown as (OutboxRow & { position: number }) | undefined
      if (!row) return undefined
      const current = parseOutboxRecord(row.payload_json)
      if (current.status !== 'pending' && current.status !== 'sending') {
        if (current.status === input.status) return current
        throw codedError(
          'OUTBOX_ALREADY_ACKNOWLEDGED',
          `Outbox ${input.id} 已处于终态 ${current.status}`
        )
      }
      const { leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
      const next: PersistedReplyRecord = {
        ...withoutLease,
        status: input.status,
        updatedAt: input.updatedAt,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.platformTaskId === undefined ? {} : { platformTaskId: input.platformTaskId })
      }
      if (!isPersistedReplyRecord(next)) {
        throw codedError('INVALID_OUTBOX_ACK', 'Outbox 确认结果结构不合法')
      }
      upsertOutboxUnlocked(database, next, Number(row.position))
      appendEventUnlocked(database, {
        stream: 'outbox',
        eventType: 'outbox.acknowledged',
        payload: { recordId: next.id, status: next.status },
        createdAt: this.database.timestamp()
      })
      return structuredClone(next)
    })
  }

  remove(id: string): Promise<boolean> {
    return this.database.transaction(async (database) => {
      const result = database.prepare('DELETE FROM outbox WHERE id = ?').run(id)
      if (Number(result.changes) > 0) {
        appendEventUnlocked(database, {
          stream: 'outbox',
          eventType: 'outbox.removed',
          payload: { recordId: id },
          createdAt: this.database.timestamp()
        })
        return true
      }
      return false
    })
  }
}

const configureConnection = (database: DatabaseSync): void => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA temp_store = MEMORY;
  `)
}

const migrateSchema = (database: DatabaseSync, now: () => Date): void => {
  const versionRow = database.prepare('PRAGMA user_version').get() as unknown as {
    user_version: number
  }
  let version = Number(versionRow.user_version)
  if (!Number.isInteger(version) || version < 0) {
    throw codedError('INVALID_SQLITE_SCHEMA_VERSION', 'SQLite schema version 不合法')
  }
  if (version > DATABASE_SCHEMA_VERSION) {
    throw codedError(
      'SQLITE_SCHEMA_TOO_NEW',
      `SQLite schema ${version} 高于当前支持版本 ${DATABASE_SCHEMA_VERSION}`
    )
  }

  if (version < 1) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE json_documents (
          document_key TEXT PRIMARY KEY,
          value_version INTEGER NOT NULL CHECK(value_version > 0),
          revision INTEGER NOT NULL CHECK(revision > 0),
          value_json TEXT NOT NULL CHECK(json_valid(value_json)),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE event_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stream TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX event_log_stream_id_idx ON event_log(stream, id DESC);

        CREATE TRIGGER event_log_reject_update
        BEFORE UPDATE ON event_log
        BEGIN
          SELECT RAISE(ABORT, 'event_log is append-only');
        END;

        CREATE TRIGGER event_log_reject_delete
        BEFORE DELETE ON event_log
        BEGIN
          SELECT RAISE(ABORT, 'event_log is append-only');
        END;

        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'sending', 'sent', 'ignored', 'needs_manual', 'recalled', 'dry_run', 'failed'
          )),
          attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
          idempotency_uuid TEXT NOT NULL,
          lease_expires_at TEXT,
          position INTEGER NOT NULL CHECK(position >= 0),
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(group_id, message_id)
        ) STRICT;

        CREATE INDEX outbox_status_updated_idx ON outbox(status, updated_at DESC);
        CREATE INDEX outbox_lease_idx ON outbox(status, lease_expires_at);

        CREATE TABLE legacy_imports (
          store_key TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          imported_at TEXT NOT NULL
        ) STRICT;
      `)
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(1, now().toISOString())
      database.exec('PRAGMA user_version = 1')
      database.exec('COMMIT')
      version = 1
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the migration error.
      }
      throw error
    }
  }

  if (version !== DATABASE_SCHEMA_VERSION) {
    throw codedError('SQLITE_SCHEMA_MIGRATION_INCOMPLETE', 'SQLite schema migration 未完成')
  }
}

const readDocumentRow = (database: DatabaseSync, key: string): JsonDocumentRow | undefined =>
  database.prepare(`
    SELECT value_json, value_version, revision
    FROM json_documents WHERE document_key = ?
  `).get(key) as unknown as JsonDocumentRow | undefined

const writeDocumentUnlocked = (
  database: DatabaseSync,
  key: string,
  valueVersion: number,
  value: unknown,
  updatedAt: string
): number => {
  const row = database.prepare(`
    INSERT INTO json_documents(document_key, value_version, revision, value_json, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(document_key) DO UPDATE SET
      value_version = excluded.value_version,
      revision = json_documents.revision + 1,
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
    RETURNING revision
  `).get(key, valueVersion, stringifyJson(value), updatedAt) as unknown as { revision: number }
  return Number(row.revision)
}

const appendEventUnlocked = (
  database: DatabaseSync,
  input: AppendEventInput & { createdAt: string }
): number => {
  const result = database.prepare(`
    INSERT INTO event_log(stream, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(input.stream, input.eventType, stringifyJson(input.payload ?? {}), input.createdAt)
  return Number(result.lastInsertRowid)
}

const recordLegacyImportUnlocked = (
  database: DatabaseSync,
  storeKey: string,
  sourcePath: string,
  sourceSha256: string,
  importedAt: string
): void => {
  database.prepare(`
    INSERT INTO legacy_imports(store_key, source_path, source_sha256, imported_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(store_key) DO NOTHING
  `).run(storeKey, sourcePath, sourceSha256, importedAt)
}

const stateMetadata = (state: CoreStateFile): CoreStateFile => ({
  ...state,
  replies: []
})

const combineState = (base: unknown, replies: PersistedReplyRecord[]): CoreStateFile => {
  if (!isObject(base)) return base as CoreStateFile
  const documentReplies = Array.isArray(base.replies)
    ? base.replies.filter(isPersistedReplyRecord)
    : []
  return {
    ...base,
    replies: mergeReplyRecords(documentReplies, replies)
  } as CoreStateFile
}

const stateDocumentContainsReplies = (value: unknown): value is { replies: unknown[] } =>
  isObject(value) && Array.isArray(value.replies) && value.replies.length > 0

const mergeReplyRecords = (
  documentReplies: readonly PersistedReplyRecord[],
  outboxReplies: readonly PersistedReplyRecord[]
): PersistedReplyRecord[] => {
  const merged: PersistedReplyRecord[] = []
  const positionById = new Map<string, number>()
  const appendOrMerge = (record: PersistedReplyRecord): void => {
    const position = positionById.get(record.id)
    if (position === undefined) {
      positionById.set(record.id, merged.length)
      merged.push(structuredClone(record))
      return
    }
    const current = merged[position]
    if (current) merged[position] = mergeReplyConflict(current, record)
  }
  for (const record of documentReplies) appendOrMerge(record)
  for (const record of outboxReplies) appendOrMerge(record)
  return merged
}

const mergeReplyConflict = (
  documentRecord: PersistedReplyRecord,
  outboxRecord: PersistedReplyRecord
): PersistedReplyRecord => {
  const documentSafety = replyStatusSafety(documentRecord.status)
  const outboxSafety = replyStatusSafety(outboxRecord.status)
  const updatedComparison = compareTimestamps(documentRecord.updatedAt, outboxRecord.updatedAt)
  // Prefer the state least likely to repeat an uncertain delivery. Within the
  // same safety class, the dedicated outbox wins ties and the newest update wins.
  const winner = documentSafety > outboxSafety
    ? documentRecord
    : outboxSafety > documentSafety
      ? outboxRecord
      : updatedComparison > 0
        ? documentRecord
        : outboxRecord
  const loser = winner === documentRecord ? outboxRecord : documentRecord
  const merged: PersistedReplyRecord = {
    ...structuredClone(winner),
    createdAt: compareTimestamps(documentRecord.createdAt, outboxRecord.createdAt) <= 0
      ? documentRecord.createdAt
      : outboxRecord.createdAt,
    updatedAt: updatedComparison >= 0 ? documentRecord.updatedAt : outboxRecord.updatedAt,
    attemptCount: Math.max(documentRecord.attemptCount, outboxRecord.attemptCount),
    ...(!winner.platformTaskId && loser.platformTaskId ? { platformTaskId: loser.platformTaskId } : {})
  }
  if (merged.status !== 'sending') delete merged.leaseExpiresAt
  return merged
}

const replyStatusSafety = (status: PersistedReplyRecord['status']): number => {
  if (status === 'sent') return 4
  if (status !== 'pending' && status !== 'sending') return 3
  if (status === 'sending') return 2
  return 1
}

const compareTimestamps = (left: string, right: string): number => {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
  return left.localeCompare(right)
}

const readOutboxUnlocked = (database: DatabaseSync): PersistedReplyRecord[] => {
  const rows = database.prepare(`
    SELECT payload_json FROM outbox ORDER BY position ASC
  `).all() as unknown as OutboxRow[]
  return rows.map((row) => parseOutboxRecord(row.payload_json))
}

const syncOutboxUnlocked = (
  database: DatabaseSync,
  previous: readonly PersistedReplyRecord[],
  next: readonly PersistedReplyRecord[]
): { outboxUpserts: number; outboxRemovals: number } => {
  const previousById = new Map(previous.map((record, position) => [record.id, {
    record,
    position,
    serialized: stringifyJson(record)
  }]))
  const nextIds = new Set(next.map((record) => record.id))
  let outboxUpserts = 0
  let outboxRemovals = 0

  for (const [id] of previousById) {
    if (nextIds.has(id)) continue
    outboxRemovals += Number(database.prepare('DELETE FROM outbox WHERE id = ?').run(id).changes)
  }
  for (const [position, record] of next.entries()) {
    if (!isPersistedReplyRecord(record)) {
      throw codedError('INVALID_OUTBOX_RECORD', 'Outbox 记录结构不合法')
    }
    const prior = previousById.get(record.id)
    const serialized = stringifyJson(record)
    if (prior && prior.position === position && prior.serialized === serialized) continue
    upsertOutboxUnlocked(database, record, position, serialized)
    outboxUpserts += 1
  }
  return { outboxUpserts, outboxRemovals }
}

const upsertOutboxUnlocked = (
  database: DatabaseSync,
  record: PersistedReplyRecord,
  position: number,
  serialized = stringifyJson(record)
): void => {
  database.prepare(`
    INSERT INTO outbox(
      id, message_id, group_id, status, attempt_count, idempotency_uuid,
      lease_expires_at, position, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      message_id = excluded.message_id,
      group_id = excluded.group_id,
      status = excluded.status,
      attempt_count = excluded.attempt_count,
      idempotency_uuid = excluded.idempotency_uuid,
      lease_expires_at = excluded.lease_expires_at,
      position = excluded.position,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.messageId,
    record.groupId,
    record.status,
    record.attemptCount,
    record.idempotencyUuid,
    record.leaseExpiresAt ?? null,
    position,
    serialized,
    record.createdAt,
    record.updatedAt
  )
}

const nextOutboxPosition = (database: DatabaseSync): number => {
  const row = database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM outbox')
    .get() as unknown as { position: number }
  return Number(row.position)
}

const parseOutboxRecord = (raw: string): PersistedReplyRecord => {
  const value = parseStoredJson(raw, 'SQLite Outbox')
  if (!isPersistedReplyRecord(value)) {
    throw codedError('INVALID_OUTBOX_RECORD', 'SQLite Outbox 记录结构不合法')
  }
  return structuredClone(value)
}

const toEventLogEntry = (row: EventRow): EventLogEntry => ({
  id: Number(row.id),
  stream: row.stream,
  eventType: row.event_type,
  payload: parseStoredJson(row.payload_json, `事件 ${row.id}`),
  createdAt: row.created_at
})

const parseStoredJson = (raw: string, label: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw codedError('CORRUPT_SQLITE_STORE', `${label} 已损坏`, error)
  }
}

const stringifyJson = (value: unknown): string => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw codedError('UNSERIALIZABLE_SQLITE_VALUE', '值无法序列化为 JSON')
  return serialized
}

const assertDocumentKey = (value: string): void => {
  if (!DOCUMENT_KEY_PATTERN.test(value)) throw new Error(`SQLite document key 不合法：${value}`)
}

const assertEventLabel = (value: string, label: string): void => {
  if (!value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}不合法`)
  }
}

const boundedLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error('查询 limit 必须是正整数')
  return Math.min(value, maximum)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const codedError = (code: string, message: string, cause?: unknown): Error & { code: string } =>
  Object.assign(new Error(message, ...(cause === undefined ? [] : [{ cause }])), { code })

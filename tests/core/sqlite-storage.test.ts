import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/contracts'
import { isAppConfig, migrateAppConfig } from '../../src/shared/validation'
import { isKnowledgeSnapshotFile } from '../../src/main/core/knowledge-sync'
import { createCoreState, isCoreStateFile } from '../../src/main/core/state'
import {
  SqliteCoreStateStore,
  SqliteDatabase,
  SqliteJsonStore
} from '../../src/main/core/sqlite-storage'
import type { KnowledgeSnapshotFile, PersistedReplyRecord } from '../../src/main/core/types'
import { EMPTY_KNOWLEDGE_SNAPSHOT } from '../../src/main/core/types'

const roots: string[] = []
const databases: SqliteDatabase[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SQLite storage', () => {
  it('enables WAL durability and serializes concurrent JsonStore updates', async () => {
    const { database, databasePath } = await createDatabase()
    const store = new SqliteJsonStore({
      database,
      documentKey: 'counter',
      createDefault: () => ({ count: 0 }),
      validate: isCounter
    })

    await Promise.all(
      Array.from({ length: 20 }, () => store.update((current) => ({ count: current.count + 1 })))
    )

    expect(await store.read()).toEqual({ count: 20 })
    const pragmas = await database.withConnection((connection) => ({
      journalMode: String((connection.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode),
      foreignKeys: Number((connection.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys),
      busyTimeout: Number((connection.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout),
      synchronous: Number((connection.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous),
      userVersion: Number((connection.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    }))
    expect(pragmas).toEqual({
      journalMode: 'wal',
      foreignKeys: 1,
      busyTimeout: 5_000,
      synchronous: 2,
      userVersion: 1
    })
    if (process.platform !== 'win32') expect((await stat(databasePath)).mode & 0o777).toBe(0o600)
  })

  it('imports config/state/knowledge JSON once, records hashes, and preserves source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-sqlite-legacy-'))
    roots.push(root)
    const runtime = join(root, 'runtime')
    const knowledgeFolder = join(runtime, 'knowledge')
    await mkdir(knowledgeFolder, { recursive: true })
    const configPath = join(runtime, 'config.json')
    const statePath = join(runtime, 'state.json')
    const knowledgePath = join(knowledgeFolder, 'snapshot.json')
    const config = { ...DEFAULT_CONFIG, onboardingComplete: true }
    const { agent: _agent, ...configWithoutAgent } = config
    const legacyConfig = { ...configWithoutAgent, version: 1 }
    const reply = replyRecord('legacy-reply', 'pending')
    const state = { ...createCoreState('legacy-instance'), initializedGroups: ['group-1'], replies: [reply] }
    const knowledge: KnowledgeSnapshotFile = {
      version: 1,
      generatedAt: '2026-08-10T00:00:00.000Z',
      documents: [{
        id: 'doc-1',
        sourceId: 'source-1',
        sourceLabel: '本地知识',
        title: '测试',
        origin: '/tmp/test.md',
        body: 'LuckyTag migration',
        hash: 'hash-1'
      }],
      chunks: [{
        id: 'chunk-1',
        documentId: 'doc-1',
        sourceId: 'source-1',
        sourceLabel: '本地知识',
        title: '测试',
        text: 'LuckyTag migration',
        position: 0
      }],
      sourceErrors: []
    }
    await Promise.all([
      writeFile(configPath, `${JSON.stringify(legacyConfig)}\n`, { mode: 0o600 }),
      writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 }),
      writeFile(knowledgePath, `${JSON.stringify(knowledge)}\n`, { mode: 0o600 })
    ])
    const originals = await Promise.all([
      readFile(configPath, 'utf8'),
      readFile(statePath, 'utf8'),
      readFile(knowledgePath, 'utf8')
    ])

    const database = new SqliteDatabase({ filePath: join(runtime, 'luckytag.sqlite3') })
    databases.push(database)
    const configStore = new SqliteJsonStore({
      database,
      documentKey: 'config',
      legacyFilePath: configPath,
      createDefault: () => structuredClone(DEFAULT_CONFIG),
      validate: isAppConfig,
      migrate: migrateAppConfig
    })
    const stateStore = new SqliteCoreStateStore({
      database,
      legacyFilePath: statePath,
      createDefault: () => createCoreState('new-instance'),
      validate: isCoreStateFile
    })
    const knowledgeStore = new SqliteJsonStore({
      database,
      documentKey: 'knowledge',
      legacyFilePath: knowledgePath,
      createDefault: () => structuredClone(EMPTY_KNOWLEDGE_SNAPSHOT),
      validate: isKnowledgeSnapshotFile
    })

    await expect(configStore.read()).resolves.toEqual(config)
    await expect(stateStore.read()).resolves.toEqual(state)
    await expect(knowledgeStore.read()).resolves.toEqual(knowledge)
    expect(await database.outbox.get(reply.id)).toEqual(reply)
    const imports = await database.withConnection((connection) =>
      connection.prepare(`
        SELECT store_key, source_path, source_sha256 FROM legacy_imports ORDER BY store_key
      `).all() as unknown as Array<{ store_key: string; source_path: string; source_sha256: string }>
    )
    expect(imports.map((item) => item.store_key)).toEqual(['config', 'knowledge', 'state'])
    expect(imports.every((item) => item.source_sha256.length === 64)).toBe(true)
    await expect(Promise.all([
      readFile(configPath, 'utf8'),
      readFile(statePath, 'utf8'),
      readFile(knowledgePath, 'utf8')
    ])).resolves.toEqual(originals)

    // Once a database row exists, changing a legacy source cannot overwrite it.
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG)}\n`, 'utf8')
    await expect(configStore.read()).resolves.toEqual(config)
    expect((await database.events.list()).filter((event) =>
      event.eventType === 'store.legacy_json_imported'
    )).toHaveLength(3)
  })

  it('persists state transitions through the outbox boundary in the same transaction', async () => {
    const { database } = await createDatabase()
    const store = new SqliteCoreStateStore({
      database,
      createDefault: () => createCoreState('instance-1'),
      validate: isCoreStateFile
    })
    const first = replyRecord('reply-1', 'pending')
    const second = replyRecord('reply-2', 'pending')

    await store.update((state) => ({ ...state, replies: [first, second] }))
    expect((await database.outbox.list()).map((record) => record.id).sort()).toEqual([
      'reply-1',
      'reply-2'
    ])

    const sending = {
      ...first,
      status: 'sending' as const,
      attemptCount: 1,
      leaseExpiresAt: '2026-08-10T00:02:00.000Z',
      updatedAt: '2026-08-10T00:01:00.000Z'
    }
    await store.update((state) => ({ ...state, replies: [sending] }))

    await expect(store.read()).resolves.toEqual({
      ...createCoreState('instance-1'),
      replies: [sending]
    })
    await expect(database.outbox.get('reply-2')).resolves.toBeUndefined()
    await expect(database.outbox.list({ statuses: ['sending'] })).resolves.toEqual([sending])
    const acknowledged = await database.outbox.acknowledge({
      id: sending.id,
      status: 'sent',
      updatedAt: '2026-08-10T00:02:00.000Z',
      reason: '发送回执已确认',
      platformTaskId: 'task-1'
    })
    expect(acknowledged).toMatchObject({
      id: sending.id,
      status: 'sent',
      reason: '发送回执已确认',
      platformTaskId: 'task-1'
    })
    expect((await store.read()).replies).toEqual([acknowledged])
    const stateEvents = await database.events.list({ stream: 'store.state' })
    expect(stateEvents.some((event) => event.eventType === 'store.updated')).toBe(true)
    expect((await database.events.list({ stream: 'outbox' }))[0]).toMatchObject({
      eventType: 'outbox.acknowledged',
      payload: { recordId: sending.id, status: 'sent' }
    })
  })

  it('merges partially overlapping early state replies and outbox records without loss', async () => {
    const { database } = await createDatabase()
    const store = new SqliteCoreStateStore({
      database,
      createDefault: () => createCoreState('partial-migration'),
      validate: isCoreStateFile
    })
    await store.read()

    const documentOnly = replyRecord('document-only', 'pending')
    const outboxOnly = {
      ...replyRecord('outbox-only', 'needs_manual'),
      updatedAt: '2026-08-10T00:04:00.000Z'
    }
    const documentPending = {
      ...replyRecord('shared-sending', 'pending'),
      updatedAt: '2026-08-10T00:03:00.000Z'
    }
    const outboxSending = {
      ...replyRecord('shared-sending', 'sending'),
      attemptCount: 2,
      leaseExpiresAt: '2026-08-10T00:05:00.000Z',
      updatedAt: '2026-08-10T00:02:00.000Z'
    }
    const documentSent = {
      ...replyRecord('shared-sent', 'sent'),
      platformTaskId: 'confirmed-task',
      updatedAt: '2026-08-10T00:01:00.000Z'
    }
    const outboxPending = {
      ...replyRecord('shared-sent', 'pending'),
      attemptCount: 3,
      updatedAt: '2026-08-10T00:06:00.000Z'
    }
    const earlyState = {
      ...createCoreState('partial-migration'),
      replies: [documentOnly, documentPending, documentSent]
    }
    await Promise.all([
      database.outbox.upsert(outboxSending),
      database.outbox.upsert(outboxPending),
      database.outbox.upsert(outboxOnly)
    ])
    await database.withConnection((connection) => {
      connection.prepare(`
        UPDATE json_documents SET value_json = ?, revision = revision + 1 WHERE document_key = 'state'
      `).run(JSON.stringify(earlyState))
    })

    const migrated = await store.read()

    expect(migrated.replies.map((reply) => reply.id)).toEqual([
      'document-only',
      'shared-sending',
      'shared-sent',
      'outbox-only'
    ])
    expect(migrated.replies.find((reply) => reply.id === 'shared-sending')).toMatchObject({
      status: 'sending',
      attemptCount: 2,
      updatedAt: '2026-08-10T00:03:00.000Z'
    })
    expect(migrated.replies.find((reply) => reply.id === 'shared-sent')).toMatchObject({
      status: 'sent',
      attemptCount: 3,
      platformTaskId: 'confirmed-task',
      updatedAt: '2026-08-10T00:06:00.000Z'
    })
    expect((await database.outbox.list({ limit: 20 })).map((reply) => reply.id).sort()).toEqual([
      'document-only',
      'outbox-only',
      'shared-sending',
      'shared-sent'
    ])
    await database.withConnection((connection) => {
      const row = connection.prepare(`
        SELECT value_json FROM json_documents WHERE document_key = 'state'
      `).get() as unknown as { value_json: string }
      expect((JSON.parse(row.value_json) as { replies: unknown[] }).replies).toEqual([])
    })
    expect((await database.events.list({ stream: 'store.state' })).filter((event) =>
      event.eventType === 'store.outbox_migrated'
    )).toHaveLength(1)
    await expect(store.read()).resolves.toEqual(migrated)
  })

  it('rolls state, outbox, and event metadata back as one unit', async () => {
    const { database } = await createDatabase()
    const store = new SqliteCoreStateStore({
      database,
      createDefault: () => createCoreState('instance-rollback'),
      validate: isCoreStateFile
    })
    const original = replyRecord('original', 'pending')
    await store.update((state) => ({ ...state, replies: [original] }))
    const eventCountBefore = (await database.events.list({ stream: 'store.state' })).length
    const conflicting = {
      ...replyRecord('conflicting', 'pending'),
      messageId: original.messageId
    }

    await expect(store.update((state) => ({
      ...state,
      initializedGroups: ['must-rollback'],
      replies: [original, conflicting]
    }))).rejects.toThrow()

    expect(await store.read()).toEqual({
      ...createCoreState('instance-rollback'),
      replies: [original]
    })
    expect(await database.outbox.list()).toEqual([original])
    expect((await database.events.list({ stream: 'store.state' }))).toHaveLength(eventCountBefore)
  })

  it('rolls back invalid writes and enforces an append-only event log', async () => {
    const { database } = await createDatabase()
    const store = new SqliteJsonStore({
      database,
      documentKey: 'counter',
      createDefault: () => ({ count: 1 }),
      validate: isCounter
    })
    await store.read()

    await expect(store.update(() => ({ count: Number.NaN }))).rejects.toMatchObject({
      code: 'INVALID_SQLITE_STORE'
    })
    await expect(store.read()).resolves.toEqual({ count: 1 })
    await database.events.append({ stream: 'test', eventType: 'test.created', payload: { ok: true } })
    await expect(database.withConnection((connection) => {
      connection.prepare(`UPDATE event_log SET event_type = 'tampered' WHERE stream = 'test'`).run()
    })).rejects.toThrow(/append-only/u)
    expect((await database.events.list({ stream: 'test' }))[0]?.eventType).toBe('test.created')
  })
})

const createDatabase = async (): Promise<{ database: SqliteDatabase; databasePath: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'luckytag-sqlite-'))
  roots.push(root)
  const databasePath = join(root, 'runtime', 'luckytag.sqlite3')
  const database = new SqliteDatabase({ filePath: databasePath })
  databases.push(database)
  return { database, databasePath }
}

const isCounter = (value: unknown): value is { count: number } =>
  typeof value === 'object' && value !== null &&
  'count' in value && typeof value.count === 'number' && Number.isInteger(value.count)

const replyRecord = (
  id: string,
  status: PersistedReplyRecord['status']
): PersistedReplyRecord => ({
  id,
  messageId: `message-${id}`,
  groupId: 'group-1',
  groupLabel: '测试群',
  question: 'LuckyTag 如何工作？',
  status,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  evidence: [],
  attemptCount: 0,
  idempotencyUuid: `uuid-${id}`
})

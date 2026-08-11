import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonStore } from '../../src/main/core/atomic-json-store'
import {
  isKnowledgeSnapshotFile,
  KnowledgeSynchronizer
} from '../../src/main/core/knowledge-sync'
import { EMPTY_KNOWLEDGE_SNAPSHOT, type KnowledgeSnapshotFile, type YuqueClient } from '../../src/main/core/types'
import { applyPatch } from './test-file-helper'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeYuque implements YuqueClient {
  readonly calls: string[] = []

  async probe() {
    return { authenticated: true, detail: 'ok' }
  }

  async authenticate() {
    return { authenticated: true, detail: 'ok' }
  }

  async resolve(input: string): Promise<string> {
    this.calls.push(`resolve:${input}`)
    return 'team/manual/single-doc'
  }

  async listDocuments(namespace: string): Promise<Array<{ route: string; title?: string }>> {
    this.calls.push(`list:${namespace}`)
    return [{ route: `${namespace}/book-doc`, title: '知识库文档' }]
  }

  async showDocument(route: string) {
    this.calls.push(`show:${route}`)
    return {
      route,
      title: route.endsWith('single-doc') ? '单篇手册' : '知识库文档',
      body: route.endsWith('single-doc') ? '单篇语雀文档正文。' : '语雀知识库正文。'
    }
  }
}

describe('KnowledgeSynchronizer', () => {
  it('atomically snapshots local Markdown/HTML plus Yuque doc/book sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luckytag-knowledge-'))
    directories.push(directory)
    const localFolder = join(directory, 'notes')
    await mkdir(localFolder)
    await applyPatch(join(localFolder, 'guide.md'), '# 本地指南\n\n先配置群白名单。')
    await applyPatch(
      join(localFolder, 'faq.html'),
      '<html><head><title>常见问题</title><script>ignore()</script></head><body>默认 dry-run。</body></html>'
    )

    const store = new AtomicJsonStore<KnowledgeSnapshotFile>({
      filePath: join(directory, 'knowledge', 'snapshot.json'),
      createDefault: () => structuredClone(EMPTY_KNOWLEDGE_SNAPSHOT),
      validate: isKnowledgeSnapshotFile
    })
    const yuque = new FakeYuque()
    const synchronizer = new KnowledgeSynchronizer(store, yuque, () => new Date('2026-07-17T03:00:00Z'))
    const sources = [
      { id: 'local', type: 'local-directory' as const, label: '本地', path: localFolder, enabled: true },
      {
        id: 'doc',
        type: 'yuque-doc' as const,
        label: '单篇',
        routeOrUrl: 'https://yuque.antfin.com/team/manual/single-doc',
        enabled: true
      },
      {
        id: 'book',
        type: 'yuque-book' as const,
        label: '知识库',
        namespace: 'team/manual',
        enabled: true
      }
    ]

    const first = await synchronizer.sync(sources)
    const second = await synchronizer.sync(sources)
    const snapshot = await store.read()

    expect(first).toMatchObject({ documentCount: 4, changedDocuments: 4, sourceErrors: [] })
    expect(second.changedDocuments).toBe(0)
    expect(snapshot.chunks.length).toBeGreaterThanOrEqual(4)
    expect(snapshot.documents.find((document) => document.title === '常见问题')?.body).not.toContain(
      'ignore()'
    )
    expect(yuque.calls).toContain(
      'resolve:https://yuque.antfin.com/team/manual/single-doc'
    )
    expect(yuque.calls).toContain('list:team/manual')
  })

  it('serializes overlapping syncs so the newer request owns the final snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luckytag-knowledge-race-'))
    directories.push(directory)
    const store = new AtomicJsonStore<KnowledgeSnapshotFile>({
      filePath: join(directory, 'knowledge', 'snapshot.json'),
      createDefault: () => structuredClone(EMPTY_KNOWLEDGE_SNAPSHOT),
      validate: isKnowledgeSnapshotFile
    })
    let callCount = 0
    let resolveFirst: ((body: string) => void) | undefined
    let resolveSecond: ((body: string) => void) | undefined
    let markFirstStarted: (() => void) | undefined
    let markSecondStarted: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    const yuque: YuqueClient = {
      async probe() { return { authenticated: true, detail: 'ok' } },
      async authenticate() { return { authenticated: true, detail: 'ok' } },
      async resolve(input) { return input },
      async listDocuments() { return [] },
      async showDocument(route) {
        callCount += 1
        const body = await new Promise<string>((resolve) => {
          if (callCount === 1) {
            resolveFirst = resolve
            markFirstStarted?.()
          } else {
            resolveSecond = resolve
            markSecondStarted?.()
          }
        })
        return { route, title: body, body }
      }
    }
    const synchronizer = new KnowledgeSynchronizer(store, yuque)
    const sources = [{
      id: 'doc',
      type: 'yuque-doc' as const,
      label: '语雀',
      routeOrUrl: 'team/book/doc',
      enabled: true
    }]

    const older = synchronizer.sync(sources)
    await firstStarted
    const newer = synchronizer.sync(sources)
    expect(callCount).toBe(1)
    resolveFirst?.('Old')
    await older
    await secondStarted
    resolveSecond?.('New')
    await newer

    expect((await store.read()).documents[0]).toMatchObject({ title: 'New', body: 'New' })
  })
})

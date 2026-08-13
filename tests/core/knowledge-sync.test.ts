import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonStore } from '../../src/main/core/atomic-json-store'
import {
  isKnowledgeSnapshotFile,
  KnowledgeSynchronizer
} from '../../src/main/core/knowledge-sync'
import { EMPTY_KNOWLEDGE_SNAPSHOT, type KnowledgeSnapshotFile, type SampleLibraryClient } from '../../src/main/core/types'
import { applyPatch } from './test-file-helper'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeSampleLibrary implements SampleLibraryClient {
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
      body: route.endsWith('single-doc') ? '单篇示例知识库文档正文。' : '示例知识库知识库正文。'
    }
  }
}

describe('KnowledgeSynchronizer', () => {
  it('atomically snapshots local Markdown/HTML plus SampleLibrary doc/book sources', async () => {
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
    const sampleLibrary = new FakeSampleLibrary()
    const synchronizer = new KnowledgeSynchronizer(store, sampleLibrary, () => new Date('2026-07-17T03:00:00Z'))
    const sources = [
      { id: 'local', type: 'local-directory' as const, label: '本地', path: localFolder, enabled: true },
      {
        id: 'doc',
        type: 'sampleLibrary-doc' as const,
        label: '单篇',
        routeOrUrl: 'https://library.example.invalid/team/manual/single-doc',
        enabled: true
      },
      {
        id: 'book',
        type: 'sampleLibrary-book' as const,
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
    expect(sampleLibrary.calls).toContain(
      'resolve:https://library.example.invalid/team/manual/single-doc'
    )
    expect(sampleLibrary.calls).toContain('list:team/manual')
  })

  it('decodes HTML entities exactly once when importing untrusted HTML', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luckytag-knowledge-entities-'))
    directories.push(directory)
    const localFolder = join(directory, 'notes')
    await mkdir(localFolder)
    await applyPatch(
      join(localFolder, 'encoded.html'),
      '<html><head><title>&amp;lt;Admin&amp;gt;</title></head>' +
        '<body>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; ' +
        '&lt;b&gt;safe&lt;/b&gt; Tom &amp;amp; Jerry &quot;x&quot; &#39;y&#39;&nbsp;</body></html>'
    )

    const store = new AtomicJsonStore<KnowledgeSnapshotFile>({
      filePath: join(directory, 'knowledge', 'snapshot.json'),
      createDefault: () => structuredClone(EMPTY_KNOWLEDGE_SNAPSHOT),
      validate: isKnowledgeSnapshotFile
    })
    const synchronizer = new KnowledgeSynchronizer(store, new FakeSampleLibrary())

    await synchronizer.sync([
      {
        id: 'local',
        type: 'local-directory',
        label: '本地',
        path: localFolder,
        enabled: true
      }
    ])

    const document = (await store.read()).documents[0]
    expect(document).toBeDefined()
    if (!document) throw new Error('Expected the imported HTML document')
    expect(document.title).toBe('&lt;Admin&gt;')
    expect(document.body).toBe(
      '&lt;Admin&gt; &lt;script&gt;alert(1)&lt;/script&gt; <b>safe</b> Tom &amp; Jerry "x" \'y\''
    )
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
    const sampleLibrary: SampleLibraryClient = {
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
    const synchronizer = new KnowledgeSynchronizer(store, sampleLibrary)
    const sources = [{
      id: 'doc',
      type: 'sampleLibrary-doc' as const,
      label: '示例知识库',
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

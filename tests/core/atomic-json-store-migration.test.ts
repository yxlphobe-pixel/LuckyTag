import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonStore } from '../../src/main/core/atomic-json-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AtomicJsonStore migration', () => {
  it('原子迁移已存在的旧结构并回写新版本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luckytag-store-migration-'))
    roots.push(root)
    const filePath = join(root, 'config.json')
    await writeFile(filePath, '{"version":1,"name":"legacy"}\n', 'utf8')
    const store = new AtomicJsonStore({
      filePath,
      createDefault: () => ({ version: 2, name: 'default' }),
      validate: (value: unknown): value is { version: 2; name: string } => (
        typeof value === 'object' && value !== null &&
        (value as { version?: unknown }).version === 2 &&
        typeof (value as { name?: unknown }).name === 'string'
      ),
      migrate: (value) => ({
        version: 2,
        name: String((value as { name?: unknown }).name || 'default')
      })
    })

    await expect(store.read()).resolves.toEqual({ version: 2, name: 'legacy' })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 2, name: 'legacy' })
  })
})

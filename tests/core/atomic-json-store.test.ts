import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonStore } from '../../src/main/core/atomic-json-store'

interface CounterFile {
  count: number
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AtomicJsonStore', () => {
  it('serializes concurrent updates and writes private valid JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luckytag-store-'))
    directories.push(directory)
    const filePath = join(directory, 'state.json')
    const store = new AtomicJsonStore<CounterFile>({
      filePath,
      createDefault: () => ({ count: 0 }),
      validate: (value): value is CounterFile =>
        typeof value === 'object' && value !== null && 'count' in value && Number.isInteger(value.count)
    })

    await Promise.all(
      Array.from({ length: 20 }, () => store.update((current) => ({ count: current.count + 1 })))
    )

    expect(await store.read()).toEqual({ count: 20 })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ count: 20 })
    if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})

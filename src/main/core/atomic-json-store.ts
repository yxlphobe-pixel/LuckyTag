import { chmod, open, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JsonStore } from './json-store'

export interface AtomicJsonStoreOptions<T> {
  filePath: string
  createDefault: () => T
  validate: (value: unknown) => value is T
  migrate?: (value: unknown) => T
}

export class AtomicJsonStore<T> implements JsonStore<T> {
  readonly filePath: string
  private readonly createDefault: () => T
  private readonly validate: (value: unknown) => value is T
  private readonly migrate: ((value: unknown) => T) | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: AtomicJsonStoreOptions<T>) {
    this.filePath = options.filePath
    this.createDefault = options.createDefault
    this.validate = options.validate
    this.migrate = options.migrate
  }

  async read(): Promise<T> {
    return this.exclusive(async () => this.readUnlocked())
  }

  async write(value: T): Promise<T> {
    return this.exclusive(async () => {
      const next = structuredClone(value)
      this.assertValid(next)
      await this.writeUnlocked(next)
      return structuredClone(next)
    })
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const current = await this.readUnlocked()
      const next = structuredClone(await mutator(structuredClone(current)))
      this.assertValid(next)
      await this.writeUnlocked(next)
      return structuredClone(next)
    })
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

  private async readUnlocked(): Promise<T> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!this.validate(parsed) && this.migrate) {
        const migrated = structuredClone(this.migrate(parsed))
        this.assertValid(migrated)
        await this.writeUnlocked(migrated)
        return structuredClone(migrated)
      }
      this.assertValid(parsed)
      return structuredClone(parsed)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const initial = structuredClone(this.createDefault())
        this.assertValid(initial)
        await this.writeUnlocked(initial)
        return structuredClone(initial)
      }
      if (error instanceof SyntaxError) {
        throw Object.assign(new Error(`JSON 存储损坏：${this.filePath}`), {
          code: 'CORRUPT_JSON_STORE',
          cause: error
        })
      }
      throw error
    }
  }

  private assertValid(value: unknown): asserts value is T {
    if (!this.validate(value)) {
      throw Object.assign(new Error(`JSON 存储结构不合法：${this.filePath}`), {
        code: 'INVALID_JSON_STORE'
      })
    }
  }

  private async writeUnlocked(value: T): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    )
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
      await chmod(this.filePath, 0o600).catch((error: unknown) => {
        if (process.platform !== 'win32') throw error
      })

      // Persist the directory entry where the platform supports directory fsync.
      try {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      } catch {
        // Some filesystems do not permit opening or syncing directories.
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

const isNodeError = (value: unknown): value is NodeJS.ErrnoException =>
  value instanceof Error && 'code' in value

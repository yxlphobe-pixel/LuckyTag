import { open } from 'node:fs/promises'

// Tests use the same private-file semantics as runtime artifacts without shell redirection.
export const applyPatch = async (filePath: string, content: string): Promise<void> => {
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}

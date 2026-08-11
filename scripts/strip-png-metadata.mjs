import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const REQUIRED_OR_VISUAL_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM'
])

for (const path of process.argv.slice(2)) {
  const input = await readFile(path)
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${path} is not a PNG file`)
  }

  const chunks = [PNG_SIGNATURE]
  let offset = PNG_SIGNATURE.length
  let sawEnd = false
  while (offset < input.length) {
    if (offset + 12 > input.length) throw new Error(`${path} has a truncated PNG chunk`)
    const length = input.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > input.length) throw new Error(`${path} has an invalid PNG chunk length`)
    const type = input.toString('ascii', offset + 4, offset + 8)
    if (REQUIRED_OR_VISUAL_CHUNKS.has(type)) chunks.push(input.subarray(offset, end))
    offset = end
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }
  if (!sawEnd) throw new Error(`${path} has no IEND chunk`)

  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, Buffer.concat(chunks), { mode: 0o600 })
  await rename(temporaryPath, path)
  console.log(`Sanitized ${basename(path)}`)
}

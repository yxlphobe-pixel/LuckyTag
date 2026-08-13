import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const candidates = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' }
).split('\0').filter(Boolean)

const detectors = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/gu],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu],
  ['high-confidence model API key', /\b(?:sk-ant-api03-[A-Za-z0-9_-]{32,}|sk-proj-[A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9_-]{32,})\b/gu],
  ['assigned credential', /\b(?:DTCLAW_MODEL_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)\s*=\s*["']?[^\s"'#]{16,}/gu]
]

const findings = []
const metadataChunkTypes = new Set(['eXIf', 'iTXt', 'tEXt', 'zTXt', 'caBX'])

for (const path of candidates) {
  if (!existsSync(path)) continue
  const content = readFileSync(path)
  const binary = content.includes(0)
  const text = binary
    ? content.toString('latin1').replace(/[^\x20-\x7e]+/gu, '\n')
    : content.toString('utf8')
  for (const [label, pattern] of detectors) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const lineStart = text.lastIndexOf('\n', match.index ?? 0) + 1
      const lineEnd = text.indexOf('\n', match.index ?? 0)
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      const lineNumber = text.slice(0, match.index).split('\n').length
      findings.push(binary ? `${path}: ${label} in binary metadata/content` : `${path}:${lineNumber}: ${label}`)
    }
  }

  if (!binary) {
    for (const match of text.matchAll(/\/Users\/(?!example(?:\/|\b)|test(?:\/|\b)|Shared(?:\/|\b))[A-Za-z0-9._-]+/gu)) {
      const lineNumber = text.slice(0, match.index).split('\n').length
      findings.push(`${path}:${lineNumber}: local macOS user path`)
    }
    if (path !== 'pnpm-lock.yaml') {
      for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu)) {
        const domain = match[1]?.toLowerCase() ?? ''
        if (domain.endsWith('.example.test') || domain === 'example.com' || domain === 'users.noreply.github.com' || match[0].toLowerCase() === 'yxlphobe@gmail.com') continue
        const lineNumber = text.slice(0, match.index).split('\n').length
        findings.push(`${path}:${lineNumber}: non-placeholder email address`)
      }
    }
  }

  if (path.endsWith('.png') && content.subarray(1, 4).toString('ascii') === 'PNG') {
    let offset = 8
    while (offset + 12 <= content.length) {
      const length = content.readUInt32BE(offset)
      const end = offset + 12 + length
      if (end > content.length) break
      const type = content.toString('ascii', offset + 4, offset + 8)
      if (metadataChunkTypes.has(type)) findings.push(`${path}: disallowed PNG metadata chunk ${type}`)
      offset = end
      if (type === 'IEND') break
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets detected:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Secret scan passed (${candidates.length} repository files checked).`)
}

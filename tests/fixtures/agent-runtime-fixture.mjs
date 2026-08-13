#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(import.meta.url)
const fixtureRoot = dirname(fixturePath)
const fixtureName = basename(fixturePath)
const runtime = fixtureName.startsWith('codex-') ? 'codex' : 'claude-code'
const hangs = fixtureName.includes('-hang-')
const markerPath = join(fixtureRoot, 'orphan-marker')
const startedPath = join(fixtureRoot, 'runtime-started')
const probeEnvironmentPath = join(fixtureRoot, 'probe-environment.json')

if (process.argv.includes('--write-orphan')) {
  setTimeout(() => writeFileSync(markerPath, 'orphan'), 400)
} else if (hangs) {
  process.once('SIGTERM', () => {
    spawn(process.execPath, [fixturePath, '--write-orphan'], { stdio: 'ignore' })
    process.exit(0)
  })
  writeFileSync(startedPath, 'started')
  setTimeout(() => undefined, 10_000)
} else if (process.argv.includes('--version')) {
  writeFileSync(probeEnvironmentPath, JSON.stringify(process.env))
  process.stdout.write('fixture-runtime 1.0.0\n')
} else {
  const keyName = runtime === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  const urlName = runtime === 'codex' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'
  const cwd = process.cwd()
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { prompt += chunk })
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({
      args: process.argv.slice(2),
      prompt,
      keyName,
      keyConfigured: Boolean(process.env[keyName]),
      urlName,
      url: process.env[urlName] || '',
      homeMatchesCwd: realpathSync(process.env.HOME) === realpathSync(cwd),
      directoryMode: (statSync(cwd).mode & 0o777).toString(8),
      path: process.env.PATH,
      environment: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        name.startsWith('CLAUDE_') ||
        name.startsWith('DISABLE_') ||
        name === 'MCP_CONNECTION_NONBLOCKING'
      ))
    }))
  })
}

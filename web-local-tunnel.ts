#!/usr/bin/env bun

import { randomBytes, randomInt } from 'crypto'
import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { mergedEnv } from './env-file.ts'

const port = Number(process.env.CODEX_WEB_PORT ?? 8791)
const env = { ...mergedEnv(process.env.CODEX_WEB_ENV ?? '.env.web'), ...process.env }
const token = env.CODEX_WEB_TOKEN || randomBytes(18).toString('base64url')
const pin = env.CODEX_WEB_PIN || String(randomInt(0, 1000000)).padStart(6, '0')

const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

const publicUrl = await waitForTunnelUrl(tunnel)
const appUrl = `${publicUrl}/?token=${encodeURIComponent(token)}`
const webEnv = { ...env, CODEX_WEB_PORT: String(port), CODEX_WEB_TOKEN: token, CODEX_WEB_PIN: pin }

console.log(`Mobile Codex URL: ${appUrl}`)
console.log(`Mobile Codex PIN: ${pin}`)

const web = spawn('bun', ['codex-mobile-web.ts'], {
  env: webEnv,
  stdio: ['ignore', 'inherit', 'inherit'],
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    web.kill(sig)
    tunnel.kill(sig)
    process.exit(0)
  })
}

await new Promise<void>(resolve => web.on('exit', () => resolve()))
tunnel.kill()

function waitForTunnelUrl(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloudflared URL 생성 시간이 초과됐습니다.')), 30000)
    const onData = (data: Buffer) => {
      const text = data.toString()
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
      if (!match) return
      clearTimeout(timer)
      proc.stdout.off('data', onData)
      proc.stderr.off('data', onData)
      resolve(match[0])
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', code => reject(new Error(`cloudflared exited before URL was ready: ${code}`)))
  })
}

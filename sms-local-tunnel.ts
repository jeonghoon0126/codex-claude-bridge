#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mergedEnv } from './env-file.ts'

const port = Number(process.env.CODEX_SMS_PORT ?? 8790)
const env = mergedEnv(process.env.CODEX_SMS_ENV ?? '.env.sms')

const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

const publicUrl = await waitForTunnelUrl(tunnel)
const smsUrl = `${publicUrl}/twilio/sms`
const smsEnv = { ...env, CODEX_SMS_PORT: String(port), CODEX_SMS_PUBLIC_URL: smsUrl }

console.log(`Public SMS webhook: ${smsUrl}`)
console.log('Set this URL in Twilio, or run: bun run sms:configure')

const sms = spawn('bun', ['twilio-codex-sms.ts'], {
  env: smsEnv,
  stdio: ['ignore', 'inherit', 'inherit'],
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    sms.kill(sig)
    tunnel.kill(sig)
    process.exit(0)
  })
}

await new Promise<void>(resolve => sms.on('exit', () => resolve()))
tunnel.kill()

function waitForTunnelUrl(proc: ChildProcessWithoutNullStreams): Promise<string> {
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

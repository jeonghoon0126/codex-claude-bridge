#!/usr/bin/env bun

import { randomBytes, randomInt } from 'crypto'
import { spawn } from 'child_process'
import { networkInterfaces } from 'os'
import { mergedEnv } from './env-file.ts'

const env = { ...mergedEnv(process.env.CODEX_WEB_ENV ?? '.env.web'), ...process.env }
const port = Number(env.CODEX_WEB_PORT ?? 8791)
const host = env.CODEX_WEB_HOST || privateVpnIp() || privateLanIp() || '0.0.0.0'
const token = env.CODEX_WEB_TOKEN || randomBytes(18).toString('base64url')
const pin = env.CODEX_WEB_PIN || String(randomInt(0, 1000000)).padStart(6, '0')
const urlHost = host === '0.0.0.0' ? privateLanIp() || '127.0.0.1' : host

console.log(`Mobile Codex VPN URL: http://${urlHost}:${port}/?token=${encodeURIComponent(token)}`)
console.log(`Mobile Codex PIN: ${pin}`)

const web = spawn('bun', ['codex-mobile-web.ts'], {
  env: {
    ...env,
    CODEX_WEB_PORT: String(port),
    CODEX_WEB_HOST: host,
    CODEX_WEB_TOKEN: token,
    CODEX_WEB_PIN: pin,
    CODEX_WEB_COOKIE_SECURE: 'false',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    web.kill(sig)
    process.exit(0)
  })
}

await new Promise<void>(resolve => web.on('exit', () => resolve()))

function privateVpnIp(): string | undefined {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!/^(utun|tun|tap|ppp|tailscale|wg)/i.test(name)) continue
    const ip = entries?.find(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIp(entry.address))?.address
    if (ip) return ip
  }
}

function privateLanIp(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    const ip = entries?.find(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIp(entry.address))?.address
    if (ip) return ip
  }
}

function isPrivateIp(value: string): boolean {
  return /^10\./.test(value)
    || /^192\.168\./.test(value)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)
}

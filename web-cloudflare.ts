#!/usr/bin/env bun

import { existsSync } from 'fs'
import { randomBytes, randomInt } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { mergedEnv } from './env-file.ts'

const env = { ...mergedEnv(process.env.CODEX_WEB_ENV ?? '.env.web'), ...process.env }
const hostname = env.CODEX_WEB_HOSTNAME
const tunnelName = env.CODEX_WEB_TUNNEL_NAME ?? 'codex-mobile-web'
const configPath = env.CLOUDFLARED_CONFIG ?? join(homedir(), '.cloudflared', `${tunnelName}.yml`)
const port = Number(env.CODEX_WEB_PORT ?? 8791)
const token = env.CODEX_WEB_TOKEN || randomBytes(18).toString('base64url')
const pin = env.CODEX_WEB_PIN || String(randomInt(0, 1000000)).padStart(6, '0')
const requireBootToken = env.CODEX_WEB_REQUIRE_BOOT_TOKEN === 'true'
const bunExecutable = env.BUN_EXECUTABLE || process.execPath
const codexExecutable = env.CODEX_APP_SERVER_COMMAND
  || (existsSync(join(homedir(), '.bun', 'bin', 'codex')) ? join(homedir(), '.bun', 'bin', 'codex') : 'codex')
const path = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  env.PATH ?? '',
].filter(Boolean).join(':')

if (!hostname) fail('CODEX_WEB_HOSTNAME이 필요합니다.')
if (!existsSync(configPath)) fail(`Cloudflare tunnel config가 없습니다: ${configPath}\n먼저 bun run web:cf:setup ${hostname} 를 실행하세요.`)
if (!env.CODEX_WEB_ALLOWED_CF_EMAILS) fail('CODEX_WEB_ALLOWED_CF_EMAILS가 필요합니다.')
if (!env.CODEX_WEB_ALLOWED_CLIENT_CIDRS) {
  console.warn('CODEX_WEB_ALLOWED_CLIENT_CIDRS가 비어 있어 Access + PIN 모드로 실행합니다.')
}

const webEnv = {
  ...env,
  CODEX_WEB_HOST: '127.0.0.1',
  CODEX_WEB_PORT: String(port),
  CODEX_WEB_TOKEN: token,
  CODEX_WEB_PIN: pin,
  CODEX_WEB_REQUIRE_CF_ACCESS: 'true',
  CODEX_WEB_REQUIRE_BOOT_TOKEN: requireBootToken ? 'true' : 'false',
  CODEX_APP_SERVER_COMMAND: codexExecutable,
  PATH: path,
}

const tunnel = spawn('cloudflared', ['tunnel', '--config', configPath, 'run'], {
  stdio: ['ignore', 'inherit', 'inherit'],
})

const web = spawn(bunExecutable, ['codex-mobile-web.ts'], {
  env: webEnv,
  stdio: ['ignore', 'inherit', 'inherit'],
})

console.log(`Mobile Codex URL: https://${hostname}/${requireBootToken ? `?token=${encodeURIComponent(token)}` : ''}`)
if (env.CODEX_WEB_PRINT_PIN !== 'false') console.log(`Mobile Codex PIN: ${pin}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    web.kill(sig)
    tunnel.kill(sig)
    process.exit(0)
  })
}

await new Promise<void>(resolve => web.on('exit', () => resolve()))
tunnel.kill()

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

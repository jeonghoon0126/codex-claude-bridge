#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { mergedEnv } from './env-file.ts'

const env = { ...mergedEnv(process.env.CODEX_WEB_ENV ?? '.env.web'), ...process.env }
const hostname = process.argv[2] ?? env.CODEX_WEB_HOSTNAME
const tunnelName = env.CODEX_WEB_TUNNEL_NAME ?? 'codex-mobile-web'
const port = Number(env.CODEX_WEB_PORT ?? 8791)
const configPath = env.CLOUDFLARED_CONFIG ?? join(homedir(), '.cloudflared', `${tunnelName}.yml`)
const certPath = env.TUNNEL_ORIGIN_CERT ?? join(homedir(), '.cloudflared', 'cert.pem')

if (!hostname) fail('CODEX_WEB_HOSTNAME 또는 첫 번째 인자로 hostname이 필요합니다. 예: codex.example.com')
if (!existsSync(certPath)) fail(`Cloudflare origin cert가 없습니다: ${certPath}\n먼저 cloudflared tunnel login을 완료하세요.`)
if (!commandOk('cloudflared', ['--version'])) fail('cloudflared를 찾을 수 없습니다.')

const tunnel = findTunnel(tunnelName) ?? createTunnel(tunnelName)
const tunnelId = tunnel.id
const credentialsFile = env.TUNNEL_CRED_FILE ?? join(homedir(), '.cloudflared', `${tunnelId}.json`)
if (!existsSync(credentialsFile)) fail(`tunnel credentials 파일이 없습니다: ${credentialsFile}`)

writeConfig(configPath, tunnelId, credentialsFile, hostname, port)
routeDns(tunnelName, hostname)

console.log(`Cloudflare tunnel config: ${configPath}`)
console.log(`Hostname: https://${hostname}`)
console.log('Next: bun run web:cloudflare')

type Tunnel = {
  id: string
  name?: string
}

function findTunnel(name: string): Tunnel | null {
  const result = run('cloudflared', ['tunnel', 'list', '--name', name, '--output', 'json'], { allowFailure: true })
  if (!result.ok || !result.stdout.trim()) return null
  try {
    const values = JSON.parse(result.stdout)
    const first = Array.isArray(values) ? values.find((item: any) => item.name === name || item.Name === name) : undefined
    const id = first?.id ?? first?.ID ?? first?.uuid ?? first?.UUID
    return id ? { id, name } : null
  } catch {
    return null
  }
}

function createTunnel(name: string): Tunnel {
  const result = run('cloudflared', ['tunnel', 'create', '--output', 'json', name])
  try {
    const value = JSON.parse(result.stdout)
    const id = value.id ?? value.ID ?? value.uuid ?? value.UUID
    if (id) return { id, name }
  } catch {}

  const id = result.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
    ?? result.stderr.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
  if (!id) fail('cloudflared tunnel create 결과에서 tunnel id를 찾지 못했습니다.')
  return { id, name }
}

function writeConfig(path: string, tunnelId: string, credentialsFile: string, appHostname: string, appPort: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    'ingress:',
    `  - hostname: ${appHostname}`,
    `    service: http://127.0.0.1:${appPort}`,
    '  - service: http_status:404',
    '',
  ].join('\n'))
}

function routeDns(name: string, appHostname: string): void {
  const args = ['tunnel', 'route', 'dns', name, appHostname]
  if (env.CODEX_WEB_OVERWRITE_DNS === 'true') args.push('--overwrite-dns')
  run('cloudflared', args)
}

function commandOk(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0
}

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  const ok = result.status === 0
  if (!ok && !options.allowFailure) fail([`Command failed: ${command} ${args.join(' ')}`, result.stderr, result.stdout].filter(Boolean).join('\n'))
  return { ok, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

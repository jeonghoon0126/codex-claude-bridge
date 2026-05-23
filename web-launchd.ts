#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'

const label = 'com.wjh.codex-mobile-web'
const repo = '/Users/wjh/codex-claude-bridge'
const bunPath = '/Users/wjh/.bun/bin/bun'
const codexPath = '/Users/wjh/.bun/bin/codex'
const launchPath = '/Users/wjh/.local/bin:/Users/wjh/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
const logDir = join(homedir(), '.codex-mobile-web')
const uid = process.getuid?.() ?? Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim())
const domain = `gui/${uid}`
const action = process.argv[2] ?? 'install'

if (action === 'install') install()
else if (action === 'uninstall') uninstall()
else if (action === 'status') status()
else fail(`unknown action: ${action}`)

function install(): void {
  if (!existsSync(bunPath)) fail(`bun 실행 파일을 찾지 못했습니다: ${bunPath}`)
  if (!existsSync(codexPath)) fail(`codex 실행 파일을 찾지 못했습니다: ${codexPath}`)
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(logDir, { recursive: true })
  writeFileSync(plistPath, plist(), { mode: 0o644 })
  unload(false)
  run('launchctl', ['bootstrap', domain, plistPath])
  run('launchctl', ['enable', `${domain}/${label}`])
  run('launchctl', ['kickstart', '-k', `${domain}/${label}`])
  console.log(`installed ${label}`)
}

function uninstall(): void {
  unload(false)
  try { unlinkSync(plistPath) } catch {}
  console.log(`uninstalled ${label}`)
}

function status(): void {
  run('launchctl', ['print', `${domain}/${label}`], true)
}

function unload(strict: boolean): void {
  const result = spawnSync('launchctl', ['bootout', domain, plistPath], { encoding: 'utf8' })
  if (strict && result.status !== 0) fail(result.stderr || result.stdout || 'launchctl bootout failed')
}

function run(command: string, args: string[], inherit = false): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  })
  if (result.status !== 0) fail(result.stderr || result.stdout || `${command} ${args.join(' ')} failed`)
}

function plist(): string {
  const command = `cd ${shellQuote(repo)} && CODEX_WEB_PRINT_PIN=false ${shellQuote(bunPath)} web-cloudflare.ts`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${escapeXml(command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repo}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'web-launchd.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'web-launchd.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_WEB_PRINT_PIN</key>
    <string>false</string>
    <key>BUN_EXECUTABLE</key>
    <string>${bunPath}</string>
    <key>CODEX_APP_SERVER_COMMAND</key>
    <string>${codexPath}</string>
    <key>PATH</key>
    <string>${launchPath}</string>
  </dict>
</dict>
</plist>
`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

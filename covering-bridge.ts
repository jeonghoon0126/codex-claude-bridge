#!/usr/bin/env bun
/**
 * covering-bridge — Room manager CLI for the Codex-Claude multi-room bridge.
 */

import { createInterface, emitKeypressEvents } from 'readline'
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { ROLE_TEMPLATES, TEMPLATE_KEYS } from './role-templates.ts'
import { routedWheelDownCommand, routedWheelUpCommand } from './tmux-mouse-bindings.ts'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const BRIDGE_DIR = new URL('.', import.meta.url).pathname
const SELF_PATH = new URL(import.meta.url).pathname
const TMUX_LAYOUT_SCRIPT = `${BRIDGE_DIR}scripts/cbridge-tmux-layout`
const CBRIDGE_FOCUS_SCRIPT = `${BRIDGE_DIR}scripts/cbridge-focus-room`
const CBRIDGE_MOUSE_SCRIPT = `${BRIDGE_DIR}scripts/cbridge-mouse`
const CBRIDGE_LOAD_GOVERNOR_SCRIPT = `${BRIDGE_DIR}scripts/cbridge-load-governor`
const VERSION = 'v0.4'
const PAIR_MODE = process.env.CODEX_BRIDGE_PAIR === 'codex-codex' ? 'codex-codex' : 'codex-claude'
const RESPONDER_LABEL = PAIR_MODE === 'codex-codex' ? 'codex-peer' : 'claude'
const HEADER_LABEL = PAIR_MODE === 'codex-codex' ? 'Codex · Codex Bridge' : 'Codex · Claude Bridge'
const DEFAULT_WORKDIR = process.env.CODEX_BRIDGE_CWD ?? process.env.HOME ?? process.cwd()
const DASHBOARD_REFRESH_MS = Math.max(1000, envNumber('CODEX_BRIDGE_REFRESH_MS', 1500))
const PANE_TITLE_HEADER_REFRESH_MS = Math.max(
  2000,
  envNumber('CODEX_BRIDGE_PANE_HEADER_REFRESH_MS', 15_000),
)
const PANE_TITLE_WATCH_REFRESH_MS = Math.max(
  5000,
  envNumber('CODEX_BRIDGE_PANE_TITLE_WATCH_MS', 15_000),
)
const SESSION_FILE_REFRESH_MS = Math.max(5000, envNumber('CODEX_BRIDGE_SESSION_FILE_REFRESH_MS', 15_000))
const LEADER_UNREAD_RESTORE_MS = Math.max(60_000, envNumber('CBRIDGE_LEADER_UNREAD_RESTORE_MS', 15 * 60 * 1000))
const COMPACT_SUMMARY_MAX_CHARS = Math.max(12, envNumber('CBRIDGE_COMPACT_SUMMARY_MAX_CHARS', 36))
const MAC_DIALOG_FALLBACK_SECONDS = Math.max(1, envNumber('CBRIDGE_MAC_DIALOG_FALLBACK_SECONDS', 5))
const BRIDGE_STATE_DIR = process.env.CBRIDGE_STATE_DIR ?? `${process.env.HOME}/.codex-claude-bridge`
const SLACK_SYNC_STATE_PATH = process.env.CBRIDGE_SLACK_STATE_PATH ?? `${BRIDGE_STATE_DIR}/slack-sync-state.json`
const PANE_TITLE_PID_PATH = '/tmp/cbridge-pane-title-updater.pid'
const PANE_TITLE_TMUX_SESSION = 'cbridge-pane-title-updater'
const PANE_TITLE_HEADER_VERSION = '17'
const CBRIDGE_LEADER_MAIN_SESSION = 'cbridge-leaders-main'
const DEFAULT_LEADER_TITLE_HEADER_WINDOWS = '*'
const LEADER_BORDER_TITLES = envFlag('CBRIDGE_LEADER_BORDER_TITLES', false)
const LEADER_TITLE_HEADER_WINDOWS = new Set(
  (process.env.CBRIDGE_LEADER_TITLE_HEADER_WINDOWS ?? DEFAULT_LEADER_TITLE_HEADER_WINDOWS)
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean),
)

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

type Room = {
  id: string
  createdAt: number
  claudeConnected: boolean
  codexConnected: boolean
  lastActivity: number
}

type LeaderPromptSummary = {
  roomId: string
  prompt: string
}

type PaneRole = 'leader' | 'peer'

type BridgeProcess = {
  roomId: string
  role: PaneRole
  agentPid: number
}

type PromptSummaryCache = {
  mtimeMs: number
  size: number
  prompt: string
}

type WorkLabelCache = {
  mtimeMs: number
  size: number
  label?: string
}

type CodexSessionFilesCache = {
  key: string
  expiresAt: number
  files: Map<number, string>
}

type SlackUsageCache = {
  mtimeMs: number
  size: number
  rooms: Set<string>
}

type LeaderUnreadState = {
  filePath: string
  completedKey: string
  ackClickToken: string
  unread: boolean
}

type LeaderCompletion = {
  key: string
  label: string
  completedAtMs: number
}

type TmuxPane = {
  target: string
  paneId: string
  sessionName: string
  windowName: string
  roomId: string
  paneIndex: number
  displayIndex: number
  ackClickToken: string
  panePid: number
  role: PaneRole
  roleLabel: string
  width: number
  height: number
  currentRoom: string
  currentWorkLabel: string
  currentPrompt: string
  currentUnread: string
  currentDisplayIndex: string
  currentTitleLine1: string
  currentTitleLine2: string
  currentBorderTitle: string
  currentSlackNotice: string
}

type TmuxTitleHeaderPane = {
  target: string
  paneId: string
  sessionName: string
  windowName: string
  headerFor: string
  version: string
  height: number
  title: string
  ackClickToken: string
}

// ── ANSI helpers ──

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  bcyan:   '\x1b[96m',
  green:   '\x1b[32m',
  bgreen:  '\x1b[92m',
  purple:  '\x1b[33m',   // orange (256-color fallback: yellow-ish)
  bpurple: '\x1b[38;5;208m',  // bright orange
  yellow:  '\x1b[33m',
  byellow: '\x1b[93m',
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
}

function vis(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '') }

const TITLE_HEADER_ELLIPSIS = '…'

/** Visual column width, accounting for CJK double-width characters. */
function visWidth(s: string): number {
  let w = 0
  for (const ch of vis(s)) {
    const cp = ch.codePointAt(0) ?? 0
    w += (
      (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
      (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
      (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified
      (cp >= 0x3000 && cp <= 0x303F) ||  // CJK Symbols
      (cp >= 0xFF00 && cp <= 0xFF60)      // Fullwidth Forms
    ) ? 2 : 1
  }
  return w
}

export function titleHeaderDisplayWidth(s: string): number {
  return visWidth(s)
}

export function titleHeaderDisplayLine(value: string, maxWidth: number): string {
  const normalized = sanitizePaneTitle(value)
  const width = Math.max(0, Math.floor(maxWidth))
  if (!normalized || width <= 0) return ''
  if (titleHeaderDisplayWidth(normalized) <= width) return normalized

  const ellipsisWidth = titleHeaderDisplayWidth(TITLE_HEADER_ELLIPSIS)
  if (width <= ellipsisWidth) return '.'.repeat(width)

  let used = 0
  let out = ''
  for (const ch of normalized) {
    const charWidth = titleHeaderDisplayWidth(ch)
    if (used + charWidth > width - ellipsisWidth) break
    out += ch
    used += charWidth
  }
  return `${out.trimEnd()}${TITLE_HEADER_ELLIPSIS}`
}

export function shouldClearLeaderUnreadAfterRead(
  unread: boolean,
  becameUnread: boolean,
  clickedPaneAfterUnread: boolean,
  selectedPaneAfterUnread: boolean,
): boolean {
  return unread && !becameUnread && (clickedPaneAfterUnread || selectedPaneAfterUnread)
}

function rpad(s: string, n: number) {
  const diff = n - visWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}

function truncateVisible(s: string, maxWidth: number): string {
  if (visWidth(s) <= maxWidth) return s
  let width = 0
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const chWidth = (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0xFF00 && cp <= 0xFF60)
    ) ? 2 : 1
    if (width + chWidth > maxWidth - 1) break
    out += ch
    width += chWidth
  }
  return `${out}…`
}

function takeVisible(s: string, maxWidth: number): [string, string] {
  if (maxWidth <= 0) return ['', s]
  let width = 0
  let out = ''
  let index = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const chWidth = (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0xFF00 && cp <= 0xFF60)
    ) ? 2 : 1
    if (width + chWidth > maxWidth) break
    out += ch
    width += chWidth
    index += ch.length
  }
  return [out.trimEnd(), s.slice(index).trimStart()]
}

function titleLineWithPrefix(prefixText: string, title: string, width: number): string {
  const lineWidth = Math.max(18, width - 2)
  const prefix = prefixText ? `${prefixText} · ` : ''
  return titleHeaderDisplayLine(`${prefix}${title}`, lineWidth)
}

function titleLines(prefixText: string, prompt: string, width: number): [string, string] {
  const lineWidth = Math.max(18, width - 2)
  const explicitLines = prompt
    .split(/\n+/)
    .map(line => sanitizePaneTitle(line))
    .filter(Boolean)
  if (explicitLines.length >= 2) {
    return [
      titleLineWithPrefix(prefixText, explicitLines[0] ?? '', width),
      titleHeaderDisplayLine(explicitLines[1] ?? '', lineWidth),
    ]
  }

  const normalizedPrompt = sanitizePaneTitle(prompt)
  const prefix = prefixText ? `${prefixText} · ` : ''
  return [titleHeaderDisplayLine(`${prefix}${normalizedPrompt}`, lineWidth), '']
}

function completedAnswerTitleLines(prompt: string, width: number, prefixText = ''): [string, string] {
  return titleLines(prefixText, prompt, width)
}

function isInternalRoomId(value: string): boolean {
  return /^(LEADER|PEER)-\d+$/i.test(value)
}

function isIssueLikeId(value: string): boolean {
  return /^[A-Z]{2,10}-\d+$/.test(value) && !isInternalRoomId(value)
}

function extractWorkLabelFromText(value: string): string | undefined {
  const text = sanitizePaneTitle(value)
  const docMatches = [
    ...text.matchAll(/\b([A-Z]{2,10}-\d+)[^/\s`'"]*\.(?:task-state|linear)\.md\b/g),
  ]
  for (let i = docMatches.length - 1; i >= 0; i--) {
    const label = docMatches[i]?.[1]
    if (label && isIssueLikeId(label)) return label
  }

  const issueMatches = [...text.matchAll(/\b([A-Z]{2,10}-\d+)\b/g)]
  for (let i = issueMatches.length - 1; i >= 0; i--) {
    const label = issueMatches[i]?.[1]
    if (label && isIssueLikeId(label)) return label
  }

  return undefined
}

function titlePrefixForPane(pane: TmuxPane, roomId: string, slackActive = false): string {
  const parts = [pane.roleLabel]
  if (pane.role === 'leader' && slackActive) parts.push('Slack 사용 중')
  if (!isInternalRoomId(roomId) && roomId !== pane.roleLabel) parts.push(roomId)
  return parts.join(' · ')
}

const MCP_JSON_PATH = `${process.env.HOME}/.mcp.json`
const CODEX_HOME_DIR = process.env.CBRIDGE_CODEX_HOME ?? process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`
const CODEX_STATE_DB_PATH = `${CODEX_HOME_DIR}/state_5.sqlite`

function updateVscodeMcp(roomId: string): void {
  try {
    const existing = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf8'))
    const server = existing?.mcpServers?.['codex-bridge']
    if (!server) return
    server.env = { ...(server.env ?? {}), CODEX_BRIDGE_ROOM: roomId }
    writeFileSync(MCP_JSON_PATH, JSON.stringify(existing, null, 2) + '\n')
    process.stderr.write(`[covering-bridge] ~/.mcp.json updated: room=${roomId}\n`)
  } catch {}
}


const BOX = 54
function boxTop()    { return `  ${C.gray}╭${'─'.repeat(BOX)}╮${C.reset}` }
function boxBottom() { return `  ${C.gray}╰${'─'.repeat(BOX)}╯${C.reset}` }
function boxRow(content: string) {
  const pad = BOX - visWidth(content)
  return `  ${C.gray}│${C.reset}${content}${' '.repeat(Math.max(0, pad))}${C.gray}│${C.reset}`
}
function divider() { return `  ${C.gray}${'─'.repeat(BOX)}${C.reset}` }

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type TerminalComposeKey = {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

type TerminalComposeAttachment = {
  path: string
  isImage: boolean
}

type TerminalComposeMessage = {
  text: string
  attachments: TerminalComposeAttachment[]
}

const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic', '.avif'])

export function isTerminalComposeNewlineKey(sequence: string, key: TerminalComposeKey = {}): boolean {
  const name = key.name ?? ''
  if (name !== 'return' && name !== 'enter') return false
  if (key.shift || key.meta) return true
  if (sequence === '\x1b\r' || sequence === '\x1b\n') return true
  return /^\x1b\[(?:13;[2-9][0-9]*u|27;[2-9][0-9]*;13~)$/.test(sequence)
}

function normalizeAttachmentPath(raw: string, home = process.env.HOME ?? ''): string {
  let value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      value = value.replace(/^file:\/\//, '')
    }
  }
  value = value.replace(/\\([\\ ])/g, '$1')
  if (value === '~') return home
  if (home && value.startsWith('~/')) return `${home}${value.slice(1)}`
  return value
}

function isImageAttachmentPath(path: string): boolean {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 && IMAGE_ATTACHMENT_EXTENSIONS.has(lower.slice(dot))
}

export function formatTerminalComposeMessage(raw: string, home = process.env.HOME ?? ''): TerminalComposeMessage {
  const attachments: TerminalComposeAttachment[] = []
  const bodyLines: string[] = []

  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const attachMatch = line.match(/^\s*\/(?:attach|image)\s+(.+?)\s*$/i)
    if (attachMatch?.[1]) {
      const path = normalizeAttachmentPath(attachMatch[1], home)
      attachments.push({ path, isImage: isImageAttachmentPath(path) })
      continue
    }
    bodyLines.push(line)
  }

  const body = bodyLines.join('\n').trim()
  const attachmentText = attachments
    .map(item => `- ${item.isImage ? '첨부 이미지' : '첨부 파일'}: ${item.path}`)
    .join('\n')
  const text = [
    body || (attachments.length > 0 ? '첨부 파일을 확인해줘.' : ''),
    attachmentText ? `첨부:\n${attachmentText}` : '',
  ].filter(Boolean).join('\n\n').trim()

  return { text, attachments }
}

// ── Bridge server management ──

async function isBridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(2000) })
    return res.ok && Array.isArray(await res.json())
  } catch { return false }
}

async function startBridgeServer(): Promise<void> {
  const serverPath = `${BRIDGE_DIR}bridge-server.ts`
  const proc = Bun.spawn(['bun', serverPath], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  proc.unref()
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(300)
    if (await isBridgeRunning()) return
  }
  throw new Error(`Bridge server did not start. Check: bun ${serverPath}`)
}

async function ensureBridge(): Promise<void> {
  if (await isBridgeRunning()) return
  await startBridgeServer()
}

// ── Room API ──

async function getRooms(): Promise<Room[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data as Room[] : []
  } catch { return [] }
}

async function closeRoom(roomId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BRIDGE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3000) },
    )
    return res.status === 204
  } catch { return false }
}

// ── Display ──

type TerminalSessions = Map<string, { claude: number[]; codex: number[] }>

const promptSummaryCache = new Map<string, PromptSummaryCache>()
const leaderUnreadByPane = new Map<string, LeaderUnreadState>()
const activeLeaderPaneByWindow = new Map<string, string>()
const leaderTabTitleBySession = new Map<string, string>()
const terminalAppTabTitleByWindow = new Map<string, string>()
const codexSessionFileByPid = new Map<number, string>()
const rolloutPathByThreadId = new Map<string, string | undefined>()
const workLabelCache = new Map<string, WorkLabelCache>()
const tmuxOptionWriteCache = new Map<string, string>()
let codexSessionFilesCache: CodexSessionFilesCache | undefined
let slackUsageCache: SlackUsageCache | undefined
let tmuxLeaderLayoutMenuConfigured = false

function roomIdFromProcessLine(line: string): string | undefined {
  const raw = line.match(/\bCODEX_BRIDGE_ROOM=("[^"]+"|'[^']+'|\S+)/)?.[1]
  return raw?.replace(/^['"]|['"]$/g, '')
}

function pidFromProcessLine(line: string): number | undefined {
  const pid = Number(line.trim().match(/^(\d+)/)?.[1])
  return Number.isFinite(pid) ? pid : undefined
}

function ppidFromProcessLine(line: string): number | undefined {
  const ppid = Number(line.trim().match(/^\d+\s+(\d+)/)?.[1])
  return Number.isFinite(ppid) ? ppid : undefined
}

function getBridgeProcesses(): Map<number, BridgeProcess> {
  const result = new Map<number, BridgeProcess>()
  try {
    const out = spawnSync('ps', ['eww', '-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout ?? ''
    const lines = out.split('\n')
    for (const line of lines) {
      const isNodeLeader = /\bnode\s+\S*\/codex\s/.test(line)
      const isNativeLeader = !isNodeLeader && /\/(?:codex\/codex|bin\/codex)\s/.test(line)
      const isLeader = isNativeLeader || isNodeLeader
      const isPeer = /\bcodex-peer-agent\.ts\b/.test(line)
      if (!isLeader && !isPeer) continue
      const room = roomIdFromProcessLine(line)
      if (!room) continue
      const pid = pidFromProcessLine(line)
      if (!pid) continue
      result.set(pid, { roomId: room, role: isPeer ? 'peer' : 'leader', agentPid: pid })
      if (isNativeLeader) {
        const ppid = ppidFromProcessLine(line)
        if (ppid) result.set(ppid, { roomId: room, role: 'leader', agentPid: pid })
      }
    }
  } catch {}
  return result
}

function getLeaderCodexProcesses(): Map<number, string> {
  const result = new Map<number, string>()
  for (const [pid, processInfo] of getBridgeProcesses()) {
    if (processInfo.role === 'leader') result.set(processInfo.agentPid, processInfo.roomId)
  }
  return result
}

function codexThreadIdForPid(pid: number): string | undefined {
  try {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
    return command.match(/\bresume\s+([0-9a-f-]{36})\b/)?.[1]
  } catch {
    return undefined
  }
}

function rolloutPathForThreadId(threadId: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/.test(threadId)) return undefined
  if (rolloutPathByThreadId.has(threadId)) return rolloutPathByThreadId.get(threadId)

  try {
    const out = spawnSync('sqlite3', [
      '-noheader',
      CODEX_STATE_DB_PATH,
      `select rollout_path from threads where id='${threadId.replace(/'/g, "''")}' limit 1;`,
    ], { encoding: 'utf8' }).stdout?.trim()
    const path = out || undefined
    if (path) statSync(path)
    rolloutPathByThreadId.set(threadId, path)
    return path
  } catch {
    rolloutPathByThreadId.set(threadId, undefined)
    return undefined
  }
}

function getOpenCodexSessionFiles(pids: number[]): Map<number, string> {
  const result = new Map<number, string>()
  const mtimes = new Map<number, number>()
  const uniquePids = [...new Set(pids)].sort((a, b) => a - b)
  if (uniquePids.length === 0) return result

  const cacheKey = uniquePids.join(',')
  const now = Date.now()
  if (
    codexSessionFilesCache &&
    codexSessionFilesCache.key === cacheKey &&
    codexSessionFilesCache.expiresAt > now
  ) {
    return new Map(codexSessionFilesCache.files)
  }

  try {
    const out = spawnSync('lsof', ['-p', uniquePids.join(',')], { encoding: 'utf8' }).stdout ?? ''
    for (const line of out.split('\n')) {
      if (!line.endsWith('.jsonl')) continue
      const pid = Number(line.match(/^\S+\s+(\d+)\s/)?.[1])
      const pathStart = line.indexOf('/Users/')
      if (!Number.isFinite(pid) || pathStart < 0) continue
      const path = line.slice(pathStart)
      let mtimeMs = 0
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {}
      if (!result.has(pid) || mtimeMs >= (mtimes.get(pid) ?? 0)) {
        result.set(pid, path)
        mtimes.set(pid, mtimeMs)
        codexSessionFileByPid.set(pid, path)
      }
    }
  } catch {}

  for (const pid of uniquePids) {
    if (result.has(pid)) continue
    const cached = codexSessionFileByPid.get(pid)
    if (cached) {
      result.set(pid, cached)
      continue
    }
    const threadId = codexThreadIdForPid(pid)
    const rolloutPath = threadId ? rolloutPathForThreadId(threadId) : undefined
    if (rolloutPath) result.set(pid, rolloutPath)
  }
  codexSessionFilesCache = {
    key: cacheKey,
    expiresAt: now + SESSION_FILE_REFRESH_MS,
    files: new Map(result),
  }
  return result
}

function cleanUserPrompt(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  if (normalized.startsWith('# AGENTS.md instructions')) return undefined
  if (normalized.startsWith('<hook_prompt')) return undefined
  if (normalized.startsWith('<environment_context>')) return undefined
  if (normalized.startsWith('You are the responder in a Codex-Codex Bridge room')) return undefined

  const withoutSessionPath = normalized
    .replace(/\/Users\/wjh\/\S+?\.jsonl/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!withoutSessionPath) return undefined
  return withoutSessionPath
}

function isContextLightPrompt(prompt: string): boolean {
  if (prompt.length <= 12) return true
  return /^(아 |그럼|그래|좋아|최대한|어디에|이게 무슨 내용)/.test(prompt)
}

function isLowInformationWorkSummary(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return true
  if (/^(완료|완료했습니다|확인했습니다|수정했습니다|변경했습니다|저장했습니다|끝났습니다|올렸습니다|반영했습니다|적용했습니다|처리했습니다|맞다)[.]?$/.test(normalized)) return true
  if (/^(PR|링크|Linear|URL|파일)\s*:?\s*/.test(normalized)) return true
  if (/^(핵심은|요약|검증|테스트|다음|관련 문서|구조는 이렇게|지금 개선 방향은|수정한 핵심은)/.test(normalized)) return true
  return visWidth(normalized) < 12 && !/\b[A-Z]{2,10}-\d+\b/.test(normalized)
}

function cleanWorkSummaryText(raw: string): string | undefined {
  const text = vis(raw)
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_>#]/g, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  if (isLowInformationWorkSummary(text)) return undefined
  const summarized = text
    .replace(/직전 프롬프트를\s*(?:주는게 아니라|주지 말고)?/g, '직전 프롬프트 대신')
    .replace(/(?:해줘|해주세요|해주면 좋겠어|해주면 좋을 것 같아|좋을 것 같아)[.]?$/g, '')
    .replace(/보여주는게/g, '보여주기')
    .replace(/주는게 아니라/g, '대신')
    .replace(/\s+/g, ' ')
    .trim()
  return isLowInformationWorkSummary(summarized) ? undefined : summarized
}

function cleanAssistantTitleText(raw: string): string | undefined {
  const text = vis(raw)
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_>#]/g, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  if (/^(완료|확인|수정|변경|적용|처리)[.]?$/.test(text)) return undefined
  return text.replace(/[.。]+$/g, '').trim() || undefined
}

function assistantTitleDetailLine(raw: string): string | undefined {
  for (const rawLine of raw.split(/\n+/)) {
    const line = cleanAssistantTitleText(rawLine)
    if (line) return line
  }
  return cleanAssistantTitleText(raw)
}

function workSummaryLinesFromText(raw: string, maxLines = 2): string[] {
  const direct = directCompactSummaryLabel(raw)
  if (direct) return [direct]

  const lines: string[] = []
  const seen = new Set<string>()
  for (const rawLine of raw.split(/\n+/)) {
    const cleaned = cleanWorkSummaryText(rawLine)
    if (!cleaned) continue
    for (const part of cleaned.split(/(?<=[.!?。！？])\s+/)) {
      const line = cleanWorkSummaryText(part)
      if (!line || seen.has(line)) continue
      seen.add(line)
      lines.push(line.replace(/[.]$/g, ''))
      if (lines.length >= maxLines) return lines
    }
  }
  return lines
}

function promptWorkSummaryLines(prompts: string[]): string[] {
  const meaningful = prompts.filter(prompt => !isContextLightPrompt(prompt))
  const source = meaningful.length > 0 ? meaningful : prompts
  const lines: string[] = []
  const seen = new Set<string>()
  for (let i = source.length - 1; i >= 0; i--) {
    for (const line of workSummaryLinesFromText(source[i] ?? '', 2)) {
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
      if (lines.length >= 2) return lines
    }
  }
  const latest = source[source.length - 1] ?? ''
  const direct = directCompactSummaryLabel(latest)
  if (direct) return [direct]
  const title = promptTitleText(latest)
  return title ? [compactSummaryLabel(title)] : []
}

function promptTitleText(raw: string): string | undefined {
  const text = vis(raw)
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

function fitCompactLabel(label: string): string {
  const cleaned = label.replace(/\s+/g, ' ').trim()
  const chars = Array.from(cleaned)
  if (chars.length <= COMPACT_SUMMARY_MAX_CHARS) return cleaned
  return `${chars.slice(0, COMPACT_SUMMARY_MAX_CHARS - 1).join('')}…`
}

function summarySubjectLabel(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  const rules: Array<[RegExp, string]> = [
    [/LEADER-\d+|리더 세션|리더 헤더|답변 완료|2번째 줄|초록|푸시 알림|포커스|요약|헤더/, '리더 헤더'],
    [/covering-app\.slack|archives\/|Slack 메시지|슬랙 메시지|이건 삭제해/, 'Slack 메시지'],
    [/슬랙 리포트|Slack 리포트|제품팀_data|정정본|새 스레드|지면별 전환|HOME_POPUP|HOME_BANNER/, '슬랙 리포트'],
    [/CodeRabbit|코드래빗|PR 리뷰|리뷰 받/, 'CodeRabbit 리뷰'],
    [/홈 팝업|바텀시트|캐러셀 배너|혜택 배너|띠배너|지원금 지면/, '홈 팝업 분석'],
    [/D60.*CRM|CRM.*D60/, 'D60 CRM'],
    [/\bCRM\b|CRM을|CRM.*쏘|발송 주기/, 'CRM 발송'],
    [/계산.*문서|기준 문서|문서.*저장|\.md\b/, '계산 문서'],
    [/스프레드\s*시트|더미 데이터|신규 신청|신청자.*캐러셀/, '신청자 캐러셀'],
    [/Codex|코덱스/, 'Codex 세션'],
    [/구매처|센드비/, '구매처 센드비'],
    [/5천원|1만원|금액/, '금액 테스트'],
    [/머지|merge|PR\b/, 'PR 머지'],
  ]
  for (const [pattern, label] of rules) {
    if (pattern.test(normalized)) return label
  }
  return undefined
}

function summaryActionLabel(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  const rules: Array<[RegExp, string]> = [
    [/렉|느리|지연|버벅|클릭.*스크롤|스크롤.*클릭/, '클릭 스크롤 지연 개선'],
    [/스크롤.*안|휠|WheelUpPane|WheelDownPane|copy-mode/, '스크롤 복구'],
    [/15자.*내외|15자.*요약|요약.*너무.*짧|요약.*길이/, '15자 요약 조정'],
    [/어떤 분석|어떤 기능|어떤 문서|알 수 있게|대상.*표시|맥락.*표시/, '대상 표시 적용'],
    [/읽으면.*사라|답변 완료.*사라|읽음.*처리|읽음.*해제/, '읽음 완료 해제'],
    [/새 스레드|재적재|다시.*적재|올렸|올림/, '새 스레드 적재'],
    [/삭제/, '삭제 확인'],
    [/저장|문서.*작성|문서.*수정/, '저장 완료'],
    [/발송.*주기|주기.*제안|D60/, '발송 주기 제안'],
    [/클릭.*데이터|데이터.*확인|Mixpanel/, '데이터 확인'],
    [/빌드.*통과|diff.*통과|검사.*통과/, '검사 통과'],
    [/줄바꿈/, '줄바꿈 적용'],
    [/푸시.*알림|알림.*포커스|클릭.*포커스/, '알림 포커스 적용'],
    [/초록.*복구|초록.*표시|사라/, '초록 표시 복구'],
    [/잔상|스크롤백/, '잔상 제거'],
    [/정상.*확인|문제 없습니다|문제 없/, '정상 확인'],
    [/머지.*완료|merge.*완료/, '완료 확인'],
    [/검토.*끝|검토.*완료|리뷰/, '검토 완료'],
    [/수정|변경|조정|적용|보강|고쳤|바꿨/, '수정 적용'],
    [/분석|리포트/, '분석 정리'],
  ]
  for (const [pattern, label] of rules) {
    if (pattern.test(normalized)) return label
  }
  return undefined
}

function contextualCompactSummaryLabel(raw: string, context = ''): string | undefined {
  const combined = `${raw} ${context}`.replace(/\s+/g, ' ').trim()
  if (/스크롤.*안|휠|WheelUpPane|WheelDownPane|copy-mode/.test(combined)) {
    return fitCompactLabel('리더 헤더 스크롤 복구')
  }
  const subject = summarySubjectLabel(combined)
  const action = summaryActionLabel(raw) ?? summaryActionLabel(combined)
  if (!subject || !action) return undefined
  return fitCompactLabel(`${subject} ${action}`)
}

function directCompactSummaryLabel(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  const contextual = contextualCompactSummaryLabel(normalized)
  if (contextual) return contextual
  const rules: Array<[RegExp, string]> = [
    [/어떤 분석|어떤 기능|어떤 문서|알 수 있게/, '리더 헤더 대상 표시 적용'],
    [/15자.*내외|15자.*요약|짧은.*라벨|핵심만.*요약|요약.*너무.*짧/, '요약 길이 15자 내외 조정'],
    [/읽으면.*사라|답변 완료.*사라|읽음.*처리|읽음.*해제/, '읽음 처리 후 완료표시 해제'],
    [/정정본.*새 스레드|새 스레드.*올|수정.*불가능.*다시/, '정정본 새 스레드 재적재 완료'],
    [/아직.*그대|그댈|이렇게보이|예전.*헤더|잔상|4줄처럼/, '헤더 잔상 스크롤백 제거'],
    [/초록.*원인.*이렇게밖에|이렇게밖에.*안뜨|표시.*2배/, '요약 표시 길이 확대 조정'],
    [/2배.*떠|2배.*늘|30자|요약.*길이.*확대|더 떠야/, '요약 표시 길이 확대 조정'],
    [/초록색.*사라|초록.*표시.*사라|답변.*초록색|초록.*복구/, '답변 완료 초록표시 복구'],
    [/푸시.*알림|우측 상단.*알림|알림.*포커스|클릭.*리더.*포커스/, '푸시 알림 클릭 포커스 적용'],
    [/'반영'.*보|반영.*보이|요약.*반영/, '요약 오표시 라벨 보정 완료'],
    [/요약.*규칙.*넣|요약.*규칙.*적용|짧.*요약/, '요약 규칙 15자 내외 적용'],
    [/줄바꿈.*적용|줄바꿈.*변경|실제 줄바꿈/, '헤더 2번째 줄바꿈 적용'],
    [/빌드.*통과|공백.*통과|검사.*통과/, '빌드와 diff 검사 통과'],
    [/헤더.*유지.*확인/, '헤더 유지 상태 정상 확인'],
    [/구조.*변경|방식.*변경|바꿨습니다/, '헤더 구조 변경 적용 완료'],
    [/갱신.*프로세스.*재시작|프로세스.*재시작/, '헤더 갱신 프로세스 재시작'],
    [/실사용.*해결|해결됐습니다/, '실사용 문제 해결 확인 완료'],
    [/정상.*확인|정상 확인/, '정상 동작 상태 확인 완료'],
    [/구매처.*센드비|센드비/, '구매처 센드비 기준 확인'],
    [/5천원.*1만원|1만원.*5천원/, '5천원 1만원 금액 테스트'],
    [/계산.*문서|기준 문서.*계산/, '계산 기준 문서 저장 완료'],
    [/D60.*CRM|CRM.*D60/, 'D60 CRM 발송 주기 제안'],
    [/클릭.*데이터|데이터상.*클릭|Mixpanel/, '클릭 데이터 기준 확인 완료'],
    [/발송.*제거|제거.*발송/, '발송 제거 상태 확인 완료'],
    [/올려서.*머지|머지.*완료/, '머지 완료 후 상태 확인'],
  ]
  for (const [pattern, label] of rules) {
    if (pattern.test(normalized)) return fitCompactLabel(label)
  }
  return undefined
}

function compactSummaryLabel(raw: string): string {
  const direct = directCompactSummaryLabel(raw)
  if (direct) return direct

  const compacted = raw
    .replace(/^(네|응|맞습니다|맞아요|현재|이제|바로)[,. ]+/g, '')
    .replace(/\d+초 뒤에도\s*/g, '')
    .replace(/되는 것까지 확인했습니다[.]?$/g, ' 확인')
    .replace(/된 것까지 확인했습니다[.]?$/g, ' 확인')
    .replace(/까지 확인했습니다[.]?$/g, ' 확인')
    .replace(/확인했습니다[.]?$/g, ' 확인')
    .replace(/검사는 통과했습니다[.]?$/g, '검사 통과')
    .replace(/통과했습니다[.]?$/g, ' 통과')
    .replace(/바꿨습니다[.]?$/g, ' 변경')
    .replace(/변경했습니다[.]?$/g, ' 변경')
    .replace(/수정했습니다[.]?$/g, ' 수정')
    .replace(/적용했습니다[.]?$/g, ' 적용')
    .replace(/추가했습니다[.]?$/g, ' 추가')
    .replace(/제거했습니다[.]?$/g, ' 제거')
    .replace(/완료했습니다[.]?$/g, ' 완료')
    .replace(/해결됐습니다[.]?$/g, ' 해결')
    .replace(/정상 확인됐습니다[.]?$/g, ' 정상')
    .replace(/됐습니다[.]?$/g, '')
    .replace(/했습니다[.]?$/g, '')
    .replace(/입니다[.]?$/g, '')
    .replace(/들어갔습니다[.]?$/g, ' 적용')
    .replace(/유지되는 것/g, '유지')
    .replace(/검사는/g, '검사')
    .replace(/기준으로는/g, '기준')
    .replace(/와\s+/g, '·')
    .replace(/은\s+/g, ' ')
    .replace(/는\s+/g, ' ')
    .replace(/가\s+/g, ' ')
    .replace(/이\s+/g, ' ')
    .replace(/을\s+/g, ' ')
    .replace(/를\s+/g, ' ')
    .replace(/으로\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const withoutTrailingPunctuation = compacted.replace(/[.。!?！？]+$/g, '').trim()
  return fitCompactLabel(withoutTrailingPunctuation || raw.trim())
}

function oneLineWorkSummary(primary: string[], fallback: string[]): string {
  const seen = new Set<string>()
  const context = fallback.slice(0, 2).join(' ')
  for (const line of [...primary, ...fallback]) {
    const contextual = contextualCompactSummaryLabel(line, context)
    if (contextual) return contextual
    const direct = directCompactSummaryLabel(line)
    if (direct) return fitCompactLabel(direct)
    const cleaned = cleanWorkSummaryText(line)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    return compactSummaryLabel(cleaned)
  }
  return '직전 내용 확인 중'
}

function extractPromptText(record: any): string | undefined {
  if (record?.type === 'response_item' && record?.payload?.type === 'message' && record?.payload?.role === 'user') {
    const parts = Array.isArray(record.payload.content)
      ? record.payload.content
          .filter((item: any) => item?.type === 'input_text' || item?.type === 'text')
          .map((item: any) => String(item.text ?? ''))
      : []
    return parts.join(' ')
  }
  if (record?.type === 'event_msg' && record?.payload?.type === 'user_message') {
    return String(record.payload.message ?? '')
  }
  return undefined
}

function extractAssistantSummaryText(record: any): string | undefined {
  if (record?.type === 'event_msg' && record?.payload?.type === 'task_complete') {
    return String(record.payload.last_agent_message ?? '')
  }
  if (
    record?.type === 'response_item' &&
    record?.payload?.type === 'message' &&
    record.payload.role === 'assistant' &&
    record.payload.phase === 'final_answer'
  ) {
    const parts = Array.isArray(record.payload.content)
      ? record.payload.content
          .filter((item: any) => item?.type === 'output_text' || item?.type === 'text')
          .map((item: any) => String(item.text ?? ''))
      : []
    return parts.join(' ')
  }
  return undefined
}

function recordTimestampMs(record: any): number {
  const candidates = [
    record?.payload?.completed_at,
    record?.payload?.timestamp,
    record?.timestamp,
  ]
  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate ?? ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function latestPromptSummaryFromFile(path: string): string {
  try {
    const stat = statSync(path)
    const cached = promptSummaryCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.prompt

    let latestPrompt: string | undefined
    let latestPromptTimeMs = 0
    const previousPrompts: string[] = []
    const seen = new Set<string>()
    const assistantCandidates: Array<{ text: string; timeMs: number }> = []
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1, checked = 0; i >= 0 && checked < 360; i--, checked++) {
      try {
        const record = JSON.parse(lines[i] ?? '')
        if (!latestPrompt) {
          const assistantText = extractAssistantSummaryText(record)
          if (assistantText) assistantCandidates.push({ text: assistantText, timeMs: recordTimestampMs(record) })
        }

        const text = cleanUserPrompt(extractPromptText(record) ?? '')
        if (!text || seen.has(text)) continue
        seen.add(text)
        if (!latestPrompt) {
          latestPrompt = text
          latestPromptTimeMs = recordTimestampMs(record)
        } else {
          previousPrompts.unshift(text)
        }
        if (latestPrompt && previousPrompts.length >= 7 && assistantCandidates.length > 0) break
      } catch {}
    }

    const promptLine = promptTitleText(latestPrompt ?? '') ?? '최근 프롬프트 없음'
    const latestAssistantTexts = assistantCandidates
      .filter(candidate => !latestPromptTimeMs || (candidate.timeMs > 0 && candidate.timeMs >= latestPromptTimeMs))
      .map(candidate => candidate.text)
    const latestContentLines = latestAssistantTexts
      .flatMap(text => workSummaryLinesFromText(text, 1))
      .slice(0, 1)
    const assistantDetailLine = latestAssistantTexts
      .map(text => assistantTitleDetailLine(text))
      .find(Boolean)
    const previousPromptLines = promptWorkSummaryLines(previousPrompts)
    const summaryLine = assistantDetailLine
      ? (latestContentLines.length > 0 ? oneLineWorkSummary(latestContentLines, previousPromptLines) : assistantDetailLine)
      : '답변 작성 중'
    const prompt = `${promptLine}\n${summaryLine}`

    promptSummaryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, prompt })
    return prompt
  } catch {
    return '최근 프롬프트 확인 불가\n세션 로그 확인 필요'
  }
}

function latestWorkLabelFromFile(path: string): string | undefined {
  try {
    const stat = statSync(path)
    const cached = workLabelCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.label

    let label: string | undefined
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1, checked = 0; i >= 0 && checked < 80; i--, checked++) {
      const line = lines[i] ?? ''
      try {
        const text = cleanUserPrompt(extractPromptText(JSON.parse(line)) ?? '')
        label = text ? extractWorkLabelFromText(text) : undefined
        if (label) break
      } catch {}

      if (
        line.includes('.task-state.md') ||
        line.includes('.linear.md')
      ) {
        label = extractWorkLabelFromText(line)
        if (label) break
      }
    }
    workLabelCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, label })
    return label
  } catch {}
  return undefined
}

function completionLabelFromMessage(message: string): string {
  const lines = workSummaryLinesFromText(message, 1)
  if (lines[0]) return compactSummaryLabel(lines[0])
  return compactSummaryLabel(message) || '답변 완료'
}

function latestCompletedTurnFromFile(path: string): LeaderCompletion | undefined {
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1, checked = 0; i >= 0 && checked < 240; i--, checked++) {
      try {
        const record = JSON.parse(lines[i] ?? '')
        const payload = record?.payload
        if (record?.type !== 'event_msg' || payload?.type !== 'task_complete') continue
        const turnId = String(payload.turn_id ?? '')
        const completedAt = String(payload.completed_at ?? record.timestamp ?? '')
        const completedAtMs = Date.parse(completedAt)
        const lastMessage = String(payload.last_agent_message ?? '')
        return {
          key: `${turnId}:${completedAt}:${lastMessage.length}`,
          label: completionLabelFromMessage(lastMessage),
          completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : 0,
        }
      } catch {}
    }
  } catch {}
  return undefined
}

function shouldRestoreUnreadOnStart(completion: LeaderCompletion | undefined): boolean {
  if (!completion?.completedAtMs) return false
  const ageMs = Date.now() - completion.completedAtMs
  return ageMs >= 0 && ageMs <= LEADER_UNREAD_RESTORE_MS
}

function normalizedAckClickToken(token: string): string {
  const value = token.trim()
  return value && !value.includes('#{') ? value : ''
}

function combinedAckClickToken(...tokens: string[]): string {
  return tokens
    .map(normalizedAckClickToken)
    .filter(Boolean)
    .join('|')
}

function leaderSortKey(roomId: string): number {
  return Number(roomId.match(/\d+$/)?.[0] ?? 9999)
}

function leaderRoomDisplayLabel(roomId?: string, fallback = 'LEADER'): string {
  const match = roomId?.match(/^LEADER-(\d+)$/i)
  return match?.[1] ?? fallback
}

function slackRoomsInUse(): Set<string> {
  try {
    const stat = statSync(SLACK_SYNC_STATE_PATH)
    if (
      slackUsageCache &&
      slackUsageCache.mtimeMs === stat.mtimeMs &&
      slackUsageCache.size === stat.size
    ) {
      return slackUsageCache.rooms
    }

    const parsed = JSON.parse(readFileSync(SLACK_SYNC_STATE_PATH, 'utf8'))
    const rooms = new Set<string>()
    for (const [roomId, value] of Object.entries(parsed?.rooms ?? {})) {
      const room = String(roomId).toUpperCase()
      const state = value as { channel?: unknown; rootTs?: unknown }
      if (state.channel && state.rootTs) rooms.add(room)
    }
    slackUsageCache = { mtimeMs: stat.mtimeMs, size: stat.size, rooms }
    return rooms
  } catch {
    slackUsageCache = undefined
    return new Set()
  }
}

function roomUsesSlack(roomId: string): boolean {
  return slackRoomsInUse().has(roomId.toUpperCase())
}

function getLeaderPromptSummaries(): LeaderPromptSummary[] {
  const processes = getLeaderCodexProcesses()
  const files = getOpenCodexSessionFiles([...processes.keys()])
  const byRoom = new Map<string, LeaderPromptSummary & { mtimeMs: number; score: number }>()
  for (const [pid, roomId] of processes) {
    const path = files.get(pid)
    const prompt = path ? latestPromptSummaryFromFile(path) : '최근 프롬프트 확인 불가\n세션 로그 확인 필요'
    const mtimeMs = path ? statSync(path).mtimeMs : 0
    const score = prompt.startsWith('최근 프롬프트 없음') || prompt.startsWith('최근 프롬프트 확인 불가') ? 0 : 1
    const existing = byRoom.get(roomId)
    if (!existing || score > existing.score || (score === existing.score && mtimeMs > existing.mtimeMs)) {
      byRoom.set(roomId, { roomId, prompt, mtimeMs, score })
    }
  }
  return [...byRoom.values()]
    .map(({ roomId, prompt }) => ({ roomId, prompt }))
    .sort((a, b) => leaderSortKey(a.roomId) - leaderSortKey(b.roomId))
}

function isCbridgeTitleSession(sessionName: string): boolean {
  return (
    sessionName.startsWith('cbridge-leaders-') ||
    sessionName.startsWith('cbridge-peer-') ||
    sessionName === 'cbridge-peers'
  )
}

function shouldUseNativeTerminalSelection(sessionName: string): boolean {
  return false
}

function leaderWindowAllowsTitleHeader(windowName: string): boolean {
  return LEADER_TITLE_HEADER_WINDOWS.has('*') ||
    LEADER_TITLE_HEADER_WINDOWS.has('ALL') ||
    LEADER_TITLE_HEADER_WINDOWS.has(windowName.toUpperCase())
}

function shouldUsePaneTitleHeader(target: Pick<TmuxPane | TmuxTitleHeaderPane, 'sessionName' | 'windowName'>): boolean {
  if (target.sessionName.startsWith('cbridge-leaders-')) {
    return isLeaderWindowName(target.windowName) && leaderWindowAllowsTitleHeader(target.windowName)
  }
  return target.sessionName.startsWith('cbridge-peer-') || target.sessionName === 'cbridge-peers'
}

function peerLabelFromSession(sessionName: string, roomId?: string): string {
  const sessionMatch = sessionName.match(/^cbridge-peer-(.+)$/)?.[1]
  if (sessionMatch) return `PEER-${sessionMatch}`
  const roomMatch = roomId?.match(/^LEADER-(\d+)$/i)?.[1]
  if (roomMatch) return `PEER-${roomMatch}`
  return 'PEER'
}

function leaderLabelFromRoom(roomId?: string): string {
  return leaderRoomDisplayLabel(roomId)
}

function leaderWindowNameFromSession(sessionName: string): string | undefined {
  const linkedMatch = sessionName.match(/^cbridge-leaders-tab-([A-Z])$/)?.[1]
  if (linkedMatch) return linkedMatch
  return undefined
}

function isLeaderWindowName(value: string | undefined): value is string {
  return /^[A-Z]$/.test(value ?? '')
}

function getTmuxBridgePanes(processes: Map<number, BridgeProcess>): TmuxPane[] {
  const panes: TmuxPane[] = []
  try {
    const out = spawnSync('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{window_name}\t#{pane_index}\t#{@cbridge_restore_order}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{@cbridge_ack_click}\t#{@cbridge_room}\t#{@cbridge_work_label}\t#{@cbridge_prompt}\t#{@cbridge_unread}\t#{@cbridge_display_index}\t#{@cbridge_title_line_1}\t#{@cbridge_title_line_2}\t#{@cbridge_border_title}\t#{@cbridge_slack_notice}',
    ], { encoding: 'utf8' }).stdout ?? ''

    for (const line of out.split('\n')) {
      const [
        sessionName,
        rawWindowName,
        paneIndexRaw,
        restoreOrderRaw,
        paneId,
        panePidRaw,
        ,
        widthRaw,
        heightRaw,
        ackClickToken,
        currentRoom,
        currentWorkLabel,
        currentPrompt,
        currentUnread,
        currentDisplayIndex,
        currentTitleLine1,
        currentTitleLine2,
        currentBorderTitle,
        currentSlackNotice,
      ] = line.split('\t')
      const panePid = Number(panePidRaw)
      const paneIndex = Number(paneIndexRaw)
      const restoreOrder = Number(restoreOrderRaw)
      const width = Number(widthRaw)
      const height = Number(heightRaw)
      if (!Number.isFinite(panePid)) continue
      const windowName = rawWindowName || leaderWindowNameFromSession(sessionName ?? '') || ''
      const displayIndex = Number.isFinite(restoreOrder) && restoreOrder > 0
        ? restoreOrder
        : (Number.isFinite(paneIndex) ? paneIndex + 1 : 1)
      const processInfo = processes.get(panePid)
      if (sessionName?.startsWith('cbridge-leaders-')) {
        if (processInfo?.role !== 'leader') continue
        panes.push({
          sessionName,
          windowName,
          roomId: processInfo.roomId,
          paneId,
          paneIndex,
          displayIndex,
          ackClickToken: ackClickToken ?? '',
          panePid: processInfo.agentPid,
          role: 'leader',
          roleLabel: leaderLabelFromRoom(processInfo?.roomId),
          width: Number.isFinite(width) ? width : 80,
          height: Number.isFinite(height) ? height : 24,
          currentRoom: currentRoom ?? '',
          currentWorkLabel: currentWorkLabel ?? '',
          currentPrompt: currentPrompt ?? '',
          currentUnread: currentUnread ?? '',
          currentDisplayIndex: currentDisplayIndex ?? '',
          currentTitleLine1: currentTitleLine1 ?? '',
          currentTitleLine2: currentTitleLine2 ?? '',
          currentBorderTitle: currentBorderTitle ?? '',
          currentSlackNotice: currentSlackNotice ?? '',
          target: paneId,
        })
        continue
      }
      if (sessionName?.startsWith('cbridge-peer-') || sessionName === 'cbridge-peers') {
        if (processInfo?.role !== 'peer') continue
        panes.push({
          sessionName,
          windowName,
          roomId: processInfo.roomId,
          paneId,
          paneIndex,
          displayIndex,
          ackClickToken: ackClickToken ?? '',
          panePid: processInfo.agentPid,
          role: 'peer',
          roleLabel: peerLabelFromSession(sessionName, processInfo?.roomId),
          width: Number.isFinite(width) ? width : 80,
          height: Number.isFinite(height) ? height : 24,
          currentRoom: currentRoom ?? '',
          currentWorkLabel: currentWorkLabel ?? '',
          currentPrompt: currentPrompt ?? '',
          currentUnread: currentUnread ?? '',
          currentDisplayIndex: currentDisplayIndex ?? '',
          currentTitleLine1: currentTitleLine1 ?? '',
          currentTitleLine2: currentTitleLine2 ?? '',
          currentBorderTitle: currentBorderTitle ?? '',
          currentSlackNotice: currentSlackNotice ?? '',
          target: paneId,
        })
      }
    }
  } catch {}
  return panes
}

function uniqueTmuxPanes(panes: TmuxPane[]): TmuxPane[] {
  const byPaneId = new Map<string, TmuxPane>()
  for (const pane of panes) {
    const existing = byPaneId.get(pane.paneId)
    if (!existing || pane.sessionName === 'cbridge-leaders-main') {
      byPaneId.set(pane.paneId, pane)
    }
  }
  return [...byPaneId.values()]
}

function getTmuxLeaderPanes(): TmuxPane[] {
  const processes = getBridgeProcesses()
  return uniqueTmuxPanes(getTmuxBridgePanes(processes)).filter(pane => pane.role === 'leader')
}

function tmux(args: string[]): void {
  spawnSync('tmux', args, { stdout: 'ignore', stderr: 'ignore' })
}

function tmuxCached(cacheKey: string, value: string, args: string[]): void {
  if (tmuxOptionWriteCache.get(cacheKey) === value) return
  tmux(args)
  tmuxOptionWriteCache.set(cacheKey, value)
}

function setTmuxPaneOptionIfChanged(target: string, option: string, current: string, value: string): void {
  if (current === value) return
  tmux(['set-option', '-pt', target, option, value])
}

function setTmuxSessionOptionCached(sessionName: string, option: string, value: string): void {
  tmuxCached(`session:${sessionName}:${option}`, value, ['set-option', '-t', sessionName, option, value])
}

function unsetTmuxSessionOptionCached(sessionName: string, option: string): void {
  tmuxCached(`session:${sessionName}:${option}`, '<unset>', ['set-option', '-u', '-t', sessionName, option])
}

function setTmuxWindowOptionCached(target: string, option: string, value: string): void {
  tmuxCached(`window:${target}:${option}`, value, ['set-window-option', '-t', target, option, value])
}

function unsetTmuxWindowOptionCached(target: string, option: string): void {
  tmuxCached(`window:${target}:${option}`, '<unset>', ['set-window-option', '-u', '-t', target, option])
}

function tmuxWindowTargetForPane(pane: Pick<TmuxPane, 'sessionName' | 'windowName' | 'target'>): string {
  return pane.windowName ? `${pane.sessionName}:${pane.windowName}` : pane.target
}

function tmuxScript(script: string): void {
  spawnSync('tmux', ['source-file', '-'], {
    input: script,
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

function tmuxOutput(args: string[]): string {
  try {
    return spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? ''
  } catch {
    return ''
  }
}

function executablePath(name: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const found = spawnSync('/bin/zsh', ['-lc', `command -v ${shellQuote(name)} || true`], { encoding: 'utf8' })
      .stdout
      ?.trim()
    return found || undefined
  } catch {
    return undefined
  }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function clipboardImageTempDir(): string {
  const base = process.env.TMPDIR || '/tmp/'
  const dir = `${base.replace(/\/?$/, '/')}cbridge-compose`
  mkdirSync(dir, { recursive: true })
  return dir
}

function saveClipboardImageAttachment(): TerminalComposeAttachment | undefined {
  if (!existsSync('/usr/bin/osascript')) return undefined
  const formats = [
    { extension: 'png', appleClass: '«class PNGf»' },
    { extension: 'tiff', appleClass: '«class TIFF»' },
  ]

  for (const format of formats) {
    const path = `${clipboardImageTempDir()}/clipboard-${Date.now()}-${process.pid}.${format.extension}`
    const script = [
      'set outputFile to missing value',
      'try',
      `  set imageData to the clipboard as ${format.appleClass}`,
      `  set outputFile to open for access POSIX file ${appleScriptString(path)} with write permission`,
      '  set eof of outputFile to 0',
      '  write imageData to outputFile',
      '  close access outputFile',
      'on error errMsg',
      '  try',
      '    if outputFile is not missing value then close access outputFile',
      '  end try',
      '  error errMsg',
      'end try',
    ].join('\n')
    const result = spawnSync('/usr/bin/osascript', ['-e', script], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    if (result.status !== 0) continue
    try {
      if (statSync(path).size > 0) return { path, isImage: true }
    } catch {}
  }
  return undefined
}

function appendAttachmentDirective(text: string, path: string): string {
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  return `${text}${separator}/attach ${path}`
}

function showLeaderCompletionDialogFallback(
  title: string,
  subtitle: string,
  message: string,
  focusCommand: string,
): void {
  if (process.env.CBRIDGE_MAC_DIALOG_FALLBACK === '0') return
  if (!existsSync('/usr/bin/osascript')) return

  const body = [subtitle, message].filter(Boolean).join('\n')
  const script = [
    `set dialogResult to display dialog ${appleScriptString(body)}`,
    `with title ${appleScriptString(title)}`,
    'buttons {"OK"}',
    'default button "OK"',
    `giving up after ${MAC_DIALOG_FALLBACK_SECONDS}`,
    'if gave up of dialogResult is false then',
    `do shell script ${appleScriptString(focusCommand)}`,
    'end if',
  ].join('\n')

  try {
    const proc = spawn('/usr/bin/osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    })
    proc.unref()
  } catch {}
}

function macProcessRunning(processName: string): boolean {
  if (!existsSync('/usr/bin/osascript')) return false
  try {
    const result = spawnSync('/usr/bin/osascript', [
      '-e',
      `tell application "System Events" to exists process ${appleScriptString(processName)}`,
    ], { encoding: 'utf8' })
    return result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

function updateTerminalAppTabTitle(windowName: string, title: string): void {
  if (process.env.CBRIDGE_TERMINAL_TITLE_SYNC === '0') return
  if (!isLeaderWindowName(windowName)) return
  if (terminalAppTabTitleByWindow.get(windowName) === title) return
  if (!macProcessRunning('Terminal')) return

  const script = [
    'on run argv',
    '  set windowName to item 1 of argv',
    '  set baseTitle to "cbridge " & windowName',
    '  set nextTitle to item 2 of argv',
    '  tell application "Terminal"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        set customTitle to ""',
    '        set tabName to ""',
    '        try',
    '          set customTitle to custom title of t as text',
    '        end try',
    '        try',
    '          set tabName to name of t as text',
    '        end try',
    '        if customTitle starts with baseTitle or tabName starts with baseTitle then',
    '          set custom title of t to nextTitle',
    '          return "1"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  return "0"',
    'end run',
  ].join('\n')

  try {
    spawnSync('/usr/bin/osascript', ['-', windowName, safeTerminalTitle(title)], {
      input: script,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    terminalAppTabTitleByWindow.set(windowName, title)
  } catch {}
}

function notifyLeaderCompletion(pane: TmuxPane, roomId: string, label: string): void {
  if (process.env.CBRIDGE_MAC_NOTIFY === '0') return
  if (!/^LEADER-\d+$/i.test(roomId)) return

  const title = `${roomId} 답변 완료`
  const subtitle = `cbridge ${pane.windowName} · ${pane.displayIndex}번`
  const message = label || '답변 완료'
  const focusCommand = `${shellQuote(CBRIDGE_FOCUS_SCRIPT)} ${shellQuote(roomId)}`
  const terminalNotifier = executablePath('terminal-notifier', [
    '/opt/homebrew/bin/terminal-notifier',
    '/usr/local/bin/terminal-notifier',
  ])

  if (terminalNotifier) {
    spawnSync(terminalNotifier, [
      '-title', title,
      '-subtitle', subtitle,
      '-message', message,
      '-group', `cbridge-${roomId}`,
      '-execute', focusCommand,
      '-ignoreDnD',
      '-sound', 'Pop',
    ], { stdout: 'ignore', stderr: 'ignore' })
    showLeaderCompletionDialogFallback(title, subtitle, message, focusCommand)
    return
  }

  if (existsSync('/usr/bin/osascript')) {
    spawnSync('/usr/bin/osascript', [
      '-e',
      `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} subtitle ${appleScriptString(subtitle)}`,
    ], { stdout: 'ignore', stderr: 'ignore' })
    showLeaderCompletionDialogFallback(title, subtitle, message, focusCommand)
  }
}

function getSelectedLeaderPanesByWindow(): Map<string, string> {
  const selected = new Map<string, string>()
  const out = tmuxOutput(['list-clients', '-F', '#{client_session}\t#{window_name}\t#{pane_id}'])
  for (const line of out.split('\n')) {
    const [sessionName, windowName, paneId] = line.split('\t')
    if (!paneId?.startsWith('%')) continue
    const sessionWindowName = sessionName === CBRIDGE_LEADER_MAIN_SESSION
      ? windowName
      : leaderWindowNameFromSession(sessionName ?? '')
    if (isLeaderWindowName(sessionWindowName)) {
      selected.set(sessionWindowName, paneId)
    }
  }
  return selected
}

function safeTerminalTitle(value: string): string {
  return value
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function updateAttachedLeaderTabTitles(unreadByWindow: Map<string, Set<number>>): void {
  const clients = tmuxOutput(['list-clients', '-F', '#{client_session}\t#{client_tty}'])
  for (const line of clients.split('\n')) {
    const [sessionName, tty] = line.split('\t')
    const windowName = leaderWindowNameFromSession(sessionName ?? '')
    if (!windowName || !tty?.startsWith('/dev/tty')) continue

    const unreadNumbers = [...(unreadByWindow.get(windowName) ?? new Set<number>())]
      .sort((a, b) => a - b)
    const title = unreadNumbers.length > 0
      ? `cbridge ${windowName} 새:${unreadNumbers.join(',')}`
      : `cbridge ${windowName}`

    setTmuxSessionOptionCached(sessionName, '@cbridge_tab_title', title)
    setTmuxSessionOptionCached(sessionName, '@cbridge_unread_panes', unreadNumbers.join(','))
    const titleCacheKey = `${sessionName}:${tty}`
    if (leaderTabTitleBySession.get(titleCacheKey) === title) continue
    leaderTabTitleBySession.set(titleCacheKey, title)
    try {
      writeFileSync(tty, `\x1b]0;${safeTerminalTitle(title)}\x1b\\`, { flag: 'a' })
    } catch {}
    updateTerminalAppTabTitle(windowName, title)
  }
}

function updateLeaderUnreadState(
  pane: TmuxPane,
  filePath: string | undefined,
  roomId: string,
  headerAckClickToken = '',
  selectedPaneAfterUnread = false,
): boolean {
  if (!filePath) {
    leaderUnreadByPane.delete(pane.paneId)
    return false
  }

  const ackClickToken = combinedAckClickToken(pane.ackClickToken, headerAckClickToken)
  const completion = latestCompletedTurnFromFile(filePath)
  const completedKey = completion?.key ?? ''
  let state = leaderUnreadByPane.get(pane.paneId)
  if (!state) {
    const unread = pane.currentUnread === '1' || shouldRestoreUnreadOnStart(completion)
    state = { filePath, completedKey, ackClickToken, unread }
    leaderUnreadByPane.set(pane.paneId, state)
    return unread
  }

  if (filePath !== state.filePath) {
    const unread = pane.currentUnread === '1' || shouldRestoreUnreadOnStart(completion)
    state.filePath = filePath
    state.completedKey = completedKey
    state.ackClickToken = ackClickToken
    state.unread = unread
    return unread
  }

  let becameUnread = false
  if (completedKey && completedKey !== state.completedKey) {
    state.completedKey = completedKey
    state.unread = true
    becameUnread = true
    notifyLeaderCompletion(pane, roomId, completion?.label ?? '답변 완료')
  }

  const clickedPaneAfterUnread = ackClickToken !== '' && ackClickToken !== state.ackClickToken
  if (shouldClearLeaderUnreadAfterRead(state.unread, becameUnread, clickedPaneAfterUnread, selectedPaneAfterUnread)) {
    state.unread = false
  }
  state.ackClickToken = ackClickToken

  return state.unread
}

function tmuxDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function requireClickToChooseTmuxMenu(menuCommand: string): string {
  if (!menuCommand.startsWith('display-menu ')) return menuCommand
  if (/^display-menu\s+-\S*O(?:\s|$)/.test(menuCommand) || /\s-O(?:\s|$)/.test(menuCommand)) return menuCommand
  return menuCommand.replace(/^display-menu\s+/, 'display-menu -O ')
}

function tmuxMenuWithItems(items: string): string {
  return [
    'display-menu',
    '-O',
    '-T', tmuxDoubleQuote('리더 레이아웃'),
    '-t', '=',
    '-x', 'M',
    '-y', 'M',
    items,
  ].join(' ')
}

function prependTmuxMenuItems(menuCommand: string, items: string): string {
  if (menuCommand.startsWith('display-menu ')) {
    const injected = menuCommand.replace(/(-y\s+M)(\s+)/, `$1 ${items}$2`)
    if (injected !== menuCommand) return requireClickToChooseTmuxMenu(injected)
  }
  return tmuxMenuWithItems(items)
}

function targetTmuxMenuAtCapturedRightClick(menuCommand: string): string {
  return menuCommand
    .replace(/^display-menu\s+/, 'display-menu -M -c #{@cbridge_right_click_client} ')
    .replace(/\s-t\s*=/g, ' -t #{@cbridge_right_click_pane}')
    .replace(/\s-x\s+M\s+-y\s+M/, ' -x #{@cbridge_right_click_x} -y #{@cbridge_right_click_y}')
    .replace(/#\{pane_id\}/g, '#{@cbridge_right_click_pane}')
    .replace(/#\{session_name\}/g, '#{@cbridge_right_click_session}')
    .replace(/#\{window_index\}/g, '#{@cbridge_right_click_window}')
}

function captureRightClickTmuxMenuTarget(): string {
  return [
    'set-option -Fgq @cbridge_right_click_client "#{client_tty}"',
    'set-option -Fgq @cbridge_right_click_pane "#{pane_id}"',
    'set-option -Fgq @cbridge_right_click_x "#{mouse_x}"',
    'set-option -Fgq @cbridge_right_click_y "#{mouse_y}"',
    'set-option -Fgq @cbridge_right_click_session "#{session_name}"',
    'set-option -Fgq @cbridge_right_click_window "#{window_index}"',
    'select-pane -t =',
  ].join(' ; ')
}

function openTmuxMenuAfterRightClick(menuCommand: string): string {
  return [
    captureRightClickTmuxMenuTarget(),
    `run-shell -b -d 0.16 -C ${tmuxDoubleQuote(targetTmuxMenuAtCapturedRightClick(menuCommand))}`,
  ].join(' ; ')
}

function configureTmuxLeaderLayoutMenu(): void {
  if (tmuxLeaderLayoutMenuConfigured) return
  const defaultPaneMenu = tmuxOutput(['list-keys', '-T', 'root', 'M-MouseDown3Pane'])
    .replace(/^bind-key -T root M-MouseDown3Pane\s+/, '')
    .trim() || 'send-keys -M'
  const newThreadCommand = 'select-pane -t = \\; send-keys -t = /new Enter'
  const composeCommand = `display-popup -E -w 92% -h 82% -T ${tmuxDoubleQuote('메시지 작성')} ${tmuxDoubleQuote(`${BRIDGE_DIR}scripts/cbridge-compose "#{pane_id}" "#{@cbridge_header_for}"`)}`
  const layoutCommand = (layout: 'equal' | '4x1' | '2x2' | '4x2' | '2x6' | 'leader-left' | 'leader-right' | 'leader-remove') =>
    `run-shell -b ${shellQuote(`${TMUX_LAYOUT_SCRIPT} ${layout} "#{session_name}:#{window_index}" "#{pane_id}"`)}`
  const leaderMenuItems = [
    tmuxDoubleQuote('메시지 작성'), 'm', tmuxDoubleQuote(composeCommand),
    tmuxDoubleQuote('new'), 'n', tmuxDoubleQuote(newThreadCommand),
    tmuxDoubleQuote(''),
    tmuxDoubleQuote('균등 정렬'), 'e', tmuxDoubleQuote(layoutCommand('equal')),
    tmuxDoubleQuote('4열 1행 (자동 종료 없음)'), '4', tmuxDoubleQuote(layoutCommand('4x1')),
    tmuxDoubleQuote('2행 2열 (자동 종료 없음)'), '2', tmuxDoubleQuote(layoutCommand('2x2')),
    tmuxDoubleQuote('6행 2열 (자동 종료 없음)'), '6', tmuxDoubleQuote(layoutCommand('2x6')),
    tmuxDoubleQuote(''),
    tmuxDoubleQuote('추가 리더 왼쪽 생성'), '[', tmuxDoubleQuote(layoutCommand('leader-left')),
    tmuxDoubleQuote('추가 리더 오른쪽 생성'), ']', tmuxDoubleQuote(layoutCommand('leader-right')),
    tmuxDoubleQuote('추가 리더 균등 복귀'), 'x', tmuxDoubleQuote(layoutCommand('leader-remove')),
    tmuxDoubleQuote(''),
  ].join(' ')
  const leaderMenu = tmuxMenuWithItems(leaderMenuItems)
  const leaderMenuAfterRightClick = openTmuxMenuAfterRightClick(leaderMenu)
  const mouseCommand = (action: 'wheel-up' | 'wheel-down') => {
    const args = `${CBRIDGE_MOUSE_SCRIPT} ${action} "#{pane_id}" "#{@cbridge_header_for}"`
    return `run-shell ${shellQuote(args)}`
  }
  const leaderSessionCondition = '#{m/r:^cbridge-leaders-,#{session_name}}'
  const resumeLeaderWindowCommand = `run-shell -b ${tmuxDoubleQuote(`${CBRIDGE_LOAD_GOVERNOR_SCRIPT} --resume-window "#{window_name}"`)}`
  const leaderMouseDownPaneCommand = tmuxDoubleQuote(`${resumeLeaderWindowCommand} ; select-pane -t = ; send-keys -M`)
  const leaderMouseDownBorderCommand = tmuxDoubleQuote(`${resumeLeaderWindowCommand} ; select-pane -t =`)
  const defaultMouseDownPaneCommand = tmuxDoubleQuote('select-pane -t = ; send-keys -M')
  const defaultMouseDownBorderCommand = tmuxDoubleQuote('select-pane -t =')
  const bridgeWheelUpCommand = routedWheelUpCommand({
    headerWheelCommand: mouseCommand('wheel-up'),
    leaderSessionCondition,
    quote: shellQuote,
  })
  const bridgeWheelDownCommand = routedWheelDownCommand({
    headerWheelCommand: mouseCommand('wheel-down'),
    leaderSessionCondition,
    quote: shellQuote,
  })

  tmuxScript([
    `bind-key m if-shell -F '${leaderSessionCondition}' ${tmuxDoubleQuote(composeCommand)} ''`,
    `bind-key -T root MouseDown1Pane if-shell -F '${leaderSessionCondition}' ${leaderMouseDownPaneCommand} ${defaultMouseDownPaneCommand}`,
    `bind-key -T root MouseDown1Border if-shell -F '${leaderSessionCondition}' ${leaderMouseDownBorderCommand} ${defaultMouseDownBorderCommand}`,
    `bind-key -T root MouseDrag1Pane if-shell -F '#{m/r:^cbridge-leaders-,#{session_name}}' 'if-shell -F "#{pane_in_mode}" "send-keys -M" "copy-mode -M"' 'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'`,
    `bind-key -T root WheelUpPane ${bridgeWheelUpCommand}`,
    `bind-key -T root WheelDownPane ${bridgeWheelDownCommand}`,
  ].join('\n'))
  tmux(['unbind-key', '-T', 'root', 'MouseUp1Pane'])
  tmux(['unbind-key', '-T', 'root', 'MouseUp3Pane'])
  tmux(['unbind-key', '-T', 'root', 'MouseUp3Border'])
  tmux(['unbind-key', '-T', 'root', 'MouseDragEnd3Pane'])
  tmux(['unbind-key', '-T', 'root', 'MouseDragEnd3Border'])

  tmux([
    'bind-key',
    '-T',
    'root',
    'MouseDown3Pane',
    'if-shell',
    '-F',
    '#{m/r:^cbridge-leaders-,#{session_name}}',
    leaderMenuAfterRightClick,
    defaultPaneMenu,
  ])
  tmux([
    'bind-key',
    '-T',
    'root',
    'MouseDown3Border',
    'if-shell',
    '-F',
    '#{m/r:^cbridge-leaders-,#{session_name}}',
    leaderMenuAfterRightClick,
    'select-pane -t =',
  ])
  tmuxLeaderLayoutMenuConfigured = true
}

function getTmuxTitleHeaders(): TmuxTitleHeaderPane[] {
  const headers: TmuxTitleHeaderPane[] = []
  const out = tmuxOutput([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{window_name}\t#{pane_id}\t#{@cbridge_header_for}\t#{@cbridge_title_header_version}\t#{pane_height}\t#{pane_title}\t#{@cbridge_ack_click}',
  ])

  for (const line of out.split('\n')) {
    const [sessionName, windowName, paneId, headerFor, version, heightRaw, title, ackClickToken] = line.split('\t')
    if (!sessionName || !isCbridgeTitleSession(sessionName)) continue
    if (!paneId || !headerFor?.startsWith('%')) continue
    const height = Number(heightRaw)
    headers.push({
      sessionName,
      paneId,
      headerFor,
      version,
      target: paneId,
      height: Number.isFinite(height) ? height : 0,
      title: title ?? '',
      ackClickToken: ackClickToken ?? '',
      windowName: windowName ?? '',
    })
  }
  return headers
}

function cleanupTmuxTitleHeaders(headers: TmuxTitleHeaderPane[], livePaneIds: Set<string>): void {
  const seenPaneIds = new Set<string>()
  const seenByHeaderFor = new Map<string, string>()
  for (const header of headers) {
    if (seenPaneIds.has(header.paneId)) continue
    seenPaneIds.add(header.paneId)

    const existingHeaderPane = seenByHeaderFor.get(header.headerFor)
    if (
      header.version !== PANE_TITLE_HEADER_VERSION ||
      !livePaneIds.has(header.headerFor) ||
      (existingHeaderPane !== undefined && existingHeaderPane !== header.paneId) ||
      !shouldUsePaneTitleHeader(header)
    ) {
      tmux(['kill-pane', '-t', header.target])
      continue
    }
    seenByHeaderFor.set(header.headerFor, header.paneId)
  }
}

function tmuxTitleHeaderCommand(targetPaneId: string): string {
  const interval = String(Math.max(1, PANE_TITLE_HEADER_REFRESH_MS / 1000))
  return [
    `sep=$(printf '\\t'); last=; self=\${TMUX_PANE:-$(tmux display-message -p '#{pane_id}' 2>/dev/null)};`,
    'while :; do',
    `payload=$(tmux display-message -p -t ${shellQuote(targetPaneId)} ${shellQuote('#{@cbridge_title_line_1}\t#{@cbridge_title_line_2}\t#{@cbridge_unread}')} 2>/dev/null) || exit 0;`,
    'if [ "$payload" != "$last" ]; then',
    'last=$payload; line1=${payload%%"$sep"*}; rest=${payload#*"$sep"}; line2=${rest%%"$sep"*}; unread=${payload##*"$sep"};',
    'tmux clear-history -t "$self" 2>/dev/null;',
    'if [ "$unread" = "1" ]; then',
    `printf '\\033[?7l\\033[?25l\\033[2J\\033[H\\033[2K\\033[48;5;46;30;1m 답변 완료 \\033[0m \\033[48;5;22;37;1m %s \\033[0m\\n\\033[2K\\033[48;5;22;37;1m %s \\033[0m' "$line1" "$line2";`,
    'else',
    `printf '\\033[?7l\\033[?25l\\033[2J\\033[H\\033[2K\\033[97;1m%s\\033[0m\\n\\033[2K\\033[93;1m%s\\033[0m' "$line1" "$line2";`,
    'fi;',
    'fi;',
    `sleep ${shellQuote(interval)};`,
    'done',
  ].join(' ')
}

function ensureTmuxTitleHeader(pane: TmuxPane, roomId: string, headersByPane: Map<string, TmuxTitleHeaderPane>): void {
  const existing = headersByPane.get(pane.paneId)
  if (existing) {
    if (existing.height !== 2) tmux(['resize-pane', '-t', existing.target, '-y', '2'])
    if (existing.title !== '') tmux(['select-pane', '-t', existing.target, '-T', ''])
    if (existing.ackClickToken.includes('#{')) tmux(['set-option', '-pt', existing.target, '@cbridge_ack_click', ''])
    return
  }
  if (pane.height < 8) return

  const headerId = tmuxOutput([
    'split-window',
    '-v',
    '-b',
    '-l',
    '2',
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    pane.target,
    tmuxTitleHeaderCommand(pane.paneId),
  ]).trim()
  if (!headerId) return

  tmux(['set-option', '-pt', headerId, '@cbridge_header_for', pane.paneId])
  tmux(['set-option', '-pt', headerId, '@cbridge_title_header', '1'])
  tmux(['set-option', '-pt', headerId, '@cbridge_title_header_version', PANE_TITLE_HEADER_VERSION])
  tmux(['resize-pane', '-t', headerId, '-y', '2'])
  tmux(['select-pane', '-t', headerId, '-T', ''])
  tmux(['select-pane', '-t', pane.target])
  headersByPane.set(pane.paneId, {
    target: headerId,
    paneId: headerId,
    sessionName: pane.sessionName,
    windowName: pane.windowName,
    headerFor: pane.paneId,
    version: PANE_TITLE_HEADER_VERSION,
    height: 2,
    title: '',
    ackClickToken: '',
  })
}

function sanitizePaneTitle(value: string): string {
  return vis(value)
    .replace(/[#\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function promptForLeaderPid(pid: number, roomId: string, files: Map<number, string>): string {
  const path = files.get(pid)
  if (!path) return '최근 프롬프트 확인 불가\n세션 로그 확인 필요'
  return latestPromptSummaryFromFile(path)
}

function updateTmuxPaneTitlesOnce(): void {
  configureTmuxLeaderLayoutMenu()

  const processes = getBridgeProcesses()
  const rawPanes = getTmuxBridgePanes(processes)
  const panes = uniqueTmuxPanes(rawPanes)
  const livePaneIds = new Set(panes.map(pane => pane.paneId))
  let headers = getTmuxTitleHeaders()
  cleanupTmuxTitleHeaders(headers, livePaneIds)
  headers = getTmuxTitleHeaders()
  const headersByPane = new Map(
    headers
      .filter(header => livePaneIds.has(header.headerFor))
      .map(header => [header.headerFor, header] as const),
  )

  const leaderPanes = panes.filter(pane => pane.role === 'leader')
  const files = getOpenCodexSessionFiles(leaderPanes.map(pane => pane.panePid))
  const selectedNow = getSelectedLeaderPanesByWindow()
  const promptByRoom = new Map<string, string>()
  const workLabelByRoom = new Map<string, string>()
  const unreadByPane = new Map<string, boolean>()
  const unreadByWindow = new Map<string, Set<number>>()
  const touchedSessions = new Set<string>()
  for (const pane of rawPanes) touchedSessions.add(pane.sessionName)

  for (const pane of leaderPanes) {
    const processInfo = processes.get(pane.panePid)
    if (!processInfo) continue
    const prompt = promptForLeaderPid(pane.panePid, processInfo.roomId, files)
    promptByRoom.set(processInfo.roomId, prompt)
    const filePath = files.get(pane.panePid)
    const workLabel = isIssueLikeId(processInfo.roomId)
      ? processInfo.roomId
      : (filePath ? latestWorkLabelFromFile(filePath) : undefined)
    if (workLabel) workLabelByRoom.set(processInfo.roomId, workLabel)
    const headerAckClickToken = headersByPane.get(pane.paneId)?.ackClickToken ?? ''
    const selectedPaneAfterUnread = selectedNow.get(pane.windowName) === pane.paneId
    const unread = updateLeaderUnreadState(
      pane,
      filePath,
      processInfo.roomId,
      headerAckClickToken,
      selectedPaneAfterUnread,
    )
    unreadByPane.set(pane.paneId, unread)
    if (unread && isLeaderWindowName(pane.windowName)) {
      const windowUnread = unreadByWindow.get(pane.windowName) ?? new Set<number>()
      windowUnread.add(pane.displayIndex)
      unreadByWindow.set(pane.windowName, windowUnread)
    }
  }

  activeLeaderPaneByWindow.clear()
  for (const [windowName, paneId] of selectedNow) activeLeaderPaneByWindow.set(windowName, paneId)
  updateAttachedLeaderTabTitles(unreadByWindow)

  for (const pane of panes) {
    const processInfo = processes.get(pane.panePid)
    if (!processInfo) continue
    const roomId = processInfo.roomId
    const filePath = pane.role === 'leader' ? files.get(pane.panePid) : undefined
    const prompt = pane.role === 'leader'
      ? (promptByRoom.get(roomId) ?? promptForLeaderPid(pane.panePid, roomId, files))
      : (promptByRoom.get(roomId) ?? '응답자 세션')
    const workLabel = isIssueLikeId(roomId)
      ? roomId
      : (filePath ? latestWorkLabelFromFile(filePath) : workLabelByRoom.get(roomId))
    const unread = pane.role === 'leader' && unreadByPane.get(pane.paneId) === true
    const slackActive = pane.role === 'leader' && roomUsesSlack(roomId)
    const prefix = titlePrefixForPane(pane, roomId, slackActive)
    if (pane.role === 'leader' && pane.currentSlackNotice) {
      setTmuxPaneOptionIfChanged(pane.target, '@cbridge_slack_notice', pane.currentSlackNotice, '')
    }
    const [line1, line2] = unread
      ? completedAnswerTitleLines(prompt, pane.width, prefix)
      : titleLines(prefix, prompt, pane.width)
    const shortPrompt = line2 ? `${line1} ${line2}` : line1
    const borderTitle = unread
      ? `#[fg=colour46,bold]${line1}`
      : `#[fg=colour14,bold]${line1}`
    if (pane.ackClickToken.includes('#{')) setTmuxPaneOptionIfChanged(pane.target, '@cbridge_ack_click', pane.ackClickToken, '')
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_room', pane.currentRoom, roomId)
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_work_label', pane.currentWorkLabel, workLabel ?? '')
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_prompt', pane.currentPrompt, shortPrompt)
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_unread', pane.currentUnread, unread ? '1' : '')
    setTmuxPaneOptionIfChanged(
      pane.target,
      '@cbridge_display_index',
      pane.currentDisplayIndex,
      String(pane.displayIndex),
    )
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_title_line_1', pane.currentTitleLine1, line1)
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_title_line_2', pane.currentTitleLine2, line2)
    setTmuxPaneOptionIfChanged(pane.target, '@cbridge_border_title', pane.currentBorderTitle, borderTitle)
    const usesTitleHeader = shouldUsePaneTitleHeader(pane)
    if (usesTitleHeader) {
      ensureTmuxTitleHeader(pane, roomId, headersByPane)
    }
    const windowTarget = tmuxWindowTargetForPane(pane)
    if (pane.sessionName.startsWith('cbridge-leaders-') && !usesTitleHeader && LEADER_BORDER_TITLES) {
      setTmuxWindowOptionCached(windowTarget, 'pane-border-status', 'top')
      setTmuxWindowOptionCached(windowTarget, 'pane-border-format', '#{@cbridge_border_title}')
      setTmuxWindowOptionCached(windowTarget, 'pane-border-style', 'fg=#334155')
      setTmuxWindowOptionCached(windowTarget, 'pane-active-border-style', 'fg=#38bdf8,bold')
      setTmuxWindowOptionCached(windowTarget, 'message-style', 'fg=#0f172a,bg=#facc15,bold')
      setTmuxWindowOptionCached(windowTarget, 'mode-style', 'fg=#0f172a,bg=#bae6fd,bold')
    } else {
      setTmuxWindowOptionCached(windowTarget, 'pane-border-status', 'off')
      unsetTmuxWindowOptionCached(windowTarget, 'pane-border-format')
      unsetTmuxWindowOptionCached(windowTarget, 'pane-border-style')
      unsetTmuxWindowOptionCached(windowTarget, 'pane-active-border-style')
      unsetTmuxWindowOptionCached(windowTarget, 'message-style')
      unsetTmuxWindowOptionCached(windowTarget, 'mode-style')
    }
  }

  for (const pane of rawPanes) {
    if (!shouldUsePaneTitleHeader(pane)) continue
    const windowTarget = tmuxWindowTargetForPane(pane)
    setTmuxWindowOptionCached(windowTarget, 'pane-border-status', 'off')
    unsetTmuxWindowOptionCached(windowTarget, 'pane-border-format')
    unsetTmuxWindowOptionCached(windowTarget, 'pane-border-style')
    unsetTmuxWindowOptionCached(windowTarget, 'pane-active-border-style')
    unsetTmuxWindowOptionCached(windowTarget, 'message-style')
    unsetTmuxWindowOptionCached(windowTarget, 'mode-style')
  }

  for (const sessionName of touchedSessions) {
    setTmuxSessionOptionCached(sessionName, 'mouse', shouldUseNativeTerminalSelection(sessionName) ? 'off' : 'on')
    if (sessionName.startsWith('cbridge-leaders-')) {
      setTmuxSessionOptionCached(sessionName, 'focus-events', 'on')
      setTmuxSessionOptionCached(sessionName, 'bell-action', 'current')
      setTmuxSessionOptionCached(sessionName, 'activity-action', 'none')
      setTmuxSessionOptionCached(sessionName, 'visual-bell', 'off')
    }
    setTmuxSessionOptionCached(sessionName, 'set-titles', 'off')
    setTmuxSessionOptionCached(sessionName, 'status', 'off')
    unsetTmuxSessionOptionCached(sessionName, 'status-format[0]')
    unsetTmuxSessionOptionCached(sessionName, 'status-format[1]')
  }
}

async function watchTmuxPaneTitles(): Promise<void> {
  while (true) {
    updateTmuxPaneTitlesOnce()
    await Bun.sleep(PANE_TITLE_WATCH_REFRESH_MS)
  }
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function hasTmuxSession(sessionName: string): boolean {
  try {
    return spawnSync('tmux', ['has-session', '-t', sessionName], { stdout: 'ignore', stderr: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function ensureTmuxPaneTitleUpdater(): void {
  if (process.env.CODEX_BRIDGE_PANE_TITLES === '0') return
  if (hasTmuxSession(PANE_TITLE_TMUX_SESSION)) return
  const existingPid = readPid(PANE_TITLE_PID_PATH)
  if (existingPid && isPidAlive(existingPid)) return

  const tmuxCommand = `${shellQuote(process.execPath)} ${shellQuote(SELF_PATH)} tmux-pane-titles --watch`
  const tmuxStart = spawnSync('tmux', [
    'new-session',
    '-d',
    '-s',
    PANE_TITLE_TMUX_SESSION,
    '-c',
    BRIDGE_DIR,
    tmuxCommand,
  ], { stdout: 'ignore', stderr: 'ignore' })
  if (tmuxStart.status === 0) {
    writeFileSync(PANE_TITLE_PID_PATH, `tmux:${PANE_TITLE_TMUX_SESSION}\n`)
    return
  }

  const proc = Bun.spawn([process.execPath, SELF_PATH, 'tmux-pane-titles', '--watch'], {
    cwd: BRIDGE_DIR,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, CODEX_BRIDGE_PANE_TITLE_CHILD: '1' },
  })
  proc.unref()
  writeFileSync(PANE_TITLE_PID_PATH, `${proc.pid}\n`)
}

/** Scan /tmp for PID files written by bridge-claude / bridge-codex.
 *  Returns only entries whose process is still alive. */
function getTerminalSessions(): TerminalSessions {
  const result: TerminalSessions = new Map()
  try {
    for (const file of readdirSync('/tmp')) {
      const isClaude = file.startsWith('claude-bridge-room-')
      const isCodex  = file.startsWith('codex-bridge-room-')
      if (!isClaude && !isCodex) continue
      try {
        const content = readFileSync(`/tmp/${file}`, 'utf8').trim()
        const roomId  = content.split(':')[0]
        const pid     = parseInt(file.replace(/^(claude|codex)-bridge-room-/, ''), 10)
        if (!roomId || isNaN(pid)) continue
        try { process.kill(pid, 0) } catch { continue }  // skip dead processes
        if (!result.has(roomId)) result.set(roomId, { claude: [], codex: [] })
        const s = result.get(roomId)!
        if (isClaude) s.claude.push(pid)
        else          s.codex.push(pid)
      } catch {}
    }
  } catch {}
  return result
}

function formatAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 5)    return `${C.bgreen}just now${C.reset}`
  if (secs < 60)   return `${C.gray}${secs}s ago${C.reset}`
  if (secs < 3600) return `${C.gray}${Math.floor(secs / 60)}m ago${C.reset}`
  return `${C.gray}${Math.floor(secs / 3600)}h ago${C.reset}`
}

function agentDot(connected: boolean, onColor: string): string {
  return connected ? `${onColor}●${C.reset}` : `${C.gray}○${C.reset}`
}

function printLeaderPromptSummaries(summaries: LeaderPromptSummary[]): void {
  if (summaries.length === 0) return
  const terminalWidth = process.stdout.columns || 100
  const promptWidth = Math.min(Math.max(10, terminalWidth - 6), 110)
  console.log(`  ${C.bold}${C.bcyan}최근 leader 작업${C.reset}  ${C.dim}${Math.round(DASHBOARD_REFRESH_MS / 1000)}초마다 자동 갱신${C.reset}`)
  for (const item of summaries) {
    const [line1 = ''] = item.prompt.split(/\n+/)
    const roomPrefix = `${leaderRoomDisplayLabel(item.roomId)} · `
    const promptLineWidth = Math.max(6, promptWidth - visWidth(roomPrefix))
    console.log(`    ${C.bold}${C.bcyan}${roomPrefix}${C.reset}${C.byellow}${truncateVisible(line1, promptLineWidth)}${C.reset}`)
  }
  console.log()
}

function printRooms(rooms: Room[], leaderPrompts: LeaderPromptSummary[] = []): void {
  console.clear()
  console.log()

  // ── Header ──
  console.log(boxTop())
  console.log(boxRow(`  ${C.bold}${C.bcyan}◈  ${HEADER_LABEL}${C.reset}  ${C.dim}룸 관리 대시보드${C.reset}  ${C.gray}${VERSION}${C.reset}`))
  console.log(boxRow(`     ${C.dim}multi-room agent bridge${C.reset}`))
  console.log(boxBottom())
  console.log()

  // ── Status ──
  const roomCount = rooms.length === 0
    ? `${C.gray}no active rooms${C.reset}`
    : `${C.bold}${rooms.length}${C.reset} room${rooms.length === 1 ? '' : 's'} active`
  console.log(`  ${roomCount}  ${C.gray}·${C.reset}  ${C.dim}${BRIDGE_URL}${C.reset}`)
  console.log()
  printLeaderPromptSummaries(leaderPrompts)

  // ── Room list ──
  if (rooms.length === 0) {
    console.log(`  ${C.gray}No rooms yet. Press ${C.reset}${C.bold}o${C.reset}${C.gray} to open one.${C.reset}`)
  } else {
    for (const r of [...rooms].sort((a, b) => a.id.localeCompare(b.id))) {
      const codex  = agentDot(r.codexConnected,  C.bgreen)
      const claude = agentDot(r.claudeConnected, C.bpurple)
      const codexL  = r.codexConnected  ? `${C.green}codex${C.reset}`  : `${C.gray}codex${C.reset}`
      const claudeL = r.claudeConnected ? `${C.purple}${RESPONDER_LABEL}${C.reset}` : `${C.gray}${RESPONDER_LABEL}${C.reset}`
      const id  = rpad(`${C.bold}${r.id}${C.reset}`, 14)
      const age = formatAge(r.lastActivity)
      console.log(`  ${id}  ${codex} ${codexL}   ${claude} ${claudeL}   ${age}`)
    }
  }
  // ── Terminal sessions (dim) ──
  const sessions = getTerminalSessions()
  if (sessions.size > 0) {
    const sorted = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b))
    console.log(`  ${C.dim}terminals${C.reset}`)
    for (const [roomId, s] of sorted) {
      const parts: string[] = []
      if (s.claude.length > 0) parts.push(`${RESPONDER_LABEL} ×${s.claude.length}`)
      if (s.codex.length  > 0) parts.push(`codex ×${s.codex.length}`)
      const label = parts.length > 0 ? parts.join('   ') : 'no active terminals'
      console.log(`  ${C.dim}${roomId.padEnd(14)}  ${label}${C.reset}`)
    }
  }
  console.log()

  // ── Footer ──
  console.log(divider())
  const keys = [
    `${C.bold}m${C.reset} message`,
    `${C.bold}o${C.reset} open`,
    `${C.bold}c${C.reset} close`,
    `${C.bold}r${C.reset} refresh`,
    `${C.bold}q${C.reset} quit`,
  ]
  console.log(`  ${keys.join(`  ${C.gray}·${C.reset}  `)}`)
  console.log(divider())
  console.log()
}

// ── Terminal opening ──

function detectEnv(): 'tmux' | 'iterm2' | 'terminal' | 'ghostty' | 'none' {
  if (process.env.CODEX_BRIDGE_OPEN === 'manual') return 'none'
  if (process.env.TMUX) return 'tmux'
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iterm2'
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'terminal'
  if (process.env.TERM_PROGRAM === 'ghostty' || process.env.GHOSTTY_RESOURCES_DIR) return 'ghostty'
  return 'none'
}

function openWithTmux(roomId: string, cmd1: string, cmd2: string): void {
  spawnSync('tmux', ['new-window', '-n', roomId, cmd1])
  spawnSync('tmux', ['split-window', '-h', cmd2])
  spawnSync('tmux', ['select-pane', '-L'])
}

function openWithAppleScript(app: 'iTerm' | 'Terminal', roomId: string, cmd1: string, cmd2: string): void {
  const script = app === 'iTerm' ? `
tell application "iTerm"
  activate
  set t to (create tab with default profile)
  tell current session of t
    set name to "${roomId} (claude)"
    write text "${cmd1}"
  end tell
  set t2 to (create tab with default profile)
  tell current session of t2
    set name to "${roomId} (codex)"
    write text "${cmd2}"
  end tell
end tell` : `
tell application "Terminal"
  activate
  do script "${cmd1}"
  do script "${cmd2}"
end tell`
  spawnSync('osascript', ['-e', script])
}


function openWithGhostty(cmd1: string, cmd2: string): void {
  // Open two new Ghostty windows with the given commands
  const args = [
    '-na',
    'Ghostty',
    '--args',
    '--selection-clear-on-typing=false',
    '--copy-on-select=false',
    '--link-url=false',
    '--',
  ]
  spawnSync('open', [...args, 'sh', '-c', cmd1])
  spawnSync('open', [...args, 'sh', '-c', cmd2])
}

function openRoom(roomId: string, workdir: string): 'auto' | 'manual' {
  const BRIDGE = new URL('.', import.meta.url).pathname
  const envPrefix = `CODEX_BRIDGE_CWD=${shellQuote(workdir)}`
  const claudeCmd = PAIR_MODE === 'codex-codex'
    ? `${envPrefix} ${shellQuote(`${BRIDGE}bridge-codex-peer`)} ${shellQuote(roomId)}`
    : `${envPrefix} ${shellQuote(`${BRIDGE}bridge-claude`)} ${shellQuote(roomId)}`
  const codexCmd  = `${envPrefix} ${shellQuote(`${BRIDGE}bridge-codex`)} ${shellQuote(roomId)}`
  const env = detectEnv()
  if (env === 'tmux')     { openWithTmux(roomId, claudeCmd, codexCmd); return 'auto' }
  if (env === 'iterm2')   { openWithAppleScript('iTerm',    roomId, claudeCmd, codexCmd); return 'auto' }
  if (env === 'terminal') { openWithAppleScript('Terminal', roomId, claudeCmd, codexCmd); return 'auto' }
  if (env === 'ghostty')  { openWithGhostty(claudeCmd, codexCmd); return 'auto' }
  return 'manual'
}

// ── Interactive prompt ──

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => {
    try {
      rl.question(question, resolve)
    } catch {
      resolve('')
    }
  })
}

function leaderPaneLabel(pane: TmuxPane): string {
  const roomLabel = leaderRoomDisplayLabel(pane.roomId, pane.roleLabel)
  const work = pane.currentWorkLabel || pane.currentPrompt
  return work ? `${roomLabel} · ${truncateVisible(work, 56)}` : roomLabel
}

function sortedLeaderPanes(): TmuxPane[] {
  return getTmuxLeaderPanes()
    .sort((a, b) => leaderSortKey(a.roomId) - leaderSortKey(b.roomId))
}

async function selectLeaderPaneForCompose(rl: ReturnType<typeof createInterface>): Promise<TmuxPane | undefined> {
  const panes = sortedLeaderPanes()
  if (panes.length === 0) {
    console.log(`  ${C.yellow}리더 화면이 없습니다.${C.reset} 먼저 cbridge 리더를 복원하거나 새로 열어야 합니다.`)
    await Bun.sleep(900)
    return undefined
  }
  if (panes.length === 1) return panes[0]

  console.log()
  for (let i = 0; i < panes.length; i++) {
    console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${leaderPaneLabel(panes[i])}`)
  }
  const pick = (await prompt(rl, `\n  ${C.gray}보낼 리더 번호:${C.reset} `)).trim()
  const index = Number(pick) - 1
  if (!Number.isInteger(index) || index < 0 || index >= panes.length) {
    console.log(`  ${C.gray}취소했습니다.${C.reset}`)
    await Bun.sleep(700)
    return undefined
  }
  return panes[index]
}

function renderTerminalComposer(target: TmuxPane, text: string, notice = ''): void {
  console.clear()
  console.log()
  console.log(`  ${C.bold}${C.bcyan}Cbridge 메시지 작성${C.reset}`)
  console.log(`  ${C.gray}대상:${C.reset} ${leaderPaneLabel(target)}`)
  console.log(`  ${C.gray}Enter 보내기 · Option/Shift/Cmd+Enter 줄바꿈 · Ctrl-V 이미지 첨부 · /attach 경로 첨부 · Esc 취소${C.reset}`)
  console.log(divider())
  console.log()
  if (notice) console.log(`  ${notice}\n`)
  if (text) {
    console.log(text)
  } else {
    console.log(`${C.gray}메시지를 입력하세요. 이미지는 복사 후 Ctrl-V, Finder 드래그, /attach /path/to/image.png 로 넣습니다.${C.reset}`)
  }
  console.log()
  console.log(divider())
}

function previousCodePoint(value: string): string {
  return Array.from(value).slice(0, -1).join('')
}

function readTerminalComposeInput(target: TmuxPane): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(undefined)

  return new Promise(resolve => {
    let text = ''
    let notice = ''
    const stdin = process.stdin
    const previousRawMode = stdin.isRaw

    const cleanup = (result: string | undefined) => {
      stdin.off('keypress', onKeypress)
      try {
        stdin.setRawMode(previousRawMode)
      } catch {}
      resolve(result)
    }

    const onKeypress = (str: string | undefined, key: TerminalComposeKey = {}) => {
      const sequence = key.sequence ?? str ?? ''
      if (key.ctrl && key.name === 'c') {
        cleanup(undefined)
        return
      }
      if (key.ctrl && key.name === 'v') {
        const attachment = saveClipboardImageAttachment()
        if (attachment) {
          text = appendAttachmentDirective(text, attachment.path)
          notice = `${C.bgreen}클립보드 이미지를 첨부했습니다.${C.reset} ${attachment.path}`
        } else {
          notice = `${C.yellow}클립보드에서 이미지를 찾지 못했습니다.${C.reset}`
        }
        renderTerminalComposer(target, text, notice)
        return
      }
      if (key.name === 'escape') {
        cleanup(undefined)
        return
      }
      if (key.name === 'backspace') {
        text = previousCodePoint(text)
        renderTerminalComposer(target, text, notice)
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (isTerminalComposeNewlineKey(sequence, key)) {
          text += '\n'
          renderTerminalComposer(target, text, notice)
          return
        }
        cleanup(text.trim() ? text : undefined)
        return
      }
      if (key.name === 'tab') {
        text += '\t'
        renderTerminalComposer(target, text, notice)
        return
      }
      if (str && !key.ctrl && !key.meta) {
        text += str
        renderTerminalComposer(target, text, notice)
      }
    }

    emitKeypressEvents(stdin)
    try {
      stdin.setRawMode(true)
    } catch {
      resolve(undefined)
      return
    }
    stdin.on('keypress', onKeypress)
    stdin.resume()
    renderTerminalComposer(target, text, notice)
  })
}

function readTerminalDraftInput(target: TmuxPane): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(undefined)

  return new Promise(resolve => {
    let text = ''
    let notice = ''
    const stdin = process.stdin
    const previousRawMode = stdin.isRaw

    const cleanup = (result: string | undefined) => {
      stdin.off('keypress', onKeypress)
      try {
        stdin.setRawMode(previousRawMode)
      } catch {}
      resolve(result)
    }

    const render = () => {
      console.clear()
      console.log()
      console.log(`  ${C.bold}${C.bcyan}Cbridge 메시지 작성${C.reset}`)
      console.log(`  ${C.gray}대상:${C.reset} ${leaderPaneLabel(target)}`)
      console.log(`  ${C.gray}Enter 줄바꿈 · Ctrl-D 보내기 · Ctrl-V 이미지 첨부 · /attach 경로 첨부 · Esc 취소${C.reset}`)
      console.log(divider())
      console.log()
      if (notice) console.log(`  ${notice}\n`)
      console.log(text || `${C.gray}메시지를 입력하세요. 이미지는 복사 후 Ctrl-V, Finder 드래그, /attach /path/to/image.png 로 넣습니다.${C.reset}`)
      console.log()
      console.log(divider())
    }

    const onKeypress = (str: string | undefined, key: TerminalComposeKey = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup(undefined)
        return
      }
      if (key.ctrl && key.name === 'd') {
        cleanup(text.trim() ? text : undefined)
        return
      }
      if (key.ctrl && key.name === 'v') {
        const attachment = saveClipboardImageAttachment()
        if (attachment) {
          text = appendAttachmentDirective(text, attachment.path)
          notice = `${C.bgreen}클립보드 이미지를 첨부했습니다.${C.reset} ${attachment.path}`
        } else {
          notice = `${C.yellow}클립보드에서 이미지를 찾지 못했습니다.${C.reset}`
        }
        render()
        return
      }
      if (key.name === 'escape') {
        cleanup(undefined)
        return
      }
      if (key.name === 'backspace') {
        text = previousCodePoint(text)
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        text += '\n'
        render()
        return
      }
      if (key.name === 'tab') {
        text += '\t'
        render()
        return
      }
      if (str && !key.ctrl && !key.meta) {
        text += str
        render()
      }
    }

    emitKeypressEvents(stdin)
    try {
      stdin.setRawMode(true)
    } catch {
      resolve(undefined)
      return
    }
    stdin.on('keypress', onKeypress)
    stdin.resume()
    render()
  })
}

async function fallbackLineComposeInput(rl: ReturnType<typeof createInterface>): Promise<string | undefined> {
  console.log(`  ${C.gray}여러 줄 입력은 마지막 줄에 . 만 입력하면 전송됩니다. /attach 경로로 파일을 붙일 수 있습니다.${C.reset}`)
  const lines: string[] = []
  while (true) {
    const line = await prompt(rl, lines.length === 0 ? `  ${C.bcyan}msg>${C.reset} ` : `  ${C.bcyan}...>${C.reset} `)
    if (line.trim() === '.') break
    lines.push(line)
  }
  const text = lines.join('\n').trim()
  return text || undefined
}

function missingAttachmentPaths(attachments: TerminalComposeAttachment[]): string[] {
  return attachments
    .map(item => item.path)
    .filter(path => {
      try {
        statSync(path)
        return false
      } catch {
        return true
      }
    })
}

function pasteMessageIntoTmuxPane(target: string, text: string): boolean {
  const buffer = `cbridge-compose-${process.pid}-${Date.now()}`
  const loaded = spawnSync('tmux', ['load-buffer', '-b', buffer, '-'], {
    input: text,
    encoding: 'utf8',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if (loaded.status !== 0) return false
  const pasted = spawnSync('tmux', ['paste-buffer', '-t', target, '-b', buffer, '-p'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  spawnSync('tmux', ['delete-buffer', '-b', buffer], { stdout: 'ignore', stderr: 'ignore' })
  if (pasted.status !== 0) return false
  const entered = spawnSync('tmux', ['send-keys', '-t', target, 'Enter'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return entered.status === 0
}

async function composeAndSendToLeader(rl: ReturnType<typeof createInterface>): Promise<void> {
  const pane = await selectLeaderPaneForCompose(rl)
  if (!pane) return

  rl.pause()
  const raw = await readTerminalComposeInput(pane)
  rl.resume()
  const fallbackRaw = raw === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)
    ? await fallbackLineComposeInput(rl)
    : raw
  if (!fallbackRaw) {
    console.log(`  ${C.gray}취소했습니다.${C.reset}`)
    await Bun.sleep(700)
    return
  }

  const message = formatTerminalComposeMessage(fallbackRaw)
  const missing = missingAttachmentPaths(message.attachments)
  if (missing.length > 0) {
    console.log(`  ${C.yellow}첨부 파일을 찾지 못했습니다:${C.reset} ${missing.join(', ')}`)
    await Bun.sleep(1300)
    return
  }

  if (!pasteMessageIntoTmuxPane(pane.target, message.text)) {
    console.log(`  ${C.red}전송하지 못했습니다.${C.reset} 리더 화면이 살아 있는지 확인해야 합니다.`)
    await Bun.sleep(1300)
    return
  }

  console.log(`  ${C.bgreen}전송했습니다.${C.reset} ${leaderPaneLabel(pane)} 화면에 메시지가 들어갔습니다.`)
  await Bun.sleep(900)
}

function resolveLeaderPaneTarget(targetArg: string | undefined, headerForArg: string | undefined): TmuxPane | undefined {
  const target = (headerForArg?.startsWith('%') ? headerForArg : targetArg)?.trim()
  if (!target) return undefined
  return sortedLeaderPanes().find(pane => pane.paneId === target || pane.target === target)
}

async function composeAndSendToTarget(targetArg: string | undefined, headerForArg: string | undefined): Promise<void> {
  const pane = resolveLeaderPaneTarget(targetArg, headerForArg)
  if (!pane) {
    console.error('리더 화면을 찾지 못했습니다.')
    process.exitCode = 1
    return
  }

  const raw = await readTerminalDraftInput(pane)
  if (!raw) {
    console.log('취소했습니다.')
    return
  }

  const message = formatTerminalComposeMessage(raw)
  const missing = missingAttachmentPaths(message.attachments)
  if (missing.length > 0) {
    console.error(`첨부 파일을 찾지 못했습니다: ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  if (!pasteMessageIntoTmuxPane(pane.target, message.text)) {
    console.error('전송하지 못했습니다. 리더 화면이 살아 있는지 확인해야 합니다.')
    process.exitCode = 1
    return
  }

  console.log('전송했습니다.')
}

async function renderDashboard(): Promise<Room[]> {
  const rooms = await getRooms()
  printRooms(rooms, getLeaderPromptSummaries())
  return rooms
}

function dashboardPrompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  if (!process.stdout.isTTY) return prompt(rl, question)

  return new Promise(resolve => {
    let done = false
    let redrawing = false
    const redraw = async () => {
      if (done || redrawing) return
      redrawing = true
      try {
        await renderDashboard()
        rl.setPrompt(question)
        rl.prompt(true)
      } finally {
        redrawing = false
      }
    }

    const timer = setInterval(redraw, DASHBOARD_REFRESH_MS)
    const onLine = (line: string) => {
      done = true
      clearInterval(timer)
      rl.removeListener('line', onLine)
      resolve(line)
    }

    rl.setPrompt(question)
    rl.once('line', onLine)
    rl.prompt()
  })
}

// ── Main ──

async function main(): Promise<void> {
  process.stdout.write(`\n  ${C.dim}Connecting to bridge...${C.reset} `)
  try {
    await ensureBridge()
    ensureTmuxPaneTitleUpdater()
    console.log(`${C.bgreen}ready${C.reset}\n`)
  } catch (err) {
    console.error(`\n  ${C.red}✗${C.reset} ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let inputClosed = false
  rl.once('close', () => { inputClosed = true })

  while (true) {
    let rooms = await renderDashboard()

    const choice = (await dashboardPrompt(rl, `  ${C.bcyan}›${C.reset} `)).trim().toLowerCase()
    if (inputClosed && !choice) process.exit(0)
    rooms = await getRooms()

    if (choice === 'q' || choice === 'quit') {
      rl.close()
      console.log(`\n  ${C.dim}bye.${C.reset}\n`)
      process.exit(0)
    }

    if (choice === 'r' || choice === 'refresh') continue

    if (choice === 'm' || choice === 'message' || choice === 'send') {
      await composeAndSendToLeader(rl)
      continue
    }

    if (choice === 'o' || choice === 'open') {
      const ticketRaw = (await prompt(rl, `  ${C.gray}Room ID (e.g. ENG-1234):${C.reset} `)).trim()
      const ticket = ticketRaw.toUpperCase()
      if (!ticket) { console.log(`  ${C.gray}Cancelled.${C.reset}`); continue }
      if (rooms.find(r => r.id === ticket)) {
        console.log(`  ${C.yellow}⚠${C.reset}  Room ${C.bold}${ticket}${C.reset} already exists.`)
        await Bun.sleep(900)
        continue
      }

      const workdirRaw = (await prompt(rl, `  ${C.gray}작업 폴더 (Enter = ${DEFAULT_WORKDIR}):${C.reset} `)).trim()
      const workdir = workdirRaw || DEFAULT_WORKDIR

      // ── Role template selection ──
      console.log()
      console.log(`  ${C.dim}역할 템플릿 선택 (Enter = 없음):${C.reset}`)
      TEMPLATE_KEYS.forEach((key, i) => {
        const t = ROLE_TEMPLATES[key]
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bcyan}${t.name}${C.reset}`)
        console.log(`       ${C.dim}${RESPONDER_LABEL}: ${t.claudeRole.slice(0, 60)}...${C.reset}`)
        console.log(`       ${C.dim}Codex:  ${t.codexRole.slice(0, 60)}...${C.reset}`)
      })
      console.log()
      const templatePick = (await prompt(rl, `  ${C.gray}번호 입력 (Enter = 역할 없음):${C.reset} `)).trim()
      const templateIdx = parseInt(templatePick, 10) - 1
      const selectedTemplate = (!isNaN(templateIdx) && templateIdx >= 0 && templateIdx < TEMPLATE_KEYS.length)
        ? ROLE_TEMPLATES[TEMPLATE_KEYS[templateIdx]]
        : null

      const postBody: Record<string, unknown> = {}
      if (selectedTemplate) {
        postBody.roleTemplate = selectedTemplate
        console.log(`  ${C.bgreen}✓${C.reset}  역할 적용: ${C.bold}${selectedTemplate.name}${C.reset}`)
        await Bun.sleep(500)
      }

      await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(ticket)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(postBody),
      }).catch(() => {})
      updateVscodeMcp(ticket)
      const mode = openRoom(ticket, workdir)
      if (mode === 'manual') {
        const peerCmd = PAIR_MODE === 'codex-codex'
          ? `cpeer ${shellQuote(ticket)} ${shellQuote(workdir)}`
          : `CODEX_BRIDGE_CWD=${shellQuote(workdir)} ${shellQuote(`${BRIDGE_DIR}bridge-claude`)} ${shellQuote(ticket)}`
        console.log(`\n  ${C.gray}[${RESPONDER_LABEL}]${C.reset}  ${peerCmd}`)
        console.log(`  ${C.gray}[codex] ${C.reset}  ccodex ${shellQuote(ticket)} ${shellQuote(workdir)}\n`)
        await prompt(rl, `  ${C.gray}Press Enter once both terminals are running...${C.reset} `)
      } else {
        await Bun.sleep(800)
      }
      continue
    }

    if (choice === 'c' || choice === 'close') {
      if (rooms.length === 0) { console.log(`  ${C.gray}No rooms to close.${C.reset}`); await Bun.sleep(700); continue }
      console.log()
      rooms.forEach((r, i) => {
        const codex  = r.codexConnected  ? `${C.bgreen}◉${C.reset}`  : `${C.gray}◯${C.reset}`
        const claude = r.claudeConnected ? `${C.bpurple}◉${C.reset}` : `${C.gray}◯${C.reset}`
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bold}${r.id}${C.reset}   ${codex} codex  ${claude} ${RESPONDER_LABEL}`)
      })
      const pick = (await prompt(rl, `\n  ${C.gray}Close room # — single or comma-separated (e.g. 1,2,3):${C.reset} `)).trim()
      if (pick) {
        const sorted = [...rooms].sort((a, b) => a.id.localeCompare(b.id))
        const indices = pick.split(',')
          .map(s => parseInt(s.trim(), 10) - 1)
          .filter(i => !isNaN(i) && i >= 0 && i < sorted.length)
        const unique = [...new Set(indices)]
        for (const idx of unique) {
          const target = sorted[idx].id
          const ok = await closeRoom(target)
          console.log(ok
            ? `  ${C.bgreen}✓${C.reset}  ${C.bold}${target}${C.reset} closed.`
            : `  ${C.red}✗${C.reset}  Failed to close ${target}.`)
        }
        if (unique.length > 0) await Bun.sleep(700)
      }
      continue
    }
  }
}

if (import.meta.main) {
  if (process.argv[2] === 'compose') {
    await composeAndSendToTarget(process.argv[3], process.argv[4])
    process.exit(process.exitCode ?? 0)
  }

  if (process.argv[2] === 'tmux-pane-titles') {
    if (process.argv.includes('--start')) {
      ensureTmuxPaneTitleUpdater()
      process.exit(0)
    }
    updateTmuxPaneTitlesOnce()
    if (process.argv.includes('--watch')) {
      await watchTmuxPaneTitles()
    }
    process.exit(0)
  }

  await main()
}

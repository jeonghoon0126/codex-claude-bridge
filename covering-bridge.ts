#!/usr/bin/env bun
/**
 * covering-bridge — Room manager CLI for the Codex-Claude multi-room bridge.
 */

import { createInterface } from 'readline'
import { spawnSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { ROLE_TEMPLATES, TEMPLATE_KEYS } from './role-templates.ts'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const BRIDGE_DIR = new URL('.', import.meta.url).pathname
const SELF_PATH = new URL(import.meta.url).pathname
const TMUX_LAYOUT_SCRIPT = `${BRIDGE_DIR}scripts/cbridge-tmux-layout`
const CBRIDGE_FOCUS_SCRIPT = `${BRIDGE_DIR}scripts/cbridge-focus-room`
const VERSION = 'v0.4'
const PAIR_MODE = process.env.CODEX_BRIDGE_PAIR === 'codex-codex' ? 'codex-codex' : 'codex-claude'
const RESPONDER_LABEL = PAIR_MODE === 'codex-codex' ? 'codex-peer' : 'claude'
const HEADER_LABEL = PAIR_MODE === 'codex-codex' ? 'Codex · Codex Bridge' : 'Codex · Claude Bridge'
const DEFAULT_WORKDIR = process.env.CODEX_BRIDGE_CWD ?? process.env.HOME ?? process.cwd()
const DASHBOARD_REFRESH_MS = Math.max(1000, Number(process.env.CODEX_BRIDGE_REFRESH_MS ?? 1500))
const PANE_TITLE_PID_PATH = '/tmp/cbridge-pane-title-updater.pid'
const PANE_TITLE_TMUX_SESSION = 'cbridge-pane-title-updater'
const PANE_TITLE_HEADER_VERSION = '4'

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

type LeaderUnreadState = {
  filePath: string
  completedKey: string
  ackClickToken: string
  unread: boolean
}

type TmuxPane = {
  target: string
  paneId: string
  sessionName: string
  windowName: string
  paneIndex: number
  displayIndex: number
  ackClickToken: string
  panePid: number
  role: PaneRole
  roleLabel: string
  width: number
  height: number
}

type TmuxTitleHeaderPane = {
  target: string
  paneId: string
  sessionName: string
  headerFor: string
  version: string
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

function titleLines(prefixText: string, prompt: string, width: number): [string, string] {
  const lineWidth = Math.max(18, width - 2)
  const prefix = `${prefixText} `
  const normalizedPrompt = sanitizePaneTitle(prompt)
  const [firstPrompt, remaining] = takeVisible(normalizedPrompt, Math.max(0, lineWidth - visWidth(prefix)))
  return [
    `${prefix}${firstPrompt}`.trimEnd(),
    truncateVisible(remaining, lineWidth),
  ]
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

function titlePrefixForPane(pane: TmuxPane, roomId: string, workLabel?: string): string {
  const parts = [pane.roleLabel]
  const primaryContext = workLabel ?? (isIssueLikeId(roomId) ? roomId : undefined)
  if (primaryContext && primaryContext !== pane.roleLabel) parts.push(primaryContext)
  if (
    roomId &&
    roomId !== pane.roleLabel &&
    roomId !== primaryContext &&
    !isInternalRoomId(roomId)
  ) {
    parts.push(roomId)
  }
  return parts.join(' · ')
}

const MCP_JSON_PATH = `${process.env.HOME}/.mcp.json`
const CODEX_STATE_DB_PATH = `${process.env.HOME}/.codex/state_5.sqlite`

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
const codexSessionFileByPid = new Map<number, string>()
const rolloutPathByThreadId = new Map<string, string | undefined>()

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
  if (pids.length === 0) return result
  try {
    const out = spawnSync('lsof', ['-p', pids.join(',')], { encoding: 'utf8' }).stdout ?? ''
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

  for (const pid of pids) {
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

function latestPromptSummaryFromFile(path: string): string {
  try {
    const stat = statSync(path)
    const cached = promptSummaryCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.prompt

    const prompts: string[] = []
    const seen = new Set<string>()
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0 && prompts.length < 4; i--) {
      try {
        const text = cleanUserPrompt(extractPromptText(JSON.parse(lines[i])) ?? '')
        if (!text || seen.has(text)) continue
        seen.add(text)
        prompts.unshift(text)
      } catch {}
    }

    let prompt = '최근 프롬프트 없음'
    if (prompts.length > 0) {
      prompt = prompts[prompts.length - 1]
    }

    promptSummaryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, prompt })
    return prompt
  } catch {
    return '최근 프롬프트 확인 불가'
  }
}

function latestWorkLabelFromFile(path: string): string | undefined {
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1, checked = 0; i >= 0 && checked < 80; i--, checked++) {
      const line = lines[i] ?? ''
      try {
        const text = cleanUserPrompt(extractPromptText(JSON.parse(line)) ?? '')
        const label = text ? extractWorkLabelFromText(text) : undefined
        if (label) return label
      } catch {}

      if (
        line.includes('.task-state.md') ||
        line.includes('.linear.md')
      ) {
        const label = extractWorkLabelFromText(line)
        if (label) return label
      }
    }
  } catch {}
  return undefined
}

function latestCompletedTurnKeyFromFile(path: string): string | undefined {
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1, checked = 0; i >= 0 && checked < 240; i--, checked++) {
      try {
        const record = JSON.parse(lines[i] ?? '')
        const payload = record?.payload
        if (record?.type !== 'event_msg' || payload?.type !== 'task_complete') continue
        const turnId = String(payload.turn_id ?? '')
        const completedAt = String(payload.completed_at ?? record.timestamp ?? '')
        const lastMessage = String(payload.last_agent_message ?? '')
        return `${turnId}:${completedAt}:${lastMessage.length}`
      } catch {}
    }
  } catch {}
  return undefined
}

function leaderSortKey(roomId: string): number {
  return Number(roomId.match(/\d+$/)?.[0] ?? 9999)
}

function getLeaderPromptSummaries(): LeaderPromptSummary[] {
  const processes = getLeaderCodexProcesses()
  const files = getOpenCodexSessionFiles([...processes.keys()])
  const byRoom = new Map<string, LeaderPromptSummary & { mtimeMs: number; score: number }>()
  for (const [pid, roomId] of processes) {
    const path = files.get(pid)
    const prompt = path ? latestPromptSummaryFromFile(path) : '최근 프롬프트 확인 불가'
    const mtimeMs = path ? statSync(path).mtimeMs : 0
    const score = prompt === '최근 프롬프트 없음' || prompt === '최근 프롬프트 확인 불가' ? 0 : 1
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

function shouldUsePaneTitleHeader(sessionName: string): boolean {
  return !sessionName.startsWith('cbridge-leaders-')
}

function peerLabelFromSession(sessionName: string, roomId?: string): string {
  const sessionMatch = sessionName.match(/^cbridge-peer-(.+)$/)?.[1]
  if (sessionMatch) return `PEER-${sessionMatch}`
  const roomMatch = roomId?.match(/^LEADER-(\d+)$/i)?.[1]
  if (roomMatch) return `PEER-${roomMatch}`
  return 'PEER'
}

function leaderLabelFromRoom(roomId?: string): string {
  return roomId && /^LEADER-\d+$/i.test(roomId) ? roomId.toUpperCase() : 'LEADER'
}

function leaderWindowNameFromSession(sessionName: string): string | undefined {
  const linkedMatch = sessionName.match(/^cbridge-leaders-tab-([A-Z])$/)?.[1]
  if (linkedMatch) return linkedMatch
  return undefined
}

function getTmuxBridgePanes(processes: Map<number, BridgeProcess>): TmuxPane[] {
  const panes: TmuxPane[] = []
  try {
    const out = spawnSync('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{@cbridge_ack_click}',
    ], { encoding: 'utf8' }).stdout ?? ''

    for (const line of out.split('\n')) {
      const [sessionName, rawWindowName, paneIndexRaw, paneId, panePidRaw, , widthRaw, heightRaw, ackClickToken] = line.split('\t')
      const panePid = Number(panePidRaw)
      const paneIndex = Number(paneIndexRaw)
      const width = Number(widthRaw)
      const height = Number(heightRaw)
      if (!Number.isFinite(panePid)) continue
      const windowName = rawWindowName || leaderWindowNameFromSession(sessionName ?? '') || ''
      const displayIndex = Number.isFinite(paneIndex) ? paneIndex + 1 : 1
      const processInfo = processes.get(panePid)
      if (sessionName?.startsWith('cbridge-leaders-')) {
        if (processInfo?.role !== 'leader') continue
        panes.push({
          sessionName,
          windowName,
          paneId,
          paneIndex,
          displayIndex,
          ackClickToken: ackClickToken ?? '',
          panePid: processInfo.agentPid,
          role: 'leader',
          roleLabel: leaderLabelFromRoom(processInfo?.roomId),
          width: Number.isFinite(width) ? width : 80,
          height: Number.isFinite(height) ? height : 24,
          target: paneId,
        })
        continue
      }
      if (sessionName?.startsWith('cbridge-peer-') || sessionName === 'cbridge-peers') {
        if (processInfo?.role !== 'peer') continue
        panes.push({
          sessionName,
          windowName,
          paneId,
          paneIndex,
          displayIndex,
          ackClickToken: ackClickToken ?? '',
          panePid: processInfo.agentPid,
          role: 'peer',
          roleLabel: peerLabelFromSession(sessionName, processInfo?.roomId),
          width: Number.isFinite(width) ? width : 80,
          height: Number.isFinite(height) ? height : 24,
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

function notifyLeaderCompletion(pane: TmuxPane, roomId: string): void {
  if (process.env.CBRIDGE_MAC_NOTIFY === '0') return
  if (!/^LEADER-\d+$/i.test(roomId)) return

  const title = 'Codex Bridge'
  const subtitle = `${roomId} 답변 완료`
  const message = `${pane.windowName} 창 ${pane.displayIndex}번 대화`
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
    ], { stdout: 'ignore', stderr: 'ignore' })
    return
  }

  if (existsSync('/usr/bin/osascript')) {
    spawnSync('/usr/bin/osascript', [
      '-e',
      `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} subtitle ${appleScriptString(subtitle)}`,
    ], { stdout: 'ignore', stderr: 'ignore' })
  }
}

function getSelectedLeaderPanesByWindow(): Map<string, string> {
  const selected = new Map<string, string>()
  const out = tmuxOutput(['list-clients', '-F', '#{client_session}\t#{window_name}\t#{pane_id}'])
  for (const line of out.split('\n')) {
    const [sessionName, windowName, paneId] = line.split('\t')
    if (!paneId?.startsWith('%')) continue
    const sessionWindowName = sessionName === 'cbridge-leaders-main'
      ? windowName
      : leaderWindowNameFromSession(sessionName ?? '')
    if (sessionWindowName === 'A' || sessionWindowName === 'B') {
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

    tmux(['set-option', '-t', sessionName, '@cbridge_tab_title', title])
    tmux(['set-option', '-t', sessionName, '@cbridge_unread_panes', unreadNumbers.join(',')])
    const titleCacheKey = `${sessionName}:${tty}`
    if (leaderTabTitleBySession.get(titleCacheKey) === title) continue
    leaderTabTitleBySession.set(titleCacheKey, title)
    try {
      writeFileSync(tty, `\x1b]0;${safeTerminalTitle(title)}\x07`, { flag: 'a' })
    } catch {}
  }
}

function updateLeaderUnreadState(
  pane: TmuxPane,
  filePath: string | undefined,
  selectedNow: Map<string, string>,
  selectedBefore: Map<string, string>,
  roomId: string,
): boolean {
  if (!filePath) {
    leaderUnreadByPane.delete(pane.paneId)
    return false
  }

  const completedKey = latestCompletedTurnKeyFromFile(filePath) ?? ''
  let state = leaderUnreadByPane.get(pane.paneId)
  if (!state) {
    state = { filePath, completedKey, ackClickToken: pane.ackClickToken, unread: false }
    leaderUnreadByPane.set(pane.paneId, state)
    return false
  }

  if (filePath !== state.filePath) {
    state.filePath = filePath
    state.completedKey = completedKey
    state.ackClickToken = pane.ackClickToken
    state.unread = false
    return false
  }

  let becameUnread = false
  if (completedKey && completedKey !== state.completedKey) {
    state.completedKey = completedKey
    state.unread = true
    becameUnread = true
    notifyLeaderCompletion(pane, roomId)
  }

  const clickedPaneAfterUnread = pane.ackClickToken !== '' && pane.ackClickToken !== state.ackClickToken
  const selectedPaneId = selectedNow.get(pane.windowName)
  const previousPaneId = selectedBefore.get(pane.windowName)
  if (
    state.unread &&
    !becameUnread &&
    (
      clickedPaneAfterUnread ||
      (selectedPaneId === pane.paneId && previousPaneId !== pane.paneId)
    )
  ) {
    state.unread = false
  }
  state.ackClickToken = pane.ackClickToken

  return state.unread
}

function tmuxDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function configureTmuxLeaderLayoutMenu(): void {
  const defaultPaneMenu = tmuxOutput(['list-keys', '-T', 'root', 'M-MouseDown3Pane'])
    .replace(/^bind-key -T root M-MouseDown3Pane\s+/, '')
    .trim() || 'send-keys -M'
  const layoutCommand = (layout: '4x1' | '2x2' | 'leader-left' | 'leader-right' | 'leader-remove') =>
    `run-shell -b ${shellQuote(`${TMUX_LAYOUT_SCRIPT} ${layout} "#{session_name}:#{window_index}" "#{pane_id}"`)}`
  const leaderMenu = [
    'display-menu',
    '-T', tmuxDoubleQuote('리더 레이아웃'),
    '-t', '=',
    '-x', 'M',
    '-y', 'M',
    tmuxDoubleQuote('4열 1행'), '4', tmuxDoubleQuote(layoutCommand('4x1')),
    tmuxDoubleQuote('2행 2열'), '2', tmuxDoubleQuote(layoutCommand('2x2')),
    tmuxDoubleQuote(''),
    tmuxDoubleQuote('리더 열 왼쪽 생성'), '[', tmuxDoubleQuote(layoutCommand('leader-left')),
    tmuxDoubleQuote('리더 열 오른쪽 생성'), ']', tmuxDoubleQuote(layoutCommand('leader-right')),
    tmuxDoubleQuote('생성한 리더 열 삭제'), 'x', tmuxDoubleQuote(layoutCommand('leader-remove')),
  ].join(' ')

  tmuxScript([
    `bind-key -T root MouseDown1Pane select-pane -t = \\; send-keys -M \\; if-shell -F '#{m/r:^cbridge-leaders-,#{session_name}}' 'set-option -pt = @cbridge_ack_click "#{client_activity}"'`,
  ].join('\n'))

  tmux([
    'bind-key',
    '-T',
    'root',
    'MouseDown3Pane',
    'if-shell',
    '-F',
    '#{m/r:^cbridge-leaders-,#{session_name}}',
    leaderMenu,
    defaultPaneMenu,
  ])
}

function getTmuxTitleHeaders(): TmuxTitleHeaderPane[] {
  const headers: TmuxTitleHeaderPane[] = []
  const out = tmuxOutput([
    'list-panes',
    '-a',
    '-F',
    '#{session_name}\t#{pane_id}\t#{@cbridge_header_for}\t#{@cbridge_title_header_version}',
  ])

  for (const line of out.split('\n')) {
    const [sessionName, paneId, headerFor, version] = line.split('\t')
    if (!sessionName || !isCbridgeTitleSession(sessionName)) continue
    if (!paneId || !headerFor?.startsWith('%')) continue
    headers.push({ sessionName, paneId, headerFor, version, target: paneId })
  }
  return headers
}

function cleanupTmuxTitleHeaders(headers: TmuxTitleHeaderPane[], livePaneIds: Set<string>): void {
  const seen = new Set<string>()
  for (const header of headers) {
    if (
      header.version !== PANE_TITLE_HEADER_VERSION ||
      !livePaneIds.has(header.headerFor) ||
      seen.has(header.headerFor) ||
      !shouldUsePaneTitleHeader(header.sessionName)
    ) {
      tmux(['kill-pane', '-t', header.target])
      continue
    }
    seen.add(header.headerFor)
  }
}

function tmuxTitleHeaderCommand(targetPaneId: string): string {
  const interval = String(Math.max(1, DASHBOARD_REFRESH_MS / 1000))
  return [
    'while :; do',
    `line1=$(tmux display-message -p -t ${shellQuote(targetPaneId)} ${shellQuote('#{@cbridge_title_line_1}')} 2>/dev/null) || exit 0;`,
    `line2=$(tmux display-message -p -t ${shellQuote(targetPaneId)} ${shellQuote('#{@cbridge_title_line_2}')} 2>/dev/null) || exit 0;`,
    `printf '\\033[?7l\\033[?25l\\033[H\\033[2K\\033[96;1m%s\\033[0m\\n\\033[2K\\033[93;1m%s\\033[0m' "$line1" "$line2";`,
    `sleep ${shellQuote(interval)};`,
    'done',
  ].join(' ')
}

function ensureTmuxTitleHeader(pane: TmuxPane, roomId: string, headersByPane: Map<string, TmuxTitleHeaderPane>): void {
  const existing = headersByPane.get(pane.paneId)
  if (existing) {
    tmux(['resize-pane', '-t', existing.target, '-y', '2'])
    tmux(['select-pane', '-t', existing.target, '-T', ''])
    return
  }
  if (pane.height < 8) return

  const headerId = tmuxOutput([
    'split-window',
    '-v',
    '-b',
    '-l',
    '3',
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
    headerFor: pane.paneId,
    version: PANE_TITLE_HEADER_VERSION,
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
  if (!path) return '최근 프롬프트 확인 불가'
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
  const selectedBefore = new Map(activeLeaderPaneByWindow)
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
    const unread = updateLeaderUnreadState(pane, filePath, selectedNow, selectedBefore, processInfo.roomId)
    unreadByPane.set(pane.paneId, unread)
    if (unread && (pane.windowName === 'A' || pane.windowName === 'B')) {
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
      ? promptForLeaderPid(pane.panePid, roomId, files)
      : (promptByRoom.get(roomId) ?? '응답자 세션')
    const workLabel = isIssueLikeId(roomId)
      ? roomId
      : (filePath ? latestWorkLabelFromFile(filePath) : workLabelByRoom.get(roomId))
    const prefix = titlePrefixForPane(pane, roomId, workLabel)
    const unread = pane.role === 'leader' && unreadByPane.get(pane.paneId) === true
    const visiblePrefix = unread ? `${pane.displayIndex}번 새 답변 · ${prefix}` : prefix
    const [line1, line2] = titleLines(visiblePrefix, prompt, pane.width)
    const shortPrompt = line2 ? `${line1} ${line2}` : line1
    const borderTitle = unread
      ? `#[fg=colour46,bold]${line1} #[fg=colour245]│ #[fg=colour229,bold]${line2}`
      : `#[fg=colour14,bold]${line1} #[fg=colour245]│ #[fg=colour229,bold]${line2}`
    tmux(['set-option', '-pt', pane.target, '@cbridge_room', roomId])
    tmux(['set-option', '-pt', pane.target, '@cbridge_work_label', workLabel ?? ''])
    tmux(['set-option', '-pt', pane.target, '@cbridge_prompt', shortPrompt])
    tmux(['set-option', '-pt', pane.target, '@cbridge_unread', unread ? '1' : ''])
    tmux(['set-option', '-pt', pane.target, '@cbridge_display_index', String(pane.displayIndex)])
    tmux(['set-option', '-pt', pane.target, '@cbridge_title_line_1', line1])
    tmux(['set-option', '-pt', pane.target, '@cbridge_title_line_2', line2])
    tmux(['set-option', '-pt', pane.target, '@cbridge_border_title', borderTitle])
    if (shouldUsePaneTitleHeader(pane.sessionName)) {
      ensureTmuxTitleHeader(pane, roomId, headersByPane)
    }
    if (pane.sessionName.startsWith('cbridge-leaders-')) {
      tmux(['set-window-option', '-t', pane.target, 'pane-border-status', 'top'])
      tmux(['set-window-option', '-t', pane.target, 'pane-border-format', ' #{@cbridge_border_title} '])
    } else {
      tmux(['set-window-option', '-t', pane.target, 'pane-border-status', 'off'])
      tmux(['set-window-option', '-u', '-t', pane.target, 'pane-border-format'])
    }
  }

  for (const sessionName of touchedSessions) {
    tmux(['set-option', '-t', sessionName, 'mouse', shouldUseNativeTerminalSelection(sessionName) ? 'off' : 'on'])
    if (sessionName.startsWith('cbridge-leaders-')) {
      tmux(['set-option', '-t', sessionName, 'focus-events', 'on'])
    }
    tmux(['set-option', '-t', sessionName, 'set-titles', 'off'])
    tmux(['set-option', '-t', sessionName, 'status', 'off'])
    tmux(['set-option', '-u', '-t', sessionName, 'status-format[0]'])
    tmux(['set-option', '-u', '-t', sessionName, 'status-format[1]'])
  }
}

async function watchTmuxPaneTitles(): Promise<void> {
  while (true) {
    updateTmuxPaneTitlesOnce()
    await Bun.sleep(DASHBOARD_REFRESH_MS)
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
  const promptWidth = Math.max(26, Math.min(terminalWidth - 6, 110))
  console.log(`  ${C.bold}${C.bcyan}최근 leader 프롬프트${C.reset}  ${C.dim}${Math.round(DASHBOARD_REFRESH_MS / 1000)}초마다 자동 갱신${C.reset}`)
  for (const item of summaries) {
    console.log(`  ${C.bold}${C.bcyan}${item.roomId}${C.reset}`)
    console.log(`    ${C.byellow}${truncateVisible(item.prompt, promptWidth)}${C.reset}`)
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

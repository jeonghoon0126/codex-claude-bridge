#!/usr/bin/env bun
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CodexAppClient, type JsonRpcMessage } from './codex-app-client.ts'
import { codexPeerTurnTimeoutMs } from './bridge-timeouts.ts'
const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const DEFAULT_CWD = process.env.CODEX_PEER_CWD ?? process.cwd()
const DEFAULT_MODEL = process.env.CODEX_PEER_MODEL ?? process.env.CODEX_WEB_MODEL ?? 'gpt-5.5'
const SANDBOX = process.env.CODEX_PEER_SANDBOX ?? 'read-only'
const APPROVAL_POLICY = process.env.CODEX_PEER_APPROVAL_POLICY ?? 'never'
const POLL_TIMEOUT_MS = Number(process.env.CODEX_PEER_POLL_TIMEOUT_MS ?? 30000)
const TURN_TIMEOUT_MS = codexPeerTurnTimeoutMs()
type BridgeMessage = { id: string; text: string; sender: string }
type RoleConfig = { name: string; claudeRole: string; codexRole: string }
type PendingTurn = { output: string; timer: ReturnType<typeof setTimeout>; resolve: (value: string) => void; reject: (error: Error) => void }
type PeerStateFile = { rooms?: Record<string, { threadId?: string; updatedAt?: number }> }
const STATE_PATH = process.env.CODEX_PEER_STATE_PATH ?? join(homedir(), '.codex-claude-bridge', 'peer-sessions.json')
function readPidFile(pid: number): string {
  try { return readFileSync(`/tmp/claude-bridge-room-${pid}`, 'utf8').trim() } catch { return '' }
}
function readStateThread(roomId: string): string | undefined {
  try {
    if (!existsSync(STATE_PATH)) return undefined
    const data = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PeerStateFile
    return data.rooms?.[roomId]?.threadId
  } catch {
    return undefined
  }
}
function writeStateThread(roomId: string, id: string): void {
  try {
    const data: PeerStateFile = existsSync(STATE_PATH)
      ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PeerStateFile
      : {}
    data.rooms = data.rooms ?? {}
    data.rooms[roomId] = { threadId: id, updatedAt: Date.now() }
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, `${JSON.stringify(data, null, 2)}\n`)
  } catch {}
}
function parentPid(pid: number): number {
  try {
    return parseInt(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }).toString().trim(), 10)
  } catch {
    return 0
  }
}
function roomFromPidFile(): string {
  let pid = process.ppid ?? 0
  for (let i = 0; i < 4; i++) {
    if (!pid || isNaN(pid)) break
    const content = readPidFile(pid)
    if (content) return content.split(':')[0] ?? ''
    pid = parentPid(pid)
  }
  return ''
}
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || roomFromPidFile()
if (!ROOM_ID) {
  process.stderr.write('codex-peer-agent: CODEX_BRIDGE_ROOM is required\n')
  process.exit(1)
}
const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`
let threadId: string | undefined = process.env.CODEX_PEER_THREAD_ID || readStateThread(ROOM_ID)
let roleConfig: RoleConfig | null = null
let pendingTurn: PendingTurn | null = null
const client = new CodexAppClient({
  requestTimeoutMs: TURN_TIMEOUT_MS,
  onNotification,
  onServerRequest,
})
async function fetchRoleConfig(): Promise<RoleConfig | null> {
  try {
    const res = await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = await res.json() as { roleTemplate?: RoleConfig | null }
    return data.roleTemplate ?? null
  } catch {
    return null
  }
}
async function connect(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/claude/connect`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 404) process.exit(0)
  } catch {}
}
async function unregister(): Promise<void> {
  try {
    await fetch(`${BASE}/claude/connect`, { method: 'DELETE', signal: AbortSignal.timeout(3000) })
  } catch {}
}
async function ensureThread(): Promise<string> {
  await client.start()
  if (threadId) {
    try {
      await client.request('thread/resume', { threadId, cwd: DEFAULT_CWD })
      writeStateThread(ROOM_ID, threadId)
      return threadId
    } catch {
      threadId = undefined
    }
  }
  const result = await client.request('thread/start', {
    model: DEFAULT_MODEL,
    cwd: DEFAULT_CWD,
    sandbox: SANDBOX,
    approvalPolicy: APPROVAL_POLICY,
    serviceName: 'codex_bridge_peer',
  })
  threadId = result?.thread?.id
  if (!threadId) throw new Error('Codex peer thread start failed')
  writeStateThread(ROOM_ID, threadId)
  return threadId
}
function promptFor(message: BridgeMessage): string {
  const roleBlock = roleConfig
    ? `\nRole template: ${roleConfig.name}\n${roleConfig.claudeRole}\n`
    : ''
  return [
    `You are the responder in a Codex-Codex Bridge room: ${ROOM_ID}.`,
    'The primary Codex agent is asking for critique, analysis, or a second pass.',
    'Reply with the final answer only. Do not ask the primary agent to wait.',
    'Do not edit files unless the prompt explicitly asks you to produce a patch.',
    roleBlock,
    `Message id: ${message.id}`,
    `Sender: ${message.sender}`,
    '',
    message.text,
  ].join('\n')
}
async function runTurn(message: BridgeMessage): Promise<string> {
  const id = await ensureThread()
  return await new Promise<string>((resolve, reject) => {
    pendingTurn = {
      output: '',
      resolve,
      reject,
      timer: setTimeout(() => {
        const current = pendingTurn
        pendingTurn = null
        threadId = undefined
        client.stop()
        current?.reject(new Error(`Codex peer timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s`))
      }, TURN_TIMEOUT_MS),
    }
    client.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: promptFor(message) }],
      approvalPolicy: APPROVAL_POLICY,
    }).catch(error => {
      if (pendingTurn) clearTimeout(pendingTurn.timer)
      pendingTurn = null
      threadId = undefined
      client.stop()
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}
async function replyToBridge(replyTo: string, text: string): Promise<void> {
  const res = await fetch(`${BASE}/from-claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, replyTo, proactive: false }),
  })
  if (!res.ok) throw new Error(`bridge reply failed: ${res.status}`)
}
async function onNotification(message: JsonRpcMessage): Promise<void> {
  if (!pendingTurn) return
  if (message.method === 'item/agentMessage/delta') {
    pendingTurn.output += message.params?.delta ?? ''
    return
  }
  if (message.method !== 'turn/completed') return
  const current = pendingTurn
  pendingTurn = null
  clearTimeout(current.timer)
  const status = message.params?.turn?.status ?? 'completed'
  current.resolve(current.output.trim() || `Codex peer completed with status: ${status}`)
}
async function onServerRequest(message: JsonRpcMessage, app: CodexAppClient): Promise<void> {
  if (message.id === undefined) return
  if (message.method?.includes('requestApproval')) {
    app.respond(message.id, { decision: 'decline' })
    return
  }
  if (message.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(message.params?.questions) ? message.params.questions : []
    const answers = Object.fromEntries(questions.map((q: { id: string }) => [q.id, { answers: [''] }]))
    app.respond(message.id, { answers })
    return
  }
  app.respondError(message.id, `Unsupported Codex peer request: ${message.method}`)
}
async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(`${BASE}/pending-for-claude?timeout=${POLL_TIMEOUT_MS}`, {
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000),
      })
      if (res.status === 404) process.exit(0)
      if (!res.ok) { await Bun.sleep(1000); continue }
      const { messages } = await res.json() as { messages: BridgeMessage[] }
      for (const message of messages) {
        try {
          const reply = await runTurn(message)
          await replyToBridge(message.id, reply)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await replyToBridge(message.id, `Codex peer failed: ${reason}`)
        }
      }
    } catch {
      await Bun.sleep(1000)
    }
  }
}
process.on('exit', () => { void unregister() })
process.on('SIGINT', () => { void unregister().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void unregister().finally(() => process.exit(0)) })
roleConfig = await fetchRoleConfig()
await connect()
setInterval(connect, 1000)
process.stderr.write(`[codex-peer-agent] room=${ROOM_ID} model=${DEFAULT_MODEL} cwd=${DEFAULT_CWD}\n`)
await pollLoop()

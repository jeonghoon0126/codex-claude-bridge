#!/usr/bin/env bun
/**
 * Codex Bridge — MCP server for the Codex CLI side (multi-room).
 *
 * Runs as an MCP server that Codex CLI connects to.
 * Add to Codex's MCP config:
 *   [mcp_servers.codex-bridge]
 *   command = "bun"
 *   args = ["/path/to/codex-claude-bridge/codex-mcp.ts"]
 *   env = { CODEX_BRIDGE_ROOM = "ENG-1234" }
 *
 * Or set CODEX_BRIDGE_ROOM before launching:
 *   CODEX_BRIDGE_ROOM=ENG-1234 codex --full-auto
 *
 * Tools:
 *   send_to_claude(message) — Send a message to Claude. Blocks until Claude replies (~60 min max).
 *   check_claude_messages() — Check if Claude has sent any proactive messages.
 *   send_to_codex_peer(message) — Alias for Codex-Codex rooms.
 *   check_codex_peer_messages() — Alias for Codex-Codex rooms.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { codexMcpTotalWaitMs } from './bridge-timeouts.ts'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const PEER_NAME = process.env.CODEX_BRIDGE_PEER_NAME ?? 'Codex peer'
const TOTAL_WAIT_MS = codexMcpTotalWaitMs()
const POLL_SLICE_MS = 15000
const POLL_ABORT_GRACE_MS = 3000

// Codex may strip env vars when spawning MCP servers.
// Fallback: bridge-codex writes /tmp/codex-bridge-room-<pid> before execing Codex.
// Process ancestry differs between Codex releases, so walk nearby parents instead of
// relying on one fixed parent depth.
function getRoomAndTokenFromPidFile(): { roomId: string; token: string } {
  const readBridgeFile = (pid: number) => {
    try {
      return readFileSync(`/tmp/codex-bridge-room-${pid}`, 'utf8').trim()
    } catch {
      return ''
    }
  }

  const parentPid = (pid: number) => {
    try {
      const raw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 })
        .toString().trim()
      const parsed = parseInt(raw, 10)
      return parsed && !isNaN(parsed) ? parsed : 0
    } catch {
      return 0
    }
  }

  try {
    const seen = new Set<number>()
    let pid = process.pid
    let content = ''

    for (let i = 0; i < 8 && pid > 1 && !seen.has(pid); i++) {
      seen.add(pid)
      content = readBridgeFile(pid)
      if (content) break
      pid = parentPid(pid)
    }

    if (!content) return { roomId: '', token: '' }
    const idx = content.indexOf(':')
    if (idx === -1) return { roomId: content, token: '' }
    return { roomId: content.slice(0, idx), token: content.slice(idx + 1) }
  } catch {
    return { roomId: '', token: '' }
  }
}

const { roomId: pidFileRoom } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const HAS_ROOM = Boolean(ROOM_ID)

if (!HAS_ROOM) {
  process.stderr.write('codex-mcp: no bridge room bound; starting without bridge tools\n')
}

const BASE = HAS_ROOM ? `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}` : ''

// ── Fetch role config (retry up to 5s to handle race with room creation) ──
async function fetchRoleConfig(): Promise<{ name: string; codexRole: string } | null> {
  if (!HAS_ROOM) return null

  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json() as { roleTemplate: { name: string; claudeRole: string; codexRole: string } | null }
        if (data.roleTemplate) return { name: data.roleTemplate.name, codexRole: data.roleTemplate.codexRole }
      }
    } catch {}
    await Bun.sleep(1000)
  }
  return null
}

const roleConfig = await fetchRoleConfig()
if (roleConfig) {
  process.stderr.write(`[codex-mcp] role applied: ${roleConfig.name}\n`)
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const inFlightMessages = new Map<string, Promise<ToolResult>>()

function normalizeMessage(message: string) {
  return message.trim().replace(/\s+/g, ' ')
}

function formatElapsedMs(startMs: number) {
  return `${Math.round((Date.now() - startMs) / 1000)}s`
}

const mcp = new Server(
  { name: `codex-bridge-client:${ROOM_ID || 'unbound'}`, version: '0.3.0' },
  { capabilities: { tools: {} } },
)

const rolePreamble = roleConfig
  ? [
      `=== 역할 템플릿: ${roleConfig.name} ===`,
      roleConfig.codexRole,
      '이 역할에 맞게 상대 에이전트와 대화하세요. 역할에 어긋나는 단순 동의나 중립 응답은 피하세요.',
      '',
    ].join(' ')
  : ''

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!HAS_ROOM) return { tools: [] }

  return {
    tools: [
      {
        name: 'send_to_claude',
        description: [
          rolePreamble,
          `Send a message to Claude Code through Codex Bridge (room: ${ROOM_ID}) and wait for a reply.`,
          'This tool blocks until Claude responds (up to about 60 minutes).',
          'Use this to collaborate with Claude: ask questions, propose approaches,',
          'debate architecture decisions, or reach consensus on implementation details.',
          '',
          'IMPORTANT: This is a conversation tool. If Claude replies with a question,',
          'a counter-proposal, or consensus has not been reached, call this tool AGAIN.',
          'Keep calling it until you and Claude have fully resolved the topic.',
          'Do not call this tool concurrently with the same message.',
          'If it times out, do not immediately resend the exact same prompt.',
        ].filter(Boolean).join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to send to Claude' },
          },
          required: ['message'],
        },
      },
      {
        name: 'send_to_codex_peer',
        description: [
          rolePreamble,
          `Send a message to the second Codex agent through Codex Bridge (room: ${ROOM_ID}) and wait for a reply.`,
          'This tool blocks until the Codex peer responds.',
          'Use this when running bridge-codex-peer on the responder side.',
          'Keep calling it until the discussion has fully resolved the topic.',
          'Do not call this tool concurrently with the same message.',
        ].filter(Boolean).join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to send to the Codex peer' },
          },
          required: ['message'],
        },
      },
      {
        name: 'check_claude_messages',
        description: [
          'Check if Claude has sent any proactive messages in this room.',
          'Returns pending messages from Claude that you have not seen yet.',
        ].join(' '),
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'check_codex_peer_messages',
        description: [
          'Check if the Codex peer has sent any proactive messages in this room.',
          'Returns pending messages from the Codex peer that you have not seen yet.',
        ].join(' '),
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (!HAS_ROOM) {
    return {
      content: [{
        type: 'text',
        text: 'error: Codex Bridge room is not configured for this Codex session.',
      }],
      isError: true,
    }
  }

  try {
    switch (req.params.name) {
      case 'send_to_claude':
      case 'send_to_codex_peer': {
        const message = args.message as string
        const peerName = req.params.name === 'send_to_codex_peer' ? PEER_NAME : 'Claude'
        if (!message?.trim()) {
          return { content: [{ type: 'text', text: 'error: empty message' }], isError: true }
        }

        const normalized = normalizeMessage(message)
        const existing = inFlightMessages.get(normalized)
        if (existing) return await existing

        const requestPromise: Promise<ToolResult> = (async () => {
          const startedAt = Date.now()

          // Send message to bridge
          const sendRes = await fetch(`${BASE}/from-codex`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: message.trim() }),
          })

          if (!sendRes.ok) {
            const err = await sendRes.text()
            return {
              content: [{ type: 'text', text: `error sending to bridge: ${sendRes.status} ${err}` }],
              isError: true,
            }
          }

          const { id } = await sendRes.json() as { id: string }

          // Poll in short slices to avoid transport-layer timeouts
          while (Date.now() - startedAt < TOTAL_WAIT_MS) {
            const remainingMs = TOTAL_WAIT_MS - (Date.now() - startedAt)
            const pollTimeoutMs = Math.min(POLL_SLICE_MS, remainingMs)
            const controller = new AbortController()
            const clientTimeout = setTimeout(() => controller.abort(), pollTimeoutMs + POLL_ABORT_GRACE_MS)
            let pollRes: Response

            try {
              pollRes = await fetch(
                `${BASE}/poll-reply/${id}?timeout=${pollTimeoutMs}`,
                { signal: controller.signal },
              )
            } catch (e: unknown) {
              clearTimeout(clientTimeout)
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes('abort') || msg.includes('socket')) continue
              throw e
            }
            clearTimeout(clientTimeout)

            if (!pollRes.ok) {
              const errText = await pollRes.text()
              return {
                content: [{ type: 'text', text: `error polling reply: ${pollRes.status} ${errText}` }],
                isError: true,
              }
            }

            const result = await pollRes.json() as { timeout: boolean; reply: string | null }

            if (result.reply) {
              return { content: [{ type: 'text', text: result.reply }] }
            }

            if (!result.timeout) {
              return {
                content: [{
                  type: 'text',
                  text: `${peerName} returned no reply after ${formatElapsedMs(startedAt)}. Do not immediately resend the same prompt.`,
                }],
              }
            }
          }

          return {
            content: [{
              type: 'text',
              text: `${peerName} did not reply within ${formatElapsedMs(startedAt)}. Do not immediately resend the same prompt.`,
            }],
          }
        })()

        inFlightMessages.set(normalized, requestPromise)
        try {
          return await requestPromise
        } finally {
          if (inFlightMessages.get(normalized) === requestPromise) {
            inFlightMessages.delete(normalized)
          }
        }
      }

      case 'check_claude_messages':
      case 'check_codex_peer_messages': {
        const peerName = req.params.name === 'check_codex_peer_messages' ? PEER_NAME : 'Claude'
        const res = await fetch(`${BASE}/pending-for-codex`)
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `error checking messages: ${res.status}` }],
            isError: true,
          }
        }
        const { messages } = await res.json() as { messages: { id: string; text: string }[] }
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: `No pending messages from ${peerName}.` }] }
        }
        const formatted = messages.map(m => `[${m.id}] ${m.text}`).join('\n\n---\n\n')
        return { content: [{ type: 'text', text: `${messages.length} message(s) from ${peerName}:\n\n${formatted}` }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        content: [{
          type: 'text',
          text: `Cannot reach Codex Bridge at ${BRIDGE_URL}. Make sure bridge-server.ts is running.`,
        }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

const HEARTBEAT_INTERVAL_MS = 1000

// Codex MCP runs in its own process group (PGID = self), so it never receives
// SIGHUP when the Codex parent exits. Poll the parent PID directly instead.
function isParentAlive(): boolean {
  try { process.kill(process.ppid!, 0); return true } catch { return false }
}

async function heartbeat() {
  if (!HAS_ROOM) return

  if (!isParentAlive()) {
    process.stderr.write(`[codex-mcp] parent gone — exiting\n`)
    await unregister()
    process.exit(0)
  }
  try {
    const res = await fetch(`${BASE}/codex/heartbeat`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 404) {
      process.stderr.write(`[codex-mcp] room ${ROOM_ID} closed — exiting\n`)
      process.exit(0)
    }
  } catch {}
}

async function unregister() {
  if (!HAS_ROOM) return

  try {
    await fetch(`${BASE}/codex/heartbeat`, { method: 'DELETE', signal: AbortSignal.timeout(3000) })
  } catch {}
}

process.on('exit', () => { void unregister() })
process.on('SIGINT', () => { void unregister().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void unregister().finally(() => process.exit(0)) })

await mcp.connect(new StdioServerTransport())
if (HAS_ROOM) {
  await heartbeat()
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)
}
process.stderr.write(`codex-bridge-client: ready  room=${ROOM_ID || 'unbound'}  bridge=${BRIDGE_URL}\n`)

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type PendingInteraction =
  | { type: 'approval'; rpcId: string | number; method: string; summary: string; timer: ReturnType<typeof setTimeout> }
  | { type: 'input'; rpcId: string | number; questions: { id: string; question: string }[]; timer: ReturnType<typeof setTimeout> }

export type SmsSession = {
  from: string
  threadId?: string
  activeTurnId?: string
  startingTurn?: boolean
  pending?: PendingInteraction
  updatedAt: number
}

type StateFile = { sessions: Record<string, { threadId?: string; updatedAt: number }> }

export function loadSessions(path: string): {
  sessions: Map<string, SmsSession>
  threadToPhone: Map<string, string>
} {
  const sessions = new Map<string, SmsSession>()
  const threadToPhone = new Map<string, string>()
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as StateFile
    for (const [from, saved] of Object.entries(state.sessions ?? {})) {
      sessions.set(from, { from, threadId: saved.threadId, updatedAt: saved.updatedAt })
      if (saved.threadId) threadToPhone.set(saved.threadId, from)
    }
  } catch {}
  return { sessions, threadToPhone }
}

export function saveSessions(path: string, sessions: Map<string, SmsSession>): void {
  mkdirSync(dirname(path), { recursive: true })
  const state: StateFile = { sessions: {} }
  for (const [from, session] of sessions) {
    state.sessions[from] = { threadId: session.threadId, updatedAt: session.updatedAt }
  }
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

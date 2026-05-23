#!/usr/bin/env bun

import { homedir } from 'os'
import { join } from 'path'
import { CodexAppClient, type JsonRpcMessage } from './codex-app-client.ts'
import { approvalSummary, buildAnswers } from './sms-format.ts'
import { loadSessions, saveSessions, type SmsSession } from './sms-state.ts'
import { normalizePhone, sendSms, summarizeForSms, twiml, verifyTwilioSignature } from './twilio-sms-utils.ts'

const PORT = Number(process.env.CODEX_SMS_PORT ?? 8790)
const PUBLIC_URL = process.env.CODEX_SMS_PUBLIC_URL
const STATE_PATH = process.env.CODEX_SMS_STATE_PATH ?? join(homedir(), '.codex-sms-bridge', 'state.json')
const ALLOWED_FROM = new Set((process.env.CODEX_SMS_ALLOWED_FROM ?? '').split(',').map(s => s.trim()).filter(Boolean))
const APPROVAL_TIMEOUT_MS = Number(process.env.CODEX_SMS_APPROVAL_TIMEOUT_MS ?? 30 * 60 * 1000)
const DEFAULT_MODEL = process.env.CODEX_SMS_MODEL ?? 'gpt-5.5'
const DEFAULT_CWD = process.env.CODEX_SMS_CWD ?? homedir()
const loaded = loadSessions(STATE_PATH)
const sessions = loaded.sessions
const threadToPhone = loaded.threadToPhone
const turnOutput = new Map<string, string>()
let client: CodexAppClient | null = null

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') return Response.json({ ok: true, sessions: sessions.size })
    if (url.pathname !== '/twilio/sms' || req.method !== 'POST') return new Response('404', { status: 404 })

    const rawBody = await req.text()
    const form = new URLSearchParams(rawBody)
    if (!verifyTwilioSignature(req, form, rawBody, PUBLIC_URL)) return new Response('bad signature', { status: 403 })

    const from = normalizePhone(form.get('From') ?? '')
    const body = (form.get('Body') ?? '').trim()
    if (!isAllowed(from)) return twiml('허용된 번호가 아닙니다.')
    if (!body) return twiml('빈 문자는 처리하지 않았습니다.')

    const session = getSession(from)
    const immediate = await handleIncomingSms(session, body)
    saveState()
    return twiml(immediate)
  },
})

process.stderr.write(`[codex-sms] listening on http://127.0.0.1:${PORT}/twilio/sms\n`)

async function handleIncomingSms(session: SmsSession, body: string): Promise<string> {
  const normalized = body.trim().toUpperCase()

  if (session.pending?.type === 'approval') {
    if (!['YES', 'Y', 'NO', 'N'].includes(normalized)) return '승인 대기 중입니다. YES 또는 NO로 답장하세요.'
    const pending = session.pending
    clearTimeout(pending.timer)
    session.pending = undefined
    getClient().respond(pending.rpcId, { decision: normalized.startsWith('Y') ? 'accept' : 'decline' })
    return normalized.startsWith('Y') ? '승인했습니다. 작업을 계속 진행합니다.' : '거절했습니다. 작업을 멈추고 이어서 정리합니다.'
  }

  if (session.pending?.type === 'input') {
    const pending = session.pending
    clearTimeout(pending.timer)
    session.pending = undefined
    getClient().respond(pending.rpcId, { answers: buildAnswers(pending.questions, body) })
    return '답변을 전달했습니다. 작업을 계속 진행합니다.'
  }

  if (normalized === '/NEW') {
    session.threadId = undefined
    session.activeTurnId = undefined
    return '새 Codex 세션으로 시작합니다. 다음 문자를 프롬프트로 보내세요.'
  }

  if (normalized === '/STATUS') {
    if (session.pending) return 'Codex가 확인을 기다리고 있습니다.'
    if (session.startingTurn || session.activeTurnId) return 'Codex가 작업 중입니다. 추가 지시는 이어서 보내면 됩니다.'
    return session.threadId ? '대기 중입니다. 다음 지시를 보내세요.' : '세션이 없습니다. 첫 지시를 보내세요.'
  }

  void startOrSteerTurn(session, body).catch(async error => {
    await sendSms(session.from, `Codex 오류: ${error instanceof Error ? error.message : String(error)}`)
  })
  return session.startingTurn || session.activeTurnId
    ? '추가 지시를 Codex에 전달했습니다.'
    : 'Codex에 전달했습니다. 끝나면 결과를 문자로 보냅니다.'
}

async function startOrSteerTurn(session: SmsSession, text: string): Promise<void> {
  const app = getClient()
  if ((session.startingTurn || session.activeTurnId) && session.threadId) {
    await app.request('turn/steer', { threadId: session.threadId, input: [{ type: 'text', text }] })
    return
  }

  const threadId = await ensureThread(session)
  session.startingTurn = true
  let result: any
  try {
    result = await app.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      approvalPolicy: 'on-request',
    })
  } finally {
    session.startingTurn = false
  }
  session.activeTurnId = result?.turn?.id
  session.updatedAt = Date.now()
}

async function ensureThread(session: SmsSession): Promise<string> {
  const app = getClient()
  if (session.threadId) {
    try {
      await app.request('thread/resume', { threadId: session.threadId, cwd: DEFAULT_CWD })
      threadToPhone.set(session.threadId, session.from)
      return session.threadId
    } catch {
      session.threadId = undefined
    }
  }

  const result = await app.request('thread/start', {
    model: DEFAULT_MODEL,
    cwd: DEFAULT_CWD,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    serviceName: 'codex_sms_bridge',
  })
  session.threadId = result?.thread?.id
  if (!session.threadId) throw new Error('Codex thread 생성 실패')
  threadToPhone.set(session.threadId, session.from)
  return session.threadId
}

function getClient(): CodexAppClient {
  if (!client) client = new CodexAppClient({ onNotification, onServerRequest })
  return client
}

async function onNotification(message: JsonRpcMessage): Promise<void> {
  const { method, params } = message
  if (method === 'item/agentMessage/delta') {
    const key = `${params.threadId}:${params.turnId}`
    turnOutput.set(key, `${turnOutput.get(key) ?? ''}${params.delta ?? ''}`)
    return
  }

  if (method !== 'turn/completed') return
  const threadId = params.threadId as string
  const turnId = params.turn?.id as string | undefined
  const phone = threadToPhone.get(threadId)
  if (!phone || !turnId) return

  const session = getSession(phone)
  session.startingTurn = false
  session.activeTurnId = undefined
  session.updatedAt = Date.now()

  const key = `${threadId}:${turnId}`
  const text = summarizeForSms(turnOutput.get(key) || `완료 상태: ${params.turn?.status ?? 'completed'}`)
  turnOutput.delete(key)
  await sendSms(phone, text)
  saveState()
}

async function onServerRequest(message: JsonRpcMessage, app: CodexAppClient): Promise<void> {
  const params = message.params ?? {}
  const phone = threadToPhone.get(params.threadId)
  if (!phone || message.id === undefined) {
    if (message.id !== undefined) app.respondError(message.id, 'No SMS session for this thread')
    return
  }

  const session = getSession(phone)
  if (session.pending) clearTimeout(session.pending.timer)

  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    const summary = approvalSummary(message, DEFAULT_CWD)
    session.pending = {
      type: 'approval',
      rpcId: message.id,
      method: message.method,
      summary,
      timer: setTimeout(() => expirePending(phone, message.id!), APPROVAL_TIMEOUT_MS),
    }
    await sendSms(phone, `${summary}\n승인하려면 YES, 거절하려면 NO로 답장하세요.`)
    return
  }

  if (message.method === 'item/tool/requestUserInput') {
    const questions = (params.questions ?? []).map((q: any) => ({ id: q.id, question: q.question }))
    session.pending = {
      type: 'input',
      rpcId: message.id,
      questions,
      timer: setTimeout(() => expirePending(phone, message.id!), APPROVAL_TIMEOUT_MS),
    }
    await sendSms(phone, `Codex 질문:\n${questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}`)
    return
  }

  app.respondError(message.id, `Unsupported server request over SMS: ${message.method}`)
}

function expirePending(phone: string, rpcId: string | number): void {
  const session = getSession(phone)
  const pending = session.pending
  if (!pending || pending.rpcId !== rpcId) return
  session.pending = undefined
  if (pending.type === 'approval') getClient().respond(rpcId, { decision: 'decline' })
  else getClient().respond(rpcId, { answers: buildAnswers(pending.questions, '') })
  void sendSms(phone, '응답 시간이 지나 Codex 요청을 닫았습니다.')
}

function isAllowed(from: string): boolean {
  return ALLOWED_FROM.size > 0 && ALLOWED_FROM.has(from)
}

function getSession(from: string): SmsSession {
  const existing = sessions.get(from)
  if (existing) return existing
  const session = { from, updatedAt: Date.now() }
  sessions.set(from, session)
  return session
}

function saveState(): void {
  saveSessions(STATE_PATH, sessions)
}

#!/usr/bin/env bun

import { mkdirSync, appendFileSync, existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { homedir } from 'os'
import { dirname, join, basename } from 'path'
import { CodexAppClient, type JsonRpcMessage } from './codex-app-client.ts'
import { approvalSummary, buildAnswers } from './sms-format.ts'

type Pending =
  | { type: 'approval'; rpcId: string | number; method: string; summary: string; createdAt: number; timer: ReturnType<typeof setTimeout> }
  | { type: 'input'; rpcId: string | number; questions: { id: string; question: string }[]; createdAt: number; timer: ReturnType<typeof setTimeout> }

type Message = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'approval' | 'error' | 'trace'
  text: string
  createdAt: number
}

type WebSession = {
  id: string
  csrf: string
  createdAt: number
  lastSeen: number
}

type CodexTab = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  cwd: string
  source: 'web' | 'terminal'
  pinned: boolean
  sessionPath?: string
  threadId?: string
  activeTurnId?: string
  startingTurn: boolean
  pending?: Pending
  unreadSince?: number
  activeOutput: string
  activeTraceOutput: string
  messages: Message[]
}

type RateEntry = {
  count: number
  resetAt: number
}

type LoginFailure = RateEntry & {
  lockedUntil?: number
}

const PORT = Number(process.env.CODEX_WEB_PORT ?? 8791)
const HOST = process.env.CODEX_WEB_HOST ?? '127.0.0.1'
const TOKEN = process.env.CODEX_WEB_TOKEN || randomBytes(18).toString('base64url')
const PIN = process.env.CODEX_WEB_PIN || String(randomInt(0, 1000000)).padStart(6, '0')
const DEFAULT_MODEL = process.env.CODEX_WEB_MODEL ?? process.env.CODEX_SMS_MODEL ?? 'gpt-5.5'
const DEFAULT_CWD = process.env.CODEX_WEB_CWD ?? process.env.CODEX_SMS_CWD ?? homedir()
const CODEX_HOME = process.env.CODEX_WEB_CODEX_HOME ?? process.env.CODEX_HOME ?? detectCodexHome()
process.env.CODEX_HOME = CODEX_HOME
const DEFAULT_REASONING_EFFORT = process.env.CODEX_WEB_REASONING_EFFORT
  ?? process.env.CODEX_MODEL_REASONING_EFFORT
  ?? readCodexConfigValue('model_reasoning_effort')
  ?? 'xhigh'
const APPROVAL_TIMEOUT_MS = Number(process.env.CODEX_WEB_APPROVAL_TIMEOUT_MS ?? 30 * 60 * 1000)
const IDLE_TIMEOUT_MS = Number(process.env.CODEX_WEB_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000)
const ABSOLUTE_TIMEOUT_MS = Number(process.env.CODEX_WEB_ABSOLUTE_TIMEOUT_MS ?? 8 * 60 * 60 * 1000)
const LOGIN_LOCKOUT_MS = Number(process.env.CODEX_WEB_LOGIN_LOCKOUT_MS ?? 10 * 60 * 1000)
const MAX_PROMPT_CHARS = Number(process.env.CODEX_WEB_MAX_PROMPT_CHARS ?? 12000)
const AUDIT_LOG_PATH = process.env.CODEX_WEB_AUDIT_LOG_PATH ?? join(homedir(), '.codex-mobile-web', 'audit.jsonl')
const APP_ICON_PATH = join(process.cwd(), 'public', 'apple-touch-icon.png')
const COOKIE_SECURE = process.env.CODEX_WEB_COOKIE_SECURE !== 'false'
const ALLOWED_CF_EMAILS = new Set((process.env.CODEX_WEB_ALLOWED_CF_EMAILS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean))
const ALLOWED_CLIENT_CIDRS = (process.env.CODEX_WEB_ALLOWED_CLIENT_CIDRS ?? '').split(',').map(v => v.trim()).filter(Boolean)
const ALLOWED_CF_DEVICE_IDS = new Set((process.env.CODEX_WEB_ALLOWED_CF_DEVICE_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean))
const CF_DEVICE_HEADER = process.env.CODEX_WEB_CF_DEVICE_HEADER ?? 'cf-access-device-id'
const REQUIRE_CF_DEVICE = process.env.CODEX_WEB_REQUIRE_CF_DEVICE === 'true' || ALLOWED_CF_DEVICE_IDS.size > 0
const NETWORK_GATE_LABEL = ALLOWED_CLIENT_CIDRS.length > 0 ? 'VPN 필수' : 'PIN 보호'
const REQUIRE_CF_ACCESS = process.env.CODEX_WEB_REQUIRE_CF_ACCESS === 'true' || ALLOWED_CF_EMAILS.size > 0
const REQUIRE_BOOT_TOKEN = process.env.CODEX_WEB_REQUIRE_BOOT_TOKEN === 'true'
  || (process.env.CODEX_WEB_REQUIRE_BOOT_TOKEN !== 'false' && !REQUIRE_CF_ACCESS)
const SESSION_COOKIE = 'codex_web_session'
const BOOT_COOKIE = 'codex_web_boot'

let client: CodexAppClient | null = null
let updatedAt = Date.now()

let tabSequence = 0
let activeTabId = ''
const tabs = new Map<string, CodexTab>()
const sessions = new Map<string, WebSession>()
const bootSessions = new Map<string, number>()
const rateLimits = new Map<string, RateEntry>()
const loginFailures = new Map<string, LoginFailure>()
const codexStatusCache = new Map<string, { value: string; expiresAt: number }>()

activeTabId = createTab('작업 1').id

Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    try {
      const url = new URL(req.url)
      if (!edgePolicyAllows(req)) return edgeDeniedResponse(req, url)
      if (url.pathname === '/health') return json({ ok: true })
      if (url.pathname === '/apple-touch-icon.png' || url.pathname === '/apple-touch-icon-precomposed.png' || url.pathname === '/favicon.ico') return iconResponse()
      if (url.pathname === '/manifest.webmanifest') return manifestResponse()
      if (url.pathname === '/') return handleIndex(req, url)
      if (url.pathname === '/api/session' && req.method === 'GET') return handleSession(req)
      if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req)
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return htmlResponse()

      const session = requireSession(req)
      if (!session) return json({ error: 'unauthorized' }, 401)
      if (!checkRate(`api:${session.id}`, 180, 60 * 1000)) return json({ error: 'rate limited' }, 429)

      if (url.pathname === '/api/state' && req.method === 'GET') return json(publicState())
      if (url.pathname === '/api/terminal/sessions' && req.method === 'GET') return json({ sessions: terminalSessionSummaries() })
      if (!verifyCsrf(req, session)) return json({ error: 'invalid csrf' }, 403)

      if (url.pathname === '/api/prompt' && req.method === 'POST') return handlePrompt(req, session)
      if (url.pathname === '/api/approval' && req.method === 'POST') return handleApproval(req, session)
      if (url.pathname === '/api/input' && req.method === 'POST') return handleInput(req, session)
      if (url.pathname === '/api/new' && req.method === 'POST') return handleNew(session)
      if (url.pathname === '/api/tab/select' && req.method === 'POST') return handleSelectTab(req, session)
      if (url.pathname === '/api/tab/delete' && req.method === 'POST') return handleDeleteTab(req, session)
      if (url.pathname === '/api/tab/rename' && req.method === 'POST') return handleRenameTab(req, session)
      if (url.pathname === '/api/tab/pin' && req.method === 'POST') return handlePinTab(req, session)
      if (url.pathname === '/api/terminal/import' && req.method === 'POST') return handleImportTerminal(req, session)
      if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req)
      return json({ error: 'not found' }, 404)
    } catch (error) {
      audit('server_error', { message: error instanceof Error ? error.message : String(error) }, req)
      return json({ error: 'internal error' }, 500)
    }
  },
})

process.stderr.write(`[codex-web] listening on http://${HOST}:${PORT}/${REQUIRE_BOOT_TOKEN ? `?token=${TOKEN}` : ''}\n`)
if (process.env.CODEX_WEB_PRINT_PIN !== 'false') process.stderr.write(`[codex-web] PIN ${PIN}\n`)

function handleIndex(req: Request, url: URL): Response {
  if (url.searchParams.get('token') === TOKEN) {
    const bootId = randomId()
    bootSessions.set(bootId, Date.now())
    audit('bootstrap', {}, req)
    return redirect('/', [cookie(BOOT_COOKIE, bootId, { maxAge: 10 * 60, httpOnly: true })])
  }
  return htmlResponse()
}

function handleSession(req: Request): Response {
  const session = requireSession(req)
  if (session) return json({ authenticated: true, csrf: session.csrf, state: publicState() })
  return json({ authenticated: false, bootRequired: REQUIRE_BOOT_TOKEN, bootstrapped: !REQUIRE_BOOT_TOKEN || Boolean(validBoot(req)) }, 401)
}

async function handleLogin(req: Request): Promise<Response> {
  const ip = clientKey(req)
  const failure = loginFailures.get(ip)
  if (failure?.lockedUntil && failure.lockedUntil > Date.now()) {
    audit('login_locked', {}, req)
    return json({ error: 'locked' }, 429)
  }
  if (REQUIRE_BOOT_TOKEN && !validBoot(req)) {
    audit('login_no_bootstrap', {}, req)
    return json({ error: 'open the token link again', bootRequired: true, bootstrapped: false }, 401)
  }
  if (!checkRate(`login:${ip}`, 8, 10 * 60 * 1000)) return json({ error: 'rate limited' }, 429)

  const { pin } = await readJson(req, 1024)
  if (!safeEqual(String(pin ?? ''), PIN)) {
    recordLoginFailure(ip)
    audit('login_failed', {}, req)
    return json({ error: 'invalid pin' }, 401)
  }

  loginFailures.delete(ip)
  const session: WebSession = {
    id: randomId(),
    csrf: randomId(),
    createdAt: Date.now(),
    lastSeen: Date.now(),
  }
  sessions.set(session.id, session)
  audit('login_success', {}, req)
  return json(
    { ok: true, csrf: session.csrf, state: publicState() },
    200,
    [
      cookie(SESSION_COOKIE, session.id, { maxAge: Math.ceil(ABSOLUTE_TIMEOUT_MS / 1000), httpOnly: true }),
      cookie(BOOT_COOKIE, '', { maxAge: 0, httpOnly: true }),
    ],
  )
}

async function handlePrompt(req: Request, session: WebSession): Promise<Response> {
  if (!checkRate(`prompt:${session.id}`, 30, 60 * 1000)) return json({ error: 'rate limited' }, 429)
  const { text, tabId } = await readJson(req)
  const tab = tabForRequest(tabId)
  if (!tab) return json({ error: 'invalid tab' }, 400)
  activeTabId = tab.id
  const prompt = String(text ?? '').trim()
  if (!prompt) return json({ error: 'empty prompt' }, 400)
  if (prompt.length > MAX_PROMPT_CHARS) return json({ error: 'prompt too long' }, 400)
  markTabRead(tab)
  if (isDefaultTabTitle(tab)) tab.title = titleFromPrompt(prompt)
  tab.messages.push(makeMessage('user', prompt))
  audit('prompt', { length: prompt.length, hash: hashText(prompt) }, req)
  trimMessages(tab)
  touch(tab)
  void startOrSteerTurn(tab, prompt).catch(error => {
    tab.messages.push(makeMessage('error', error instanceof Error ? error.message : String(error)))
    tab.startingTurn = false
    tab.activeTurnId = undefined
    touch(tab)
  })
  return json({ ok: true })
}

async function handleApproval(req: Request, session: WebSession): Promise<Response> {
  if (!checkRate(`approval:${session.id}`, 40, 60 * 1000)) return json({ error: 'rate limited' }, 429)
  const { decision, pin, tabId } = await readJson(req, 1024)
  const tab = tabForRequest(tabId)
  if (!tab) return json({ error: 'invalid tab' }, 400)
  activeTabId = tab.id
  if (!safeEqual(String(pin ?? ''), PIN)) {
    audit('approval_bad_pin', { decision: String(decision ?? '') }, req)
    return json({ error: 'invalid pin' }, 401)
  }
  if (tab.pending?.type !== 'approval') return json({ error: 'no pending approval' }, 409)
  markTabRead(tab)
  const accept = String(decision).toLowerCase() === 'accept'
  const current = tab.pending
  clearTimeout(current.timer)
  tab.pending = undefined
  getClient().respond(current.rpcId, { decision: accept ? 'accept' : 'decline' })
  tab.messages.push(makeMessage('system', accept ? '승인했습니다.' : '거절했습니다.'))
  audit('approval', { decision: accept ? 'accept' : 'decline', summaryHash: hashText(current.summary) }, req)
  touch(tab)
  return json({ ok: true })
}

async function handleInput(req: Request, session: WebSession): Promise<Response> {
  if (!checkRate(`input:${session.id}`, 30, 60 * 1000)) return json({ error: 'rate limited' }, 429)
  const { text, tabId } = await readJson(req)
  const tab = tabForRequest(tabId)
  if (!tab) return json({ error: 'invalid tab' }, 400)
  activeTabId = tab.id
  if (tab.pending?.type !== 'input') return json({ error: 'no pending input' }, 409)
  const answer = String(text ?? '').trim()
  if (answer.length > MAX_PROMPT_CHARS) return json({ error: 'answer too long' }, 400)
  markTabRead(tab)
  const current = tab.pending
  clearTimeout(current.timer)
  tab.pending = undefined
  getClient().respond(current.rpcId, { answers: buildAnswers(current.questions, answer) })
  tab.messages.push(makeMessage('user', answer))
  audit('input', { length: answer.length, hash: hashText(answer) }, req)
  touch(tab)
  return json({ ok: true })
}

async function handleNew(session: WebSession): Promise<Response> {
  const tab = createTab()
  activeTabId = tab.id
  audit('new_session', { session: session.id, tab: tab.id }, undefined)
  touch(tab)
  return json({ ok: true, state: publicState() })
}

async function handleSelectTab(req: Request, session: WebSession): Promise<Response> {
  const { tabId } = await readJson(req, 1024)
  const tab = typeof tabId === 'string' ? tabs.get(tabId) : undefined
  if (!tab) return json({ error: 'invalid tab' }, 400)
  activeTabId = tab.id
  markTabRead(tab)
  audit('select_tab', { session: session.id, tab: tab.id }, req)
  touch(tab)
  return json({ ok: true, state: publicState() })
}

async function handleDeleteTab(req: Request, session: WebSession): Promise<Response> {
  const { tabId } = await readJson(req, 1024)
  const tab = typeof tabId === 'string' ? tabs.get(tabId) : undefined
  if (!tab) return json({ error: 'invalid tab' }, 400)
  if (tabs.size <= 1) {
    return json({ ok: true, kept: true, message: '마지막 탭은 유지됩니다.', state: publicState() })
  }
  if (!tabCanClose(tab)) return json({ error: 'tab is busy' }, 409)

  const wasActive = tab.id === activeTabId
  tabs.delete(tab.id)
  if (wasActive) {
    const next = Array.from(tabs.values()).sort((left, right) => right.updatedAt - left.updatedAt)[0]
    activeTabId = next.id
  }
  updatedAt = Date.now()
  audit('delete_tab', { session: session.id, tab: tab.id, wasActive }, req)
  return json({ ok: true, state: publicState() })
}

async function handleRenameTab(req: Request, session: WebSession): Promise<Response> {
  const { tabId, title } = await readJson(req, 2048)
  const tab = typeof tabId === 'string' ? tabs.get(tabId) : undefined
  if (!tab) return json({ error: 'invalid tab' }, 400)
  const nextTitle = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (!nextTitle) return json({ error: 'empty title' }, 400)
  tab.title = nextTitle.length > 40 ? `${nextTitle.slice(0, 40)}...` : nextTitle
  audit('rename_tab', { session: session.id, tab: tab.id, titleHash: hashText(tab.title) }, req)
  touch(tab)
  return json({ ok: true, state: publicState() })
}

async function handlePinTab(req: Request, session: WebSession): Promise<Response> {
  const { tabId, pinned } = await readJson(req, 1024)
  const tab = typeof tabId === 'string' ? tabs.get(tabId) : undefined
  if (!tab) return json({ error: 'invalid tab' }, 400)
  tab.pinned = Boolean(pinned)
  audit('pin_tab', { session: session.id, tab: tab.id, pinned: tab.pinned }, req)
  touch(tab)
  return json({ ok: true, state: publicState() })
}

async function handleImportTerminal(req: Request, session: WebSession): Promise<Response> {
  const { sessionId } = await readJson(req, 2048)
  const imported = importLatestTerminalSession(typeof sessionId === 'string' ? sessionId : undefined)
  if (!imported) return json({ error: 'no terminal session found' }, 404)

  const existing = Array.from(tabs.values()).find(tab => tab.threadId === imported.threadId)
  const tab = existing ?? createTab(imported.title, imported.cwd, 'terminal')
  tab.title = imported.title
  tab.threadId = imported.threadId
  tab.cwd = imported.cwd
  tab.source = 'terminal'
  tab.sessionPath = imported.path
  tab.messages = imported.messages
  markTabRead(tab)
  activeTabId = tab.id
  audit('import_terminal_session', { session: session.id, tab: tab.id, threadId: imported.threadId, pathHash: hashText(imported.path) }, req)
  touch(tab)
  return json({ ok: true, state: publicState() })
}

function handleLogout(req: Request): Response {
  const id = cookieValue(req, SESSION_COOKIE)
  if (id) sessions.delete(id)
  audit('logout', {}, req)
  return json({ ok: true }, 200, [cookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true })])
}

async function startOrSteerTurn(tab: CodexTab, text: string): Promise<void> {
  const app = getClient()
  if ((tab.startingTurn || tab.activeTurnId) && tab.threadId) {
    await app.request('turn/steer', { threadId: tab.threadId, input: [{ type: 'text', text }] })
    return
  }

  const id = await ensureThread(tab)
  tab.startingTurn = true
  tab.activeOutput = ''
  tab.activeTraceOutput = ''
  pushTrace(tab, '작업 시작\nCodex가 요청을 처리하기 시작했습니다.')
  touch(tab)
  let result: any
  try {
    result = await app.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text }],
      approvalPolicy: 'on-request',
    })
  } finally {
    tab.startingTurn = false
    touch(tab)
  }
  tab.activeTurnId = result?.turn?.id
  touch(tab)
}

async function ensureThread(tab: CodexTab): Promise<string> {
  const app = getClient()
  if (tab.threadId) {
    try {
      await app.request('thread/resume', { threadId: tab.threadId, cwd: tab.cwd })
      return tab.threadId
    } catch {
      tab.threadId = undefined
    }
  }

  const result = await app.request('thread/start', {
    model: DEFAULT_MODEL,
    cwd: tab.cwd,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    serviceName: 'codex_mobile_web',
  })
  tab.threadId = result?.thread?.id
  if (!tab.threadId) throw new Error('Codex thread 생성 실패')
  return tab.threadId
}

function getClient(): CodexAppClient {
  if (!client) client = new CodexAppClient({ onNotification, onServerRequest })
  return client
}

async function onNotification(message: JsonRpcMessage): Promise<void> {
  const { method, params } = message
  const tab = tabForCodexParams(params)
  const progress = progressTextForNotification(message)
  if (progress) pushTrace(tab, progress)

  if (method?.includes('commandExecution') && (method.includes('completed') || method.includes('end'))) {
    if (tab.activeTraceOutput.trim() && !traceOutputFromParams(params)) pushTrace(tab, `출력\n${tab.activeTraceOutput.trim()}`)
    tab.activeTraceOutput = ''
    touch(tab)
  }

  if (method?.includes('/delta') && !method.includes('agentMessage') && !method.includes('reasoning') && !method.includes('thought')) {
    appendTraceDelta(tab, traceOutputFromParams(params))
    return
  }

  if (method === 'item/agentMessage/delta') {
    tab.activeOutput += params.delta ?? ''
    touch(tab)
    return
  }

  if (method !== 'turn/completed') return
  tab.activeTurnId = undefined
  tab.startingTurn = false
  const status = params.turn?.status ?? 'completed'
  if (tab.activeTraceOutput.trim()) pushTrace(tab, `출력\n${tab.activeTraceOutput.trim()}`)
  tab.messages.push(makeMessage('assistant', tab.activeOutput.trim() || `완료 상태: ${status}`))
  markTabUnreadAfterCompletion(tab)
  tab.activeOutput = ''
  tab.activeTraceOutput = ''
  trimMessages(tab)
  touch(tab)
}

async function onServerRequest(message: JsonRpcMessage, app: CodexAppClient): Promise<void> {
  if (message.id === undefined) return
  const params = message.params ?? {}
  const tab = tabForCodexParams(params)
  if (tab.pending) clearTimeout(tab.pending.timer)

  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    const summary = approvalSummary(message, DEFAULT_CWD)
    pushTrace(tab, `승인 대기\n${summary}`)
    tab.pending = {
      type: 'approval',
      rpcId: message.id,
      method: message.method,
      summary,
      createdAt: Date.now(),
      timer: setTimeout(() => expirePending(tab.id, message.id!), APPROVAL_TIMEOUT_MS),
    }
    tab.messages.push(makeMessage('approval', summary))
    trimMessages(tab)
    touch(tab)
    return
  }

  if (message.method === 'item/tool/requestUserInput') {
    const questions = (params.questions ?? []).map((q: any) => ({ id: q.id, question: q.question }))
    pushTrace(tab, `입력 대기\n${questions.map((q: { question: string }, i: number) => `${i + 1}. ${q.question}`).join('\n')}`)
    tab.pending = {
      type: 'input',
      rpcId: message.id,
      questions,
      createdAt: Date.now(),
      timer: setTimeout(() => expirePending(tab.id, message.id!), APPROVAL_TIMEOUT_MS),
    }
    tab.messages.push(makeMessage('system', `Codex 질문\n${questions.map((q: { id: string; question: string }, i: number) => `${i + 1}. ${q.question}`).join('\n')}`))
    trimMessages(tab)
    touch(tab)
    return
  }

  app.respondError(message.id, `Unsupported browser request: ${message.method}`)
}

function progressTextForNotification(message: JsonRpcMessage): string {
  const method = message.method ?? ''
  const params = message.params ?? {}
  if (!method || method.includes('agentMessage/delta') || method.includes('reasoning') || method.includes('thought')) return ''

  if (method === 'turn/started' || method === 'turn/start') return '작업 시작\nCodex 턴이 시작됐습니다.'
  if (method === 'turn/completed') {
    const status = params.turn?.status ?? params.status ?? 'completed'
    return `작업 완료\n상태: ${status}`
  }

  if (method.includes('commandExecution')) {
    const command = commandTextFromParams(params)
    if (method.includes('started') || method.includes('start')) return `명령 실행\n${command || '명령을 실행 중입니다.'}${cwdText(params)}`
    if (method.includes('completed') || method.includes('end')) {
      const exit = params.exit_code ?? params.exitCode ?? params.result?.exit_code ?? params.result?.exitCode
      const output = traceOutputFromParams(params)
      return `명령 완료${exit !== undefined ? `\nexit: ${exit}` : ''}${command ? `\n${command}` : ''}${output ? `\n\n${clipText(output, 2400)}` : ''}`
    }
    if (!method.includes('delta')) return `명령 진행\n${command || method}`
  }

  if (method.includes('fileChange')) {
    const paths = filePathsFromParams(params)
    if (method.includes('completed') || method.includes('end')) return `파일 변경 완료${paths ? `\n${paths}` : ''}`
    if (method.includes('started') || method.includes('start')) return `파일 변경 중${paths ? `\n${paths}` : ''}`
    return `파일 변경 이벤트${paths ? `\n${paths}` : ''}`
  }

  if (method.includes('tool')) {
    const name = params.name ?? params.toolName ?? params.tool?.name ?? params.item?.name
    if (method.includes('started') || method.includes('start')) return `도구 실행\n${name ?? method}`
    if (method.includes('completed') || method.includes('end')) return `도구 완료\n${name ?? method}`
    return `도구 이벤트\n${name ?? method}`
  }

  if (method.startsWith('item/')) return `진행 이벤트\n${method}`
  return ''
}

function pushTrace(tab: CodexTab, text: string): void {
  const value = clipText(String(text ?? '').trim(), 3200)
  if (!value) return
  const last = tab.messages.at(-1)
  if (last?.role === 'trace' && last.text === value) return
  tab.messages.push(makeMessage('trace', value))
  trimMessages(tab)
  touch(tab)
}

function appendTraceDelta(tab: CodexTab, text: string): void {
  const value = String(text ?? '')
  if (!value.trim()) return
  tab.activeTraceOutput = clipText(`${tab.activeTraceOutput}${value}`, 5000)
  touch(tab)
}

function markTabRead(tab: CodexTab): void {
  tab.unreadSince = undefined
}

function markTabUnreadAfterCompletion(tab: CodexTab): void {
  if (tab.id === activeTabId) {
    markTabRead(tab)
    return
  }
  tab.unreadSince = Date.now()
}

function commandTextFromParams(params: any): string {
  const command = params?.command ?? params?.cmd ?? params?.argv ?? params?.item?.command ?? params?.result?.command
  if (Array.isArray(command)) return `$ ${command.map(String).join(' ')}`
  if (typeof command === 'string') return `$ ${command}`
  const parsed = params?.parsed_cmd ?? params?.parsedCommand
  if (Array.isArray(parsed) && parsed[0]?.cmd) return `$ ${String(parsed[0].cmd)}`
  return ''
}

function cwdText(params: any): string {
  const cwd = params?.cwd ?? params?.item?.cwd ?? params?.result?.cwd
  return typeof cwd === 'string' ? `\n작업 위치: ${cwd}` : ''
}

function traceOutputFromParams(params: any): string {
  const values = [
    params?.delta,
    params?.output,
    params?.aggregated_output,
    params?.aggregatedOutput,
    params?.stdout,
    params?.stderr,
    params?.result?.output,
    params?.result?.aggregated_output,
    params?.result?.stdout,
    params?.result?.stderr,
  ]
  return values.filter(value => typeof value === 'string' && value.length > 0).join('\n').trim()
}

function filePathsFromParams(params: any): string {
  const paths = params?.paths ?? params?.files ?? params?.changes ?? params?.item?.paths ?? params?.item?.files
  if (Array.isArray(paths)) {
    return paths
      .map(item => typeof item === 'string' ? item : item?.path ?? item?.file ?? item?.name)
      .filter(Boolean)
      .slice(0, 12)
      .map(String)
      .join('\n')
  }
  if (typeof paths === 'string') return paths
  const path = params?.path ?? params?.file ?? params?.item?.path
  return typeof path === 'string' ? path : ''
}

function expirePending(tabId: string, rpcId: string | number): void {
  const tab = tabs.get(tabId)
  if (!tab?.pending || tab.pending.rpcId !== rpcId) return
  const current = tab.pending
  tab.pending = undefined
  if (current.type === 'approval') getClient().respond(rpcId, { decision: 'decline' })
  else getClient().respond(rpcId, { answers: buildAnswers(current.questions, '') })
  tab.messages.push(makeMessage('system', '응답 시간이 지나 요청을 닫았습니다.'))
  touch(tab)
}

function publicState(): Record<string, unknown> {
  const tab = currentTab()
  return {
    activeTabId: tab.id,
    tabs: visibleTabs().map(tabSummary),
    active: Boolean(tab.activeTurnId || tab.startingTurn),
    anyActive: Array.from(tabs.values()).some(tab => tab.activeTurnId || tab.startingTurn),
    anyPending: Array.from(tabs.values()).some(tab => tab.pending),
    anyUnread: Array.from(tabs.values()).some(tab => tab.unreadSince),
    startingTurn: tab.startingTurn,
    activeOutput: tab.activeOutput,
    activeTraceOutput: tab.activeTraceOutput,
    pending: tab.pending ? withoutTimer(tab.pending) : undefined,
    messages: tab.messages,
    updatedAt,
    cwd: tab.cwd,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    codexStatus: codexStatusLine(tab),
  }
}

function withoutTimer(value: Pending): Record<string, unknown> {
  if (value.type === 'approval') return { type: value.type, summary: value.summary, createdAt: value.createdAt }
  return { type: value.type, questions: value.questions, createdAt: value.createdAt }
}

function createTab(title?: string, cwd = DEFAULT_CWD, source: CodexTab['source'] = 'web'): CodexTab {
  tabSequence += 1
  const now = Date.now()
  const tab: CodexTab = {
    id: randomId(),
    title: title || `작업 ${tabSequence}`,
    createdAt: now,
    updatedAt: now,
    cwd,
    source,
    pinned: false,
    startingTurn: false,
    activeOutput: '',
    activeTraceOutput: '',
    messages: [
      makeMessage('system', `모바일 Codex 세션 준비됨\n작업 위치: ${cwd}`),
    ],
  }
  tabs.set(tab.id, tab)
  touch(tab)
  return tab
}

function currentTab(): CodexTab {
  const existing = tabs.get(activeTabId)
  if (existing) return existing
  const first = tabs.values().next().value
  if (first) {
    activeTabId = first.id
    return first
  }
  const tab = createTab('작업 1')
  activeTabId = tab.id
  return tab
}

function tabForRequest(tabId: unknown): CodexTab | undefined {
  if (typeof tabId === 'string' && tabs.has(tabId)) return tabs.get(tabId)
  return currentTab()
}

function tabForCodexParams(params: any): CodexTab {
  const threadId = params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId ?? params?.item?.threadId
  if (typeof threadId === 'string') {
    const byThread = Array.from(tabs.values()).find(tab => tab.threadId === threadId)
    if (byThread) return byThread
  }

  const turnId = params?.turnId ?? params?.turn?.id ?? params?.item?.turnId
  if (typeof turnId === 'string') {
    const byTurn = Array.from(tabs.values()).find(tab => tab.activeTurnId === turnId)
    if (byTurn) return byTurn
  }

  const running = Array.from(tabs.values()).filter(tab => tab.activeTurnId || tab.startingTurn)
  if (running.length === 1) return running[0]
  return currentTab()
}

function tabSummary(tab: CodexTab): Record<string, unknown> {
  const status = codexStatusLine(tab)
  return {
    id: tab.id,
    title: tab.title,
    source: tab.source,
    pinned: tab.pinned,
    active: Boolean(tab.activeTurnId || tab.startingTurn),
    pending: tab.pending ? tab.pending.type : undefined,
    unread: Boolean(tab.unreadSince),
    unreadSince: tab.unreadSince,
    closable: tabCanClose(tab),
    codexStatus: status,
    shortCodexStatus: shortCodexStatusLine(status),
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  }
}

function tabCanClose(tab: CodexTab): boolean {
  return tabs.size > 1 && !tab.activeTurnId && !tab.startingTurn && !tab.pending
}

function visibleTabs(): CodexTab[] {
  return Array.from(tabs.values()).sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return left.createdAt - right.createdAt
  })
}

function isDefaultTabTitle(tab: CodexTab): boolean {
  return /^작업 \d+$/.test(tab.title)
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.replace(/\s+/g, ' ').trim()
  if (!firstLine) return `작업 ${tabSequence}`
  return firstLine.length > 18 ? `${firstLine.slice(0, 18)}...` : firstLine
}

type ImportedTerminalSession = {
  threadId: string
  path: string
  cwd: string
  title: string
  messages: Message[]
}

type TerminalSessionSummary = {
  id: string
  title: string
  cwd: string
  updatedAt: number
  updatedLabel: string
}

function importLatestTerminalSession(sessionId?: string): ImportedTerminalSession | undefined {
  const path = sessionId ? codexSessionPathById(sessionId) : latestCodexSessionPath()
  if (!path) return undefined

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  let threadId = ''
  let cwd = DEFAULT_CWD
  const importedMessages: Message[] = []

  for (const line of lines) {
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue

    if (record.type === 'session_meta') {
      if (typeof payload.id === 'string') threadId = payload.id
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      continue
    }

    if (record.type !== 'response_item' || payload.type !== 'message') continue
    if (payload.role !== 'user' && payload.role !== 'assistant') continue
    const text = textFromCodexContent(payload.content)
    if (!text) continue
    importedMessages.push(makeMessage(payload.role, clipText(text, 6000)))
  }

  if (!threadId) threadId = sessionIdFromFilename(path)
  if (!threadId) return undefined

  const recentMessages = importedMessages.slice(-80)
  const lastUser = [...importedMessages].reverse().find(message => message.role === 'user')?.text
  const title = `터미널 · ${titleFromPrompt(lastUser || basename(path).replace(/^rollout-/, '').replace(/\.jsonl$/, ''))}`
  const messages = [
    makeMessage('system', `터미널 Codex 세션을 가져왔습니다.\n작업 위치: ${cwd}\n동시에 터미널과 폰에서 같은 세션에 지시하면 충돌할 수 있습니다.`),
    ...recentMessages,
  ]

  return { threadId, path, cwd, title, messages }
}

function latestCodexSessionPath(): string | undefined {
  return listCodexSessionPaths()[0]
}

function codexSessionPathById(sessionId: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined
  return listCodexSessionPaths().find(path => sessionIdFromFilename(path) === sessionId || readSessionMeta(path).id === sessionId)
}

function terminalSessionSummaries(limit = 12): TerminalSessionSummary[] {
  return listCodexSessionPaths().slice(0, limit).map(path => {
    const meta = readSessionMeta(path)
    const updatedAt = statSync(path).mtimeMs
    const fallbackId = sessionIdFromFilename(path)
    const id = meta.id || fallbackId
    const titleSeed = lastUserMessage(path) || basename(path).replace(/^rollout-/, '').replace(/\.jsonl$/, '')
    return {
      id,
      title: `터미널 · ${titleFromPrompt(titleSeed)}`,
      cwd: meta.cwd || DEFAULT_CWD,
      updatedAt,
      updatedLabel: formatDateTime(updatedAt),
    }
  }).filter(item => item.id)
}

function listCodexSessionPaths(): string[] {
  const sessionsDir = join(CODEX_HOME, 'sessions')
  if (!existsSync(sessionsDir)) return []
  const files = collectJsonlFiles(sessionsDir)
  files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return files
}

function collectJsonlFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectJsonlFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

function textFromCodexContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const value = item as Record<string, unknown>
      return typeof value.text === 'string' ? value.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function readSessionMeta(path: string): { id?: string; cwd?: string } {
  try {
    const firstLine = readFileSync(path, 'utf8').split('\n')[0]
    const record = JSON.parse(firstLine)
    const payload = record.payload
    return {
      id: typeof payload?.id === 'string' ? payload.id : undefined,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
    }
  } catch {
    return {}
  }
}

function lastUserMessage(path: string): string {
  try {
    let last = ''
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      const payload = record.payload
      if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') continue
      const text = textFromCodexContent(payload.content)
      if (text) last = text
    }
    return last
  } catch {
    return ''
  }
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function clipText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...`
}

function sessionIdFromFilename(path: string): string {
  const match = basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match?.[1] ?? ''
}

function detectCodexHome(): string {
  try {
    const currentSlot = readFileSync(join(homedir(), '.codex-slots', '.current-slot'), 'utf8').trim()
    if (/^[1-7]$/.test(currentSlot)) {
      const slotHome = join(homedir(), '.codex-slots', `slot${currentSlot}`)
      if (existsSync(slotHome)) return slotHome
    }
  } catch {}
  return join(homedir(), '.codex')
}

type CodexTokenSnapshot = {
  contextWindow?: number
  turnTokens?: number
  totalTokens?: number
  rateLimits?: Record<string, any>
}

function readCodexConfigValue(key: string): string | undefined {
  try {
    const config = readFileSync(join(CODEX_HOME, 'config.toml'), 'utf8')
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = config.match(new RegExp(`^\\s*${escaped}\\s*=\\s*["']?([^"'\\n#]+)`, 'm'))
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

function codexStatusLine(tab: CodexTab): string {
  const now = Date.now()
  const cached = codexStatusCache.get(tab.id)
  if (cached && cached.expiresAt > now) return cached.value

  const snapshot = tokenSnapshotForTab(tab)
  const rateLimits = snapshot?.rateLimits ?? readLiveRateLimits()
  const parts = [`${DEFAULT_MODEL} ${DEFAULT_REASONING_EFFORT}`]

  if (snapshot?.contextWindow && snapshot.turnTokens !== undefined) {
    const left = Math.max(0, Math.min(100, Math.round(((snapshot.contextWindow - snapshot.turnTokens) / snapshot.contextWindow) * 100)))
    parts.push(`Context ${left}% left`)
  } else {
    parts.push('Context 확인 중')
  }

  const primaryLeft = remainingPercent(rateLimits?.primary?.used_percent)
  parts.push(primaryLeft !== undefined ? `5h ${primaryLeft}%` : '5h 확인 중')

  const weeklyLeft = remainingPercent(rateLimits?.secondary?.used_percent)
  parts.push(weeklyLeft !== undefined ? `weekly ${weeklyLeft}%` : 'weekly 확인 중')

  const value = parts.join(' · ')
  codexStatusCache.set(tab.id, { value, expiresAt: now + 15_000 })
  return value
}

function shortCodexStatusLine(value: string): string {
  return value
    .replace(`${DEFAULT_MODEL} ${DEFAULT_REASONING_EFFORT} · `, '')
    .replace('Context ', 'Ctx ')
    .replace(' left', '')
    .replace('weekly ', 'wk ')
}

function tokenSnapshotForTab(tab: CodexTab): CodexTokenSnapshot | undefined {
  const path = sessionPathForTab(tab)
  if (!path) return undefined
  return latestTokenSnapshot(path)
}

function sessionPathForTab(tab: CodexTab): string | undefined {
  if (tab.sessionPath && existsSync(tab.sessionPath)) return tab.sessionPath
  if (tab.threadId) {
    const direct = codexSessionPathById(tab.threadId)
    if (direct) return direct
    const byMeta = listCodexSessionPaths().find(path => readSessionMeta(path).id === tab.threadId)
    if (byMeta) return byMeta
  }
  return undefined
}

function latestTokenSnapshot(path: string): CodexTokenSnapshot | undefined {
  const text = readFileTail(path, 2_000_000)
  if (!text) return undefined
  let latest: CodexTokenSnapshot | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue
    try {
      const record = JSON.parse(line)
      const payload = record?.payload
      if (record?.type !== 'event_msg' || payload?.type !== 'token_count') continue
      const info = payload.info ?? {}
      latest = {
        contextWindow: numberOrUndefined(info.model_context_window),
        turnTokens: numberOrUndefined(info.last_token_usage?.total_tokens),
        totalTokens: numberOrUndefined(info.total_token_usage?.total_tokens),
        rateLimits: payload.rate_limits ?? latest?.rateLimits,
      }
    } catch {}
  }
  return latest
}

function readFileTail(path: string, maxBytes: number): string {
  let fd: number | undefined
  try {
    const size = statSync(path).size
    const length = Math.min(size, maxBytes)
    const start = Math.max(0, size - length)
    const buffer = Buffer.alloc(length)
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

function readLiveRateLimits(): Record<string, any> | undefined {
  try {
    const live = JSON.parse(readFileSync(join(CODEX_HOME, '.cache', 'work-dashboard', 'live-rate-limit.json'), 'utf8'))
    return live?.rate_limits
  } catch {
    return undefined
  }
}

function remainingPercent(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const used = Number(value)
  if (!Number.isFinite(used)) return undefined
  return Math.max(0, Math.min(100, Math.floor(100 - used)))
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function requireSession(req: Request): WebSession | null {
  const id = cookieValue(req, SESSION_COOKIE)
  if (!id) return null
  const session = sessions.get(id)
  if (!session) return null
  const now = Date.now()
  if (now - session.lastSeen > IDLE_TIMEOUT_MS || now - session.createdAt > ABSOLUTE_TIMEOUT_MS) {
    sessions.delete(id)
    audit('session_expired', { session: id }, req)
    return null
  }
  session.lastSeen = now
  return session
}

function verifyCsrf(req: Request, session: WebSession): boolean {
  return safeEqual(req.headers.get('x-csrf-token') ?? '', session.csrf)
}

function validBoot(req: Request): boolean {
  const id = cookieValue(req, BOOT_COOKIE)
  if (!id) return false
  const createdAt = bootSessions.get(id)
  if (!createdAt) return false
  if (Date.now() - createdAt > 10 * 60 * 1000) {
    bootSessions.delete(id)
    return false
  }
  return true
}

async function readJson(req: Request, maxBytes = 64 * 1024): Promise<any> {
  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (contentLength > maxBytes) throw new Error('request body too large')
  const raw = await req.text()
  if (raw.length > maxBytes) throw new Error('request body too large')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function checkRate(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const existing = rateLimits.get(key)
  if (!existing || existing.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  existing.count += 1
  return existing.count <= limit
}

function recordLoginFailure(key: string): void {
  const now = Date.now()
  const existing = loginFailures.get(key)
  const entry: LoginFailure = !existing || existing.resetAt <= now
    ? { count: 1, resetAt: now + LOGIN_LOCKOUT_MS }
    : { ...existing, count: existing.count + 1 }
  if (entry.count >= 5) entry.lockedUntil = now + LOGIN_LOCKOUT_MS
  loginFailures.set(key, entry)
}

function clientKey(req: Request): string {
  return req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'local'
}

function edgePolicyAllows(req: Request): boolean {
  if (REQUIRE_CF_ACCESS) {
    const email = req.headers.get('cf-access-authenticated-user-email')?.trim().toLowerCase()
    if (!email || (ALLOWED_CF_EMAILS.size > 0 && !ALLOWED_CF_EMAILS.has(email))) {
      audit('edge_denied_email', { email: email ? hashText(email) : undefined }, req)
      return false
    }
  }

  if (REQUIRE_CF_DEVICE) {
    const deviceId = req.headers.get(CF_DEVICE_HEADER)?.trim()
    if (!deviceId || (ALLOWED_CF_DEVICE_IDS.size > 0 && !ALLOWED_CF_DEVICE_IDS.has(deviceId))) {
      audit('edge_denied_device', { deviceHash: deviceId ? hashText(deviceId) : undefined }, req)
      return false
    }
  }

  if (ALLOWED_CLIENT_CIDRS.length > 0) {
    const ip = clientKey(req)
    if (!ALLOWED_CLIENT_CIDRS.some(cidr => cidrContains(ip, cidr))) {
      audit('edge_denied_ip', { ipHash: hashText(ip) }, req)
      return false
    }
  }

  return true
}

function cidrContains(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = splitCidr(cidr)
  const parsedIp = parseIpAddress(ip)
  const parsedBase = parseIpAddress(base)
  if (!parsedIp || !parsedBase || parsedIp.version !== parsedBase.version) return false
  const maxBits = parsedIp.version === 4 ? 32 : 128
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false
  return prefixMatches(parsedIp.bytes, parsedBase.bytes, bits)
}

function splitCidr(value: string): [string, string] {
  const index = value.lastIndexOf('/')
  if (index === -1) return [value, value.includes(':') ? '128' : '32']
  return [value.slice(0, index), value.slice(index + 1)]
}

function parseIpAddress(value: string): { version: 4 | 6; bytes: number[] } | undefined {
  const ip = normalizeIp(value)
  const ipv4 = ipv4ToInt(ip)
  if (ipv4 !== undefined) {
    return { version: 4, bytes: [(ipv4 >>> 24) & 255, (ipv4 >>> 16) & 255, (ipv4 >>> 8) & 255, ipv4 & 255] }
  }

  const ipv6 = ipv6ToBytes(ip)
  if (!ipv6) return undefined
  const mapped = mappedIpv4Bytes(ipv6)
  if (mapped) return { version: 4, bytes: mapped }
  return { version: 6, bytes: ipv6 }
}

function normalizeIp(value: string): string {
  let ip = value.trim()
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']')
    if (end !== -1) ip = ip.slice(1, end)
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'))
  }
  return ip.split('%')[0].toLowerCase()
}

function prefixMatches(left: number[], right: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  for (let i = 0; i < fullBytes; i += 1) {
    if (left[i] !== right[i]) return false
  }
  const remainingBits = bits % 8
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (left[fullBytes] & mask) === (right[fullBytes] & mask)
}

function ipv4ToInt(value: string): number | undefined {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function ipv6ToBytes(value: string): number[] | undefined {
  if (!value || value.includes(':::') || value.indexOf('::') !== value.lastIndexOf('::')) return undefined
  const hasCompression = value.includes('::')
  const [headRaw, tailRaw = ''] = value.split('::')
  const head = parseIpv6Parts(headRaw ? headRaw.split(':') : [])
  const tail = parseIpv6Parts(tailRaw ? tailRaw.split(':') : [])
  if (!head || !tail) return undefined
  const missing = 8 - head.length - tail.length
  if (hasCompression ? missing < 1 : missing !== 0) return undefined
  const words = hasCompression ? [...head, ...Array(missing).fill(0), ...tail] : head
  if (words.length !== 8) return undefined
  const bytes: number[] = []
  for (const word of words) bytes.push((word >>> 8) & 255, word & 255)
  return bytes
}

function parseIpv6Parts(parts: string[]): number[] | undefined {
  const words: number[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (!part) return undefined
    if (part.includes('.')) {
      if (i !== parts.length - 1) return undefined
      const ipv4 = ipv4ToInt(part)
      if (ipv4 === undefined) return undefined
      words.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff)
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined
    words.push(parseInt(part, 16))
  }
  return words
}

function mappedIpv4Bytes(bytes: number[]): number[] | undefined {
  if (bytes.length !== 16) return undefined
  const prefixIsZero = bytes.slice(0, 10).every(byte => byte === 0)
  if (!prefixIsZero || bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined
  return bytes.slice(12, 16)
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.get('cookie') ?? ''
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
}

function cookie(name: string, value: string, options: { maxAge: number; httpOnly: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${options.maxAge}`,
    'SameSite=Strict',
  ]
  if (options.httpOnly) parts.push('HttpOnly')
  if (COOKIE_SECURE) parts.push('Secure')
  return parts.join('; ')
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = secureHeaders()
  headers.set('location', location)
  for (const value of cookies) headers.append('set-cookie', value)
  return new Response(null, { status: 303, headers })
}

function edgeDeniedResponse(req: Request, url: URL): Response {
  const email = req.headers.get('cf-access-authenticated-user-email')?.trim().toLowerCase()
  const accessDenied = REQUIRE_CF_ACCESS && (!email || (ALLOWED_CF_EMAILS.size > 0 && !ALLOWED_CF_EMAILS.has(email)))
  if (accessDenied) {
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
      return json({
        error: 'access_required',
        message: 'Google Access 로그인을 먼저 통과하세요.',
      }, 403)
    }
    return new Response(accessDeniedHtml(), {
      status: 200,
      headers: secureHeaders({
        'content-type': 'text/html; charset=utf-8',
      }),
    })
  }

  const deviceId = req.headers.get(CF_DEVICE_HEADER)?.trim()
  const deviceDenied = REQUIRE_CF_DEVICE && (!deviceId || (ALLOWED_CF_DEVICE_IDS.size > 0 && !ALLOWED_CF_DEVICE_IDS.has(deviceId)))
  if (deviceDenied) {
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
      return json({
        error: 'device_required',
        message: '허용된 기기에서 다시 접속하세요.',
      }, 403)
    }
    return new Response(deviceDeniedHtml(), {
      status: 200,
      headers: secureHeaders({
        'content-type': 'text/html; charset=utf-8',
      }),
    })
  }

  const detectedIp = clientKey(req)
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return json({
      error: 'vpn_required',
      message: '회사 VPN을 켠 뒤 다시 접속하세요.',
      clientIp: detectedIp,
    }, 403)
  }
  return new Response(edgeDeniedHtml(detectedIp), {
    status: 200,
    headers: secureHeaders({
      'content-type': 'text/html; charset=utf-8',
    }),
  })
}

function deviceDeniedHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#182230">
<title>Codex Remote</title>
<style>
html, body { height: 100%; }
body { margin: 0; display: grid; place-items: center; padding: 24px; background: #eef2f7; color: #111827; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(100%, 390px); padding: 20px; border: 1px solid #d8dee8; border-radius: 8px; background: #fff; box-shadow: 0 18px 46px rgba(15,23,42,.12); }
h1 { margin: 0 0 8px; font-size: 20px; }
p { margin: 0; color: #667085; }
.pill { display: inline-flex; align-items: center; min-height: 25px; margin-bottom: 14px; padding: 0 9px; border: 1px solid #fedf89; border-radius: 999px; background: #fffaeb; color: #93370d; font-size: 12px; font-weight: 760; }
.hint { margin-top: 10px; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="pill">기기 확인 필요</div>
  <h1>허용된 기기가 아닙니다</h1>
  <p>Google 로그인은 통과했지만 현재 기기가 Codex Remote 허용 조건을 통과하지 못했습니다.</p>
  <p class="hint">Cloudflare WARP가 켜져 있는지 확인한 뒤 홈 화면 앱을 완전히 종료하고 다시 여세요.</p>
</main>
</body>
</html>`
}

function accessDeniedHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#182230">
<title>Codex Remote</title>
<style>
html, body { height: 100%; }
body { margin: 0; display: grid; place-items: center; padding: 24px; background: #eef2f7; color: #111827; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(100%, 390px); padding: 20px; border: 1px solid #d8dee8; border-radius: 8px; background: #fff; box-shadow: 0 18px 46px rgba(15,23,42,.12); }
h1 { margin: 0 0 8px; font-size: 20px; }
p { margin: 0; color: #667085; }
.pill { display: inline-flex; align-items: center; min-height: 25px; margin-bottom: 14px; padding: 0 9px; border: 1px solid #fedf89; border-radius: 999px; background: #fffaeb; color: #93370d; font-size: 12px; font-weight: 760; }
.hint { margin-top: 10px; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="pill">접속 조건 확인</div>
  <h1>Google Access 로그인이 필요합니다</h1>
  <p>허용된 Google 계정으로 먼저 로그인해야 Codex Remote를 열 수 있습니다.</p>
  <p class="hint">로그인을 마친 뒤에도 이 화면이면 홈 화면 앱을 완전히 종료하고 다시 여세요.</p>
</main>
</body>
</html>`
}

function iconResponse(): Response {
  if (!existsSync(APP_ICON_PATH)) return json({ error: 'icon not found' }, 404)
  return new Response(readFileSync(APP_ICON_PATH), {
    headers: secureHeaders({
      'content-type': 'image/png',
      'cache-control': 'public, max-age=3600',
    }),
  })
}

function manifestResponse(): Response {
  return json({
    name: 'Codex Remote',
    short_name: 'Codex',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#182230',
    icons: [
      {
        src: '/apple-touch-icon.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }, 200, [], {
    'content-type': 'application/manifest+json; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  })
}

function json(value: unknown, status = 200, cookies: string[] = [], headerInit: Record<string, string> = {}): Response {
  const headers = secureHeaders({ 'content-type': 'application/json; charset=utf-8', ...headerInit })
  for (const cookieValue of cookies) headers.append('set-cookie', cookieValue)
  return new Response(JSON.stringify(value), { status, headers })
}

function secureHeaders(init: Record<string, string> = {}): Headers {
  return new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...init,
  })
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function randomId(): string {
  return randomBytes(24).toString('base64url')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function escapeHtmlServer(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char))
}

function audit(event: string, data: Record<string, unknown> = {}, req?: Request): void {
  try {
    mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true })
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ip: req ? clientKey(req) : undefined,
      ...data,
    }) + '\n')
  } catch {}
}

function makeMessage(role: Message['role'], text: string): Message {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text, createdAt: Date.now() }
}

function trimMessages(tab: CodexTab): void {
  if (tab.messages.length > 120) tab.messages.splice(0, tab.messages.length - 120)
}

function touch(tab?: CodexTab): void {
  updatedAt = Date.now()
  if (tab) tab.updatedAt = updatedAt
}

function htmlResponse(): Response {
  const headers = secureHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  })
  return new Response(HTML, { headers })
}

function edgeDeniedHtml(detectedIp: string): string {
  const safeIp = escapeHtmlServer(detectedIp)
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#182230">
<title>Codex Remote</title>
<style>
html, body { height: 100%; }
body { margin: 0; display: grid; place-items: center; padding: 24px; background: #eef2f7; color: #111827; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(100%, 390px); padding: 20px; border: 1px solid #d8dee8; border-radius: 8px; background: #fff; box-shadow: 0 18px 46px rgba(15,23,42,.12); }
h1 { margin: 0 0 8px; font-size: 20px; }
p { margin: 0; color: #667085; }
.network { margin-top: 14px; padding: 11px 12px; border: 1px solid #d8dee8; border-radius: 8px; background: #f8fafc; color: #475467; font-size: 13px; }
.network strong { display: block; margin-bottom: 3px; color: #111827; font-size: 12px; }
code { display: block; overflow-wrap: anywhere; color: #175cd3; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.hint { margin-top: 10px; font-size: 13px; }
.pill { display: inline-flex; align-items: center; min-height: 25px; margin-bottom: 14px; padding: 0 9px; border: 1px solid #fedf89; border-radius: 999px; background: #fffaeb; color: #93370d; font-size: 12px; font-weight: 760; }
</style>
</head>
<body>
<main>
  <div class="pill">VPN 필요</div>
  <h1>접속 조건을 확인하세요</h1>
  <p>Google 로그인은 통과했지만 현재 네트워크가 허용된 VPN 대역이 아닙니다.</p>
  <div class="network">
    <strong>현재 감지된 IP</strong>
    <code>${safeIp}</code>
  </div>
  <p class="hint">이 값이 통신사나 집 인터넷 IP로 보이면 VPN이 전체 트래픽에 적용되지 않은 상태입니다. PIN을 다시 입력해도 해결되지 않습니다. 회사 VPN을 전체 트래픽 모드로 켠 뒤 홈 화면 앱을 완전히 종료하고 다시 여세요.</p>
</main>
</body>
</html>`
}

const HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#182230">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Codex">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/apple-touch-icon.png" type="image/png">
<link rel="manifest" href="/manifest.webmanifest">
<title>Codex Mobile</title>
<style>
:root { color-scheme: light; --bg: #eef2f7; --fg: #111827; --muted: #667085; --subtle: #98a2b3; --line: #d8dee8; --soft: #f3f6fa; --panel: #fff; --panel-2: #f8fafc; --ink: #141923; --blue: #175cd3; --red: #b42318; --green: #067647; --amber: #b54708; --violet: #444ce7; --shadow: 0 18px 46px rgba(15,23,42,.12); --shadow-soft: 0 8px 22px rgba(15,23,42,.07); }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
main { min-height: 100dvh; max-width: 860px; margin: 0 auto; display: grid; grid-template-rows: auto 1fr auto; background: var(--panel-2); }
header { position: sticky; top: 0; z-index: 2; padding: calc(12px + env(safe-area-inset-top)) 14px 10px; background: rgba(250,251,253,.92); border-bottom: 1px solid rgba(216,222,232,.88); backdrop-filter: blur(18px); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { min-width: 0; display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; align-items: center; }
.app-icon { width: 38px; height: 38px; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 18px rgba(20,25,35,.16); }
.brand-copy { min-width: 0; }
h1 { margin: 0; font-size: 18px; line-height: 1.1; font-weight: 800; letter-spacing: 0; }
.subtitle { display: flex; align-items: center; gap: 7px; min-width: 0; margin-top: 6px; color: var(--muted); font-size: 12px; }
.meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #98a2b3; flex: 0 0 auto; }
body.is-active .dot { background: var(--blue); box-shadow: 0 0 0 4px rgba(23,92,211,.12); }
body.has-unread .dot { background: var(--green); box-shadow: 0 0 0 4px rgba(6,118,71,.13); }
body.has-pending .dot { background: var(--amber); box-shadow: 0 0 0 4px rgba(147,55,13,.14); }
.trust-strip { display: flex; gap: 6px; margin-top: 11px; overflow: auto; scrollbar-width: none; }
.trust-strip::-webkit-scrollbar { display: none; }
.codex-status { min-height: 30px; margin-top: 8px; padding: 7px 10px; border: 1px solid rgba(199,215,254,.95); border-radius: 8px; background: #f5f7ff; color: #26314d; font: 12px/1.3 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: nowrap; overflow-x: auto; scrollbar-width: none; box-shadow: 0 1px 2px rgba(15,23,42,.03); }
.codex-status::-webkit-scrollbar { display: none; }
.pill { display: inline-flex; align-items: center; gap: 6px; min-height: 25px; padding: 0 9px; border: 1px solid rgba(216,222,232,.95); border-radius: 999px; background: rgba(255,255,255,.78); color: var(--muted); font-size: 11px; font-weight: 720; white-space: nowrap; box-shadow: 0 1px 2px rgba(15,23,42,.03); }
.pill.good { border-color: #abefc6; background: #ecfdf3; color: #067647; }
.pill.warn { border-color: #fedf89; background: #fffaeb; color: #93370d; }
.tab-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 7px; margin-top: 9px; }
.tab-filter { min-width: 0; min-height: 36px; border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; background: #fff; color: var(--fg); font: inherit; font-size: 13px; outline: 0; }
.tab-filter:focus { border-color: #b2ccff; box-shadow: 0 0 0 3px rgba(23,92,211,.12); }
.tab-tools button { min-height: 36px; padding: 7px 10px; font-size: 12px; }
.session-tabs { display: flex; gap: 7px; margin-top: 9px; overflow-x: auto; scrollbar-width: none; padding-bottom: 1px; }
.session-tabs::-webkit-scrollbar { display: none; }
.session-tab { position: relative; flex: 0 0 auto; display: grid; gap: 4px; align-content: center; min-width: 150px; max-width: 244px; min-height: 54px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,.84); color: var(--muted); font-size: 13px; font-weight: 760; text-align: left; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.session-tab.active { background: var(--ink); border-color: var(--ink); color: #fff; box-shadow: 0 8px 18px rgba(20,25,35,.18); }
.session-tab.busy { border-color: #b2ccff; color: #1849a9; background: #eff6ff; }
.session-tab.pending { border-color: #fedf89; color: #93370d; background: #fffbeb; }
.session-tab.terminal { border-color: #c7d7fe; background: #eef2ff; }
.session-tab.unread:not(.busy):not(.pending) { border-color: #abefc6; color: #05603a; background: #ecfdf3; box-shadow: 0 8px 18px rgba(6,118,71,.11); }
.session-tab.active.terminal { background: var(--ink); border-color: var(--ink); color: #fff; }
.session-tab.active.busy, .session-tab.active.pending, .session-tab.active.unread { background: var(--ink); border-color: var(--ink); color: #fff; }
.session-tab .tab-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; min-width: 0; }
.session-tab .tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: currentColor; }
.session-tab .tab-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; color: rgba(102,112,133,.92); font: 10px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.session-tab.active .tab-status { color: rgba(255,255,255,.74); }
.session-tab .tab-mark { width: 7px; height: 7px; border-radius: 50%; background: var(--subtle); flex: 0 0 auto; }
.session-tab .tab-close { display: grid; place-items: center; flex: 0 0 auto; width: 18px; height: 18px; margin-left: 1px; border-radius: 999px; color: currentColor; font-size: 15px; line-height: 1; opacity: .58; }
.session-tab .tab-close:hover { background: rgba(15,23,42,.08); opacity: .9; }
.session-tab.active .tab-close { background: rgba(255,255,255,.14); opacity: .9; }
.session-tab.busy .tab-mark { background: var(--blue); }
.session-tab.pending .tab-mark { background: var(--amber); }
.session-tab.terminal .tab-mark { background: var(--violet); }
.session-tab.unread:not(.busy):not(.pending) .tab-mark { background: var(--green); box-shadow: 0 0 0 4px rgba(6,118,71,.13); }
.session-tab.active .tab-mark { background: #fff; }
.session-tab.add { min-width: 44px; max-width: 44px; min-height: 54px; place-items: center; text-align: center; font-size: 18px; line-height: 1; }
.session-tab.import { max-width: none; color: #3538cd; }
.terminal-shelf { display: none; gap: 8px; margin-top: 9px; max-height: min(44dvh, 420px); overflow: auto; padding: 9px; border: 1px solid #c7d7fe; border-radius: 8px; background: rgba(255,255,255,.92); box-shadow: var(--shadow-soft); scrollbar-width: none; }
body.show-terminal-shelf .terminal-shelf { display: grid; }
.terminal-shelf::-webkit-scrollbar { display: none; }
.terminal-chip { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 52px; padding: 10px 11px; text-align: left; border-color: #c7d7fe; background: #f5f7ff; }
.terminal-chip strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: #1f2a44; }
.terminal-chip span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; font-weight: 580; }
.terminal-chip .terminal-time { color: var(--violet); font-size: 11px; font-weight: 800; white-space: nowrap; }
.terminal-chip.close { min-height: 36px; justify-content: center; color: var(--muted); background: #fff; border-color: var(--line); }
.terminal-time { color: var(--muted); font-size: 12px; font-weight: 760; white-space: nowrap; }
.actions { display: flex; gap: 7px; align-items: center; flex: 0 0 auto; }
button { appearance: none; border: 1px solid var(--line); background: #fff; color: var(--fg); border-radius: 8px; padding: 10px 13px; font: inherit; font-weight: 740; min-height: 42px; touch-action: manipulation; transition: transform .08s ease, background .15s ease, border-color .15s ease, box-shadow .15s ease; }
button.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
button.ghost { background: rgba(255,255,255,.86); box-shadow: 0 1px 2px rgba(15,23,42,.04); }
button.danger { background: var(--red); border-color: var(--red); color: #fff; }
button.accept { background: var(--green); border-color: var(--green); color: #fff; }
button:hover { border-color: #aab3c0; }
button:active { transform: translateY(1px); }
button:disabled { opacity: .45; transform: none; }
#feed { padding: 16px 12px 24px; overflow: auto; scroll-behavior: smooth; }
.empty { min-height: 42dvh; display: grid; place-items: center; color: var(--muted); text-align: center; padding: 24px; }
.empty strong { display: block; color: var(--fg); font-size: 18px; margin-bottom: 6px; }
.msg { width: fit-content; max-width: min(100%, 680px); margin: 0 0 12px; padding: 12px 13px; background: var(--panel); border: 1px solid rgba(216,222,232,.95); border-radius: 8px; box-shadow: 0 2px 8px rgba(15,23,42,.05); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.user { margin-left: auto; max-width: min(88%, 620px); background: #141923; border-color: #141923; color: #fff; box-shadow: 0 8px 18px rgba(20,25,35,.12); }
.msg.assistant { margin-right: auto; background: #fff; }
.msg.system { width: 100%; color: var(--muted); background: transparent; border: 0; box-shadow: none; padding: 4px 2px; text-align: center; font-size: 12px; }
.msg.trace { width: 100%; max-width: 100%; margin-inline: 0; border-color: #c7d7fe; background: #f5f7ff; color: #26314d; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
.msg.approval { width: 100%; border-color: #fedf89; background: #fffbeb; color: #7a2e0e; }
.msg.error { width: 100%; border-color: #fecdca; background: #fff1f3; color: var(--red); }
.role { display: block; color: var(--muted); font-size: 10px; font-weight: 820; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .02em; }
.msg.user .role { color: rgba(255,255,255,.7); }
.pending { position: sticky; bottom: 0; margin: 0 0 12px; padding: 14px; background: #fffdf5; border: 1px solid #fedf89; border-radius: 8px; box-shadow: var(--shadow); }
.pending-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
.pending h2 { margin: 0; font-size: 16px; }
.pending .summary { color: #3f2a0b; white-space: pre-wrap; overflow-wrap: anywhere; }
.pending .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.approval-pin { margin-top: 12px; }
.composer { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: rgba(248,250,252,.95); border-top: 1px solid rgba(216,222,232,.92); backdrop-filter: blur(18px); }
.composer-shell { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; padding: 8px; background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 26px rgba(15,23,42,.08); }
textarea { width: 100%; min-height: 52px; max-height: 32dvh; resize: none; border: 0; outline: 0; padding: 8px 7px; font: inherit; background: transparent; color: var(--fg); }
.composer-side { display: grid; gap: 7px; align-items: end; min-width: 76px; }
.status { font-size: 12px; color: var(--muted); text-align: center; white-space: nowrap; }
.live { border-color: #b2ccff; background: #eff8ff; }
.live:after { content: ""; display: inline-block; width: 6px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--blue); animation: blink 1s steps(1) infinite; }
.auth { position: fixed; inset: 0; z-index: 10; display: none; place-items: center; padding: 24px; background: rgba(242,244,247,.94); backdrop-filter: blur(14px); }
body.needs-auth .auth { display: grid; }
.auth-panel { width: min(100%, 390px); padding: 20px; background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
.auth-panel h2 { margin: 0 0 8px; font-size: 21px; }
.auth-panel p { margin: 0 0 16px; color: var(--muted); }
.auth-kicker { margin-bottom: 12px; }
.pin-input { width: 100%; min-height: 48px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font: inherit; font-size: 18px; text-align: center; letter-spacing: 4px; }
.auth-panel button { width: 100%; margin-top: 10px; }
.auth-error { min-height: 18px; margin-top: 10px; color: var(--red); font-size: 13px; text-align: center; }
@keyframes blink { 50% { opacity: 0; } }
@media (min-width: 760px) {
  main { min-height: calc(100dvh - 24px); margin-block: 12px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
  header { padding-top: 14px; }
}
@media (max-width: 430px) {
  header { padding-inline: 12px; }
  .brand { grid-template-columns: 34px minmax(0, 1fr); gap: 9px; }
  .app-icon { width: 34px; height: 34px; }
  h1 { font-size: 17px; }
  .actions { gap: 6px; }
  button { padding-inline: 11px; }
  .actions button { min-height: 38px; padding-inline: 10px; font-size: 13px; }
  .trust-strip { margin-top: 9px; }
  .codex-status { font-size: 11px; }
}
</style>
</head>
<body>
<main>
  <header>
    <div class="topbar">
      <div class="brand">
        <img class="app-icon" src="/apple-touch-icon.png" alt="">
        <div class="brand-copy">
          <h1>Codex Remote</h1>
          <div class="subtitle">
            <span class="dot"></span>
            <span class="meta" id="meta">연결 중</span>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="ghost" id="terminalListBtn" title="터미널 세션 목록">세션 목록</button>
        <button class="ghost" id="newBtn" title="새 탭">새 탭</button>
      </div>
    </div>
    <div class="trust-strip">
      <span class="pill good">Access 확인</span>
      <span class="pill good">${NETWORK_GATE_LABEL}</span>
      <span class="pill" id="statePill">대기</span>
    </div>
    <div class="codex-status" id="codexStatus">gpt-5.5 xhigh · Context 확인 중 · 5h 확인 중 · weekly 확인 중</div>
    <div class="tab-tools">
      <input class="tab-filter" id="tabFilter" autocomplete="off" placeholder="탭 검색">
      <button class="ghost" id="renameTabBtn" type="button">이름</button>
      <button class="ghost" id="pinTabBtn" type="button">고정</button>
    </div>
    <nav class="session-tabs" id="tabs" aria-label="Codex 작업 탭"></nav>
    <div class="terminal-shelf" id="terminalShelf" aria-label="최근 터미널 세션"></div>
  </header>
  <section id="feed" aria-live="polite"></section>
  <form class="composer" id="form">
    <div class="composer-shell">
      <textarea id="prompt" placeholder="지시 입력"></textarea>
      <div class="composer-side">
        <span class="status" id="status">대기</span>
        <button class="primary" id="sendBtn" type="submit">보내기</button>
      </div>
    </div>
  </form>
  <section class="auth" id="auth">
    <form class="auth-panel" id="loginForm">
      <div class="auth-kicker"><span class="pill good">Access 통과</span></div>
      <h2>Codex PIN</h2>
      <p>이 기기에서 세션을 열기 위한 마지막 확인입니다.</p>
      <input class="pin-input" id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="PIN">
      <button class="primary" type="submit">열기</button>
      <div class="auth-error" id="authError"></div>
    </form>
  </section>
</main>
<script>
const feed = document.getElementById('feed');
const form = document.getElementById('form');
const loginForm = document.getElementById('loginForm');
const promptEl = document.getElementById('prompt');
const pinEl = document.getElementById('pin');
const authErrorEl = document.getElementById('authError');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const newBtn = document.getElementById('newBtn');
const terminalListBtn = document.getElementById('terminalListBtn');
const statePill = document.getElementById('statePill');
const codexStatusEl = document.getElementById('codexStatus');
const tabFilterEl = document.getElementById('tabFilter');
const renameTabBtn = document.getElementById('renameTabBtn');
const pinTabBtn = document.getElementById('pinTabBtn');
const tabsEl = document.getElementById('tabs');
const terminalShelf = document.getElementById('terminalShelf');
let last = '';
let currentState = null;
let csrf = '';
let refreshInFlight = false;
let connectionFailures = 0;

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(path, {
    ...options,
    headers,
  });
  if (res.status === 401) {
    let payload = {};
    try { payload = await res.json(); } catch {}
    showAuth(authMessage(payload));
    const error = new Error(authMessage(payload) ? '토큰 링크 필요' : 'PIN 필요');
    error.payload = payload;
    throw error;
  }
  if (!res.ok) {
    let payload = {};
    let text = '';
    try { payload = await res.json(); }
    catch {
      try { text = await res.text(); } catch {}
    }
    const message = payload?.message || payload?.error || text || '요청 실패';
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return res.json();
}

function displayError(err) {
  const payload = err?.payload || {};
  if (payload.clientIp) return (payload.message || payload.error || '요청 실패') + ' 현재 IP: ' + payload.clientIp;
  return String(err?.message || err || '요청 실패');
}

function roleLabel(role) {
  return ({ user: '나', assistant: 'Codex', system: '상태', approval: '승인 요청', error: '오류', trace: '진행' })[role] || role;
}

function render(state) {
  const data = JSON.stringify(state);
  if (data === last) return;
  last = data;
  currentState = state;
  renderTabs(state);
  const stateText = state.pending ? '확인 필요' : state.active ? '작업 중' : '대기';
  statusEl.textContent = stateText;
  statePill.textContent = stateText;
  statePill.className = 'pill ' + (state.pending ? 'warn' : state.active ? 'good' : '');
  codexStatusEl.textContent = state.codexStatus || (state.model + ' ' + (state.reasoningEffort || '') + ' · Context 확인 중 · 5h 확인 중 · weekly 확인 중');
  codexStatusEl.title = codexStatusEl.textContent;
  document.body.classList.toggle('is-active', Boolean(state.active));
  document.body.classList.toggle('has-unread', Boolean(state.anyUnread));
  document.body.classList.toggle('has-pending', Boolean(state.anyPending || state.pending));
  document.title = state.anyUnread ? '새 답변 · Codex Mobile' : 'Codex Mobile';
  promptEl.placeholder = state.pending?.type === 'input' ? '답변 입력' : '지시 입력';
  const activeTab = (state.tabs || []).find(tab => tab.id === state.activeTabId);
  if (activeTab) {
    codexStatusEl.textContent = activeTab.codexStatus || codexStatusEl.textContent;
    codexStatusEl.title = activeTab.codexStatus || codexStatusEl.textContent;
    pinTabBtn.textContent = activeTab.pinned ? '고정 해제' : '고정';
  }
  metaEl.textContent = (activeTab ? activeTab.title + ' · ' : '') + state.model + ' · ' + state.cwd;
  const parts = [];
  if (!state.messages.length && !state.activeOutput && !state.pending) {
    parts.push('<div class="empty"><div><strong>대기 중</strong><span>Codex가 새 지시를 기다리고 있습니다.</span></div></div>');
  }
  for (const msg of state.messages) {
    parts.push('<article class="msg ' + msg.role + '"><span class="role">' + escapeHtml(roleLabel(msg.role)) + '</span>' + escapeHtml(msg.text) + '</article>');
  }
  if (state.activeTraceOutput) {
    parts.push('<article class="msg trace live"><span class="role">진행</span>' + escapeHtml(state.activeTraceOutput) + '</article>');
  }
  if (state.activeOutput) {
    parts.push('<article class="msg assistant live"><span class="role">Codex</span>' + escapeHtml(state.activeOutput) + '</article>');
  }
  if (state.pending?.type === 'approval') {
    parts.push('<section class="pending"><div class="pending-head"><h2>승인 필요</h2><span class="pill warn">PIN 필요</span></div><div class="summary">' + escapeHtml(state.pending.summary) + '</div><input class="pin-input approval-pin" id="approvalPin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="승인 PIN"><div class="row"><button class="accept" data-approve="accept" type="button">YES</button><button class="danger" data-approve="decline" type="button">NO</button></div></section>');
  }
  if (state.pending?.type === 'input') {
    const qs = state.pending.questions.map((q, i) => (i + 1) + '. ' + q.question).join('\\n');
    parts.push('<section class="pending"><div class="pending-head"><h2>답변 필요</h2><span class="pill warn">응답 대기</span></div><div class="summary">' + escapeHtml(qs) + '</div></section>');
  }
  feed.innerHTML = parts.join('');
  scrollConversationToBottom();
}

function scrollConversationToBottom() {
  const scroll = () => {
    feed.scrollTop = feed.scrollHeight;
    feed.lastElementChild?.scrollIntoView({ block: 'end', inline: 'nearest' });
  };
  scroll();
  requestAnimationFrame(scroll);
  setTimeout(scroll, 80);
  setTimeout(scroll, 260);
}

function renderTabs(state) {
  const filter = normalizedTabFilter();
  const sourceTabs = state.tabs || [];
  const visibleTabs = sourceTabs.filter(tab => {
    if (!filter) return true;
    if (tab.id === state.activeTabId) return true;
    return [tab.title, tab.codexStatus, tab.shortCodexStatus, tab.source].some(value => String(value || '').toLowerCase().includes(filter));
  });
  const tabButtons = visibleTabs.map(tab => {
    const classes = ['session-tab'];
    if (tab.id === state.activeTabId) classes.push('active');
    if (tab.active) classes.push('busy');
    if (tab.pending) classes.push('pending');
    if (tab.unread) classes.push('unread');
    if (tab.source === 'terminal') classes.push('terminal');
    const label = tab.pending ? '확인 필요' : tab.active ? '작업 중' : tab.unread ? '새 답변' : '대기';
    const status = (tab.pinned ? '고정 · ' : '') + (tab.unread ? '새 답변' : (tab.shortCodexStatus || tab.codexStatus || label));
    const close = tab.closable ? '<span class="tab-close" data-tab-delete="' + escapeHtml(tab.id) + '" title="탭 닫기" aria-hidden="true">×</span>' : '';
    return '<button class="' + classes.join(' ') + '" type="button" role="tab" aria-selected="' + String(tab.id === state.activeTabId) + '" title="' + escapeHtml(tab.title + ' · ' + (tab.unread ? label : (tab.codexStatus || label))) + '" data-tab-id="' + escapeHtml(tab.id) + '"><span class="tab-head"><span class="tab-mark"></span><span class="tab-title">' + escapeHtml(tab.title) + '</span>' + close + '</span><span class="tab-status">' + escapeHtml(status) + '</span></button>';
  });
  tabButtons.push('<button class="session-tab add" type="button" title="새 탭" aria-label="새 탭" data-new-tab>+</button>');
  tabsEl.innerHTML = tabButtons.join('');
}

function normalizedTabFilter() {
  return String(tabFilterEl.value || '').trim().toLowerCase();
}

function showAuth(message = '') {
  document.body.classList.add('needs-auth');
  authErrorEl.textContent = message;
  setTimeout(() => pinEl.focus(), 50);
}

function hideAuth() {
  document.body.classList.remove('needs-auth');
  authErrorEl.textContent = '';
}

function authMessage(payload) {
  return payload?.bootRequired && !payload?.bootstrapped ? '토큰 링크를 먼저 열었는지 확인하세요.' : '';
}

async function loadSession() {
  try {
    const session = await api('/api/session');
    csrf = session.csrf || '';
    hideAuth();
    if (session.state) render(session.state);
  } catch (err) {
    showAuth(authMessage(err.payload) || displayError(err));
  }
}

async function refresh() {
  if (refreshInFlight) return;
  if (navigator.onLine === false) {
    statusEl.textContent = '오프라인';
    metaEl.textContent = '네트워크 연결을 기다리는 중';
    return;
  }
  refreshInFlight = true;
  try {
    render(await api('/api/state'));
    connectionFailures = 0;
  } catch (err) {
    connectionFailures += 1;
    statusEl.textContent = connectionFailures >= 3 ? '재연결 중' : '오류';
    metaEl.textContent = displayError(err);
  } finally {
    refreshInFlight = false;
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const pin = pinEl.value.trim();
  if (!pin) return;
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ pin }) });
    csrf = result.csrf || '';
    pinEl.value = '';
    hideAuth();
    if (result.state) render(result.state);
    await refresh();
  } catch (err) {
    showAuth(authMessage(err.payload) || displayError(err) || 'PIN이 맞지 않습니다.');
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  const path = currentState?.pending?.type === 'input' ? '/api/input' : '/api/prompt';
  try {
    statusEl.textContent = '전송 중';
    await api(path, { method: 'POST', body: JSON.stringify({ text, tabId: currentState?.activeTabId }) });
    await refresh();
  } catch (err) {
    promptEl.value = text;
    statusEl.textContent = '오류';
    metaEl.textContent = displayError(err);
  }
});

function resizePrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, window.innerHeight * 0.32) + 'px';
}

let promptSelection = { start: 0, end: 0 };

function rememberPromptSelection() {
  promptSelection = {
    start: promptEl.selectionStart ?? promptEl.value.length,
    end: promptEl.selectionEnd ?? promptEl.selectionStart ?? promptEl.value.length,
  };
}

function insertPromptText(value) {
  const start = promptEl.selectionStart ?? promptEl.value.length;
  const end = promptEl.selectionEnd ?? start;
  promptEl.value = promptEl.value.slice(0, start) + value + promptEl.value.slice(end);
  const nextPosition = start + value.length;
  promptEl.selectionStart = nextPosition;
  promptEl.selectionEnd = nextPosition;
  rememberPromptSelection();
  promptEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function dropPromptText(value) {
  const selectionStart = promptSelection.start;
  const selectionEnd = promptSelection.end;
  const hasSelection = selectionEnd > selectionStart;
  const insertAt = hasSelection ? selectionEnd : (promptEl.selectionStart ?? promptEl.value.length);
  promptEl.value = promptEl.value.slice(0, insertAt) + value + promptEl.value.slice(insertAt);
  if (hasSelection) {
    promptEl.selectionStart = selectionStart;
    promptEl.selectionEnd = selectionEnd;
  } else {
    const nextPosition = insertAt + value.length;
    promptEl.selectionStart = nextPosition;
    promptEl.selectionEnd = nextPosition;
  }
  rememberPromptSelection();
  promptEl.dispatchEvent(new Event('input', { bubbles: true }));
}

promptEl.addEventListener('keydown', event => {
  if (event.isComposing || event.key !== 'Enter') return;
  if (event.shiftKey) {
    event.preventDefault();
    insertPromptText('\\n');
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

promptEl.addEventListener('input', () => {
  rememberPromptSelection();
  resizePrompt();
});

['focus', 'select', 'keyup', 'mouseup', 'touchend'].forEach(eventName => {
  promptEl.addEventListener(eventName, rememberPromptSelection);
});

promptEl.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types?.includes('text/plain')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

promptEl.addEventListener('drop', event => {
  const text = event.dataTransfer?.getData('text/plain') || '';
  if (!text) return;
  event.preventDefault();
  dropPromptText(text);
  promptEl.focus();
});

newBtn.addEventListener('click', async () => {
  await createNewTab();
});

terminalListBtn.addEventListener('click', async () => {
  await openTerminalPicker();
});

tabFilterEl.addEventListener('input', () => {
  if (currentState) renderTabs(currentState);
});

renameTabBtn.addEventListener('click', async () => {
  await renameActiveTab();
});

pinTabBtn.addEventListener('click', async () => {
  await toggleActiveTabPin();
});

tabsEl.addEventListener('click', async event => {
  const deleteButton = event.target.closest('[data-tab-delete]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    await deleteTab(deleteButton.getAttribute('data-tab-delete'));
    return;
  }
  const addButton = event.target.closest('[data-new-tab]');
  if (addButton) {
    await createNewTab();
    return;
  }
  const tabButton = event.target.closest('[data-tab-id]');
  if (!tabButton) return;
  await api('/api/tab/select', { method: 'POST', body: JSON.stringify({ tabId: tabButton.getAttribute('data-tab-id') }) });
  await refresh();
});

async function createNewTab() {
  await api('/api/new', { method: 'POST', body: '{}' });
  await refresh();
  promptEl.focus();
}

async function deleteTab(tabId) {
  if (!tabId) return;
  try {
    const result = await api('/api/tab/delete', { method: 'POST', body: JSON.stringify({ tabId }) });
    if (result.state) render(result.state);
    else await refresh();
    if (result.message) statusEl.textContent = result.message;
  } catch (err) {
    statusEl.textContent = '삭제 불가';
    metaEl.textContent = String(err.message || err);
  }
}

async function renameActiveTab() {
  const activeTab = (currentState?.tabs || []).find(tab => tab.id === currentState.activeTabId);
  if (!activeTab) return;
  const title = window.prompt('탭 이름', activeTab.title);
  if (title === null) return;
  try {
    const result = await api('/api/tab/rename', { method: 'POST', body: JSON.stringify({ tabId: activeTab.id, title }) });
    if (result.state) render(result.state);
    else await refresh();
  } catch (err) {
    statusEl.textContent = '이름 변경 실패';
    metaEl.textContent = displayError(err);
  }
}

async function toggleActiveTabPin() {
  const activeTab = (currentState?.tabs || []).find(tab => tab.id === currentState.activeTabId);
  if (!activeTab) return;
  try {
    const result = await api('/api/tab/pin', { method: 'POST', body: JSON.stringify({ tabId: activeTab.id, pinned: !activeTab.pinned }) });
    if (result.state) render(result.state);
    else await refresh();
  } catch (err) {
    statusEl.textContent = '고정 변경 실패';
    metaEl.textContent = displayError(err);
  }
}

async function importTerminalSession(sessionId) {
  await api('/api/terminal/import', { method: 'POST', body: JSON.stringify({ sessionId }) });
  closeTerminalPicker();
  await refresh();
  promptEl.focus();
}

async function openTerminalPicker() {
  try {
    const result = await api('/api/terminal/sessions');
    renderTerminalShelf(result.sessions || []);
  } catch (err) {
    terminalShelf.innerHTML = '<button class="terminal-chip close" type="button" data-terminal-close>닫기</button><button class="terminal-chip" type="button" disabled><span><strong>세션 목록 오류</strong><span>' + escapeHtml(String(err.message || err)) + '</span></span></button>';
  }
  document.body.classList.add('show-terminal-shelf');
}

function closeTerminalPicker() {
  document.body.classList.remove('show-terminal-shelf');
  terminalShelf.innerHTML = '';
}

function renderTerminalShelf(sessions) {
  if (!sessions.length) {
    terminalShelf.innerHTML = '<button class="terminal-chip close" type="button" data-terminal-close>닫기</button><button class="terminal-chip" type="button" disabled><span><strong>세션 없음</strong><span>가져올 Codex 세션을 찾지 못했습니다.</span></span></button>';
    return;
  }
  terminalShelf.innerHTML = [
    ...sessions.map(session => (
      '<button class="terminal-chip" type="button" data-terminal-session-id="' + escapeHtml(session.id) + '">' +
        '<span><strong>' + escapeHtml(session.title) + '</strong><span>' + escapeHtml(session.cwd) + '</span></span>' +
        '<span class="terminal-time">' + escapeHtml(session.updatedLabel) + '</span>' +
      '</button>'
    )),
    '<button class="terminal-chip close" type="button" data-terminal-close>닫기</button>',
  ].join('');
}

terminalShelf.addEventListener('click', async event => {
  const closeButton = event.target.closest('[data-terminal-close]');
  if (closeButton) {
    closeTerminalPicker();
    return;
  }
  const button = event.target.closest('[data-terminal-session-id]');
  if (!button) return;
  await importTerminalSession(button.getAttribute('data-terminal-session-id'));
});

feed.addEventListener('click', async event => {
  const button = event.target.closest('[data-approve]');
  if (!button) return;
  await approve(button.getAttribute('data-approve'));
});

async function approve(decision) {
  const pin = document.getElementById('approvalPin')?.value.trim();
  if (!pin) return;
  await api('/api/approval', { method: 'POST', body: JSON.stringify({ decision, pin, tabId: currentState?.activeTabId }) });
  await refresh();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

loadSession();
setInterval(refresh, 1500);
window.addEventListener('online', () => {
  connectionFailures = 0;
  statusEl.textContent = '재연결 중';
  void refresh();
});
window.addEventListener('offline', () => {
  statusEl.textContent = '오프라인';
  metaEl.textContent = '네트워크 연결을 기다리는 중';
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
</script>
</body>
</html>`

import { spawn, type ChildProcessByStdio } from 'child_process'
import { createInterface } from 'readline'
import type { Readable, Writable } from 'stream'

type RpcId = number | string

export type JsonRpcMessage = {
  id?: RpcId
  method?: string
  params?: any
  result?: any
  error?: { code?: number; message?: string; data?: unknown }
}

type PendingRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type CodexAppClientOptions = {
  command?: string
  args?: string[]
  requestTimeoutMs?: number
  onNotification?: (message: JsonRpcMessage) => void | Promise<void>
  onServerRequest?: (message: JsonRpcMessage, client: CodexAppClient) => void | Promise<void>
}

export class CodexAppClient {
  private proc: ChildProcessByStdio<Writable, Readable, null> | null = null
  private nextId = 1
  private initialized = false
  private starting: Promise<void> | null = null
  private readonly pending = new Map<RpcId, PendingRequest>()

  constructor(private readonly options: CodexAppClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.initialized) return
    if (this.starting) return this.starting
    this.starting = this.startInner()
    return this.starting
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.start()
    const id = this.nextId++
    const timeoutMs = this.options.requestTimeoutMs ?? 120000
    const message = { id, method, params }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.write(message)
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params })
  }

  respond(id: RpcId, result: Record<string, unknown>): void {
    this.write({ id, result })
  }

  respondError(id: RpcId, message: string, code = -32000): void {
    this.write({ id, error: { code, message } })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.initialized = false
    this.starting = null
  }

  private async startInner(): Promise<void> {
    const command = this.options.command ?? process.env.CODEX_APP_SERVER_COMMAND ?? 'codex'
    const args = this.options.args ?? parseArgs(process.env.CODEX_APP_SERVER_ARGS) ?? ['app-server']
    let proc: ChildProcessByStdio<Writable, Readable, null>
    try {
      proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    } catch (error) {
      this.initialized = false
      this.starting = null
      throw new Error(`Codex app-server 시작 실패: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.proc = proc

    proc.on('error', error => {
      this.initialized = false
      this.starting = null
      const wrapped = new Error(`Codex app-server 시작 실패: ${error.message}`)
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(wrapped)
        this.pending.delete(id)
      }
    })

    proc.on('exit', (code, signal) => {
      this.initialized = false
      this.starting = null
      const error = new Error(`Codex app-server exited: code=${code} signal=${signal}`)
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(error)
        this.pending.delete(id)
      }
    })

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', line => this.handleLine(line))

    await this.rawRequest('initialize', {
      clientInfo: { name: 'codex_sms_bridge', title: 'Codex SMS Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized')
    this.initialized = true
  }

  private rawRequest(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.options.requestTimeoutMs ?? 120000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write(`[codex-sms] non-json app-server line: ${line}\n`)
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server error'))
      else pending.resolve(message.result)
      return
    }

    if (message.id !== undefined && message.method) {
      void this.options.onServerRequest?.(message, this)
      return
    }

    if (message.method) {
      void this.options.onNotification?.(message)
    }
  }

  private write(message: JsonRpcMessage): void {
    if (!this.proc?.stdin.writable) throw new Error('Codex app-server is not running')
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

function parseArgs(value: string | undefined): string[] | null {
  if (!value?.trim()) return null
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) return parsed
  } catch {}
  return value.trim().split(/\s+/)
}

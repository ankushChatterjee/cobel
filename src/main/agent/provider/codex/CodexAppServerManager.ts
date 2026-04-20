import { EventEmitter } from 'node:events'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  ProviderApprovalDecision,
  ProviderSession,
  RuntimeMode
} from '../../../../shared/agent'
import type { ModelInfo, ModelListResponse, TurnStartResponse } from './codex-api-types'
import { createEventId, nowIso } from '../types'

const execFileAsync = promisify(execFile)
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

type JsonRpcId = string | number

interface JsonRpcRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  id: JsonRpcId
  result?: unknown
  error?: { message?: string }
}

interface PendingRequest {
  method: string
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface PendingApprovalRequest {
  requestId: string
  jsonRpcId: JsonRpcId
  method: string
  threadId: string
  turnId?: string
  itemId?: string
}

interface PendingUserInputRequest {
  requestId: string
  jsonRpcId: JsonRpcId
  threadId: string
  turnId?: string
  itemId?: string
}

interface CodexSessionContext {
  session: ProviderSession
  child: ChildProcessWithoutNullStreams
  output: ReadlineInterface
  pending: Map<string, PendingRequest>
  pendingApprovals: Map<string, PendingApprovalRequest>
  pendingUserInputs: Map<string, PendingUserInputRequest>
  nextRequestId: number
  stopping: boolean
}

export interface ProviderEvent {
  id: string
  kind: 'session' | 'notification' | 'request' | 'error'
  provider: 'codex'
  threadId: string
  createdAt: string
  method: string
  message?: string
  turnId?: string
  itemId?: string
  requestId?: string
  textDelta?: string
  payload?: unknown
}

export class CodexAppServerManager {
  private readonly contexts = new Map<string, CodexSessionContext>()
  private readonly emitter = new EventEmitter()
  private cachedModels: ModelInfo[] | null = null
  private modelFetchPromise: Promise<ModelInfo[]> | null = null

  constructor(
    private readonly options: {
      codexBinaryPath?: string
      codexHomePath?: string
      minimumVersion?: string
      requestTimeoutMs?: number
      spawnProcess?: typeof spawn
    } = {}
  ) {}

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) return this.cachedModels
    // Deduplicate concurrent calls
    if (this.modelFetchPromise) return this.modelFetchPromise
    this.modelFetchPromise = this.fetchModelsViaTempProcess().finally(() => {
      this.modelFetchPromise = null
    })
    return this.modelFetchPromise
  }

  async getSummary(): Promise<{ status: 'available' | 'missing' | 'error'; detail?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(this.codexBinaryPath(), ['--version'], {
        timeout: 5_000
      })
      return { status: 'available', detail: (stdout || stderr).trim() }
    } catch (error) {
      return { status: 'missing', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async startSession(input: {
    threadId: string
    cwd?: string
    model?: string
    runtimeMode: RuntimeMode
    resumeCursor?: unknown
  }): Promise<ProviderSession> {
    const existing = this.contexts.get(input.threadId)
    if (existing && existing.session.status !== 'closed') return existing.session

    await this.assertVersion()
    const createdAt = nowIso()
    const child = (this.options.spawnProcess ?? spawn)(this.codexBinaryPath(), ['app-server'], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...(this.options.codexHomePath ? { CODEX_HOME: this.options.codexHomePath } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })

    const session: ProviderSession = {
      provider: 'codex',
      status: 'connecting',
      runtimeMode: input.runtimeMode,
      cwd: input.cwd,
      model: input.model,
      threadId: input.threadId,
      resumeCursor: input.resumeCursor,
      createdAt,
      updatedAt: createdAt
    }

    const context: CodexSessionContext = {
      session,
      child,
      output: createInterface({ input: child.stdout }),
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      nextRequestId: 1,
      stopping: false
    }

    this.contexts.set(input.threadId, context)
    this.emitSession(input.threadId, 'session/connecting')
    this.attachProcessListeners(context)

    try {
      await this.sendRequest(context, 'initialize', buildCodexInitializeParams())
      this.writeMessage(context, { method: 'initialized' })
      await this.tryRequestAndCacheModels(context)
      await this.tryRequest(context, 'account/read', {})
      const mode = mapCodexRuntimeMode(input.runtimeMode)
      const resumeThreadId = readResumeThreadId(input.resumeCursor)
      const threadResult = resumeThreadId
        ? await this.resumeOrStartThread(context, resumeThreadId, mode, input)
        : await this.sendRequest<Record<string, unknown>>(context, 'thread/start', {
            cwd: input.cwd,
            ...optionalModel(input.model),
            ...mode
          })
      const providerThreadId = readProviderThreadId(threadResult) ?? resumeThreadId
      if (!providerThreadId) throw new Error('Codex did not return a provider thread id.')
      context.session = {
        ...context.session,
        status: 'ready',
        resumeCursor: { threadId: providerThreadId },
        updatedAt: nowIso()
      }
      this.emitSession(input.threadId, 'session/ready', { providerThreadId })
      return context.session
    } catch (error) {
      context.session = {
        ...context.session,
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso()
      }
      this.emitError(input.threadId, context.session.lastError ?? 'Failed to start Codex')
      await this.stopSession({ threadId: input.threadId })
      throw error
    }
  }

  async sendTurn(input: {
    threadId: string
    input: string
    attachments?: Array<{ type: 'image'; url: string }>
    model?: string
  }): Promise<{
    turnId: string
    resumeCursor?: unknown
  }> {
    const context = this.requireContext(input.threadId)
    const providerThreadId = readResumeThreadId(context.session.resumeCursor) ?? input.threadId
    const turnInput = [
      { type: 'text', text: input.input, text_elements: [] },
      ...(input.attachments ?? []).map((attachment) => ({ type: 'image', url: attachment.url }))
    ]
    const result = await this.sendRequest<TurnStartResponse>(context, 'turn/start', {
      threadId: providerThreadId,
      input: turnInput,
      ...optionalModel(input.model ?? context.session.model)
    })
    // Codex returns { turn: { id: "turn_xxx", status: "inProgress", ... } }
    const turnId =
      result?.turn?.id ??
      readString(result as unknown as Record<string, unknown>, 'turnId') ??
      createEventId('turn')
    context.session = {
      ...context.session,
      status: 'running',
      activeTurnId: turnId,
      model: input.model?.trim() || context.session.model,
      updatedAt: nowIso()
    }
    return { turnId, resumeCursor: context.session.resumeCursor }
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    const context = this.requireContext(input.threadId)
    await this.sendRequest(context, 'turn/interrupt', {
      threadId: readResumeThreadId(context.session.resumeCursor),
      turnId: input.turnId ?? context.session.activeTurnId
    })
  }

  async respondToApproval(input: {
    threadId: string
    requestId: string
    decision: ProviderApprovalDecision
  }): Promise<void> {
    const context = this.requireContext(input.threadId)
    const pending = context.pendingApprovals.get(input.requestId)
    if (!pending) throw new Error(`No pending approval request: ${input.requestId}`)
    this.writeMessage(context, {
      id: pending.jsonRpcId,
      result: { decision: input.decision }
    })
    context.pendingApprovals.delete(input.requestId)
    this.emitRaw({
      kind: 'notification',
      threadId: input.threadId,
      method: 'item/requestApproval/decision',
      requestId: input.requestId,
      turnId: pending.turnId,
      itemId: pending.itemId,
      payload: { decision: input.decision }
    })
  }

  async respondToUserInput(input: {
    threadId: string
    requestId: string
    answers: Record<string, unknown>
  }): Promise<void> {
    const context = this.requireContext(input.threadId)
    const pending = context.pendingUserInputs.get(input.requestId)
    if (!pending) throw new Error(`No pending user-input request: ${input.requestId}`)
    this.writeMessage(context, {
      id: pending.jsonRpcId,
      result: { answers: normalizeCodexAnswers(input.answers) }
    })
    context.pendingUserInputs.delete(input.requestId)
    this.emitRaw({
      kind: 'notification',
      threadId: input.threadId,
      method: 'item/tool/requestUserInput/answered',
      requestId: input.requestId,
      turnId: pending.turnId,
      itemId: pending.itemId,
      payload: { answers: input.answers }
    })
  }

  async readThread(input: { threadId: string }): Promise<unknown> {
    const context = this.requireContext(input.threadId)
    return this.sendRequest(context, 'thread/read', {
      threadId: readResumeThreadId(context.session.resumeCursor),
      includeTurns: true
    })
  }

  async stopSession(input: { threadId: string }): Promise<void> {
    const context = this.contexts.get(input.threadId)
    if (!context) return
    context.stopping = true
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Codex session stopped.'))
    }
    context.pending.clear()
    context.pendingApprovals.clear()
    context.pendingUserInputs.clear()
    context.output.close()
    context.child.kill()
    context.session = { ...context.session, status: 'closed', updatedAt: nowIso() }
    this.contexts.delete(input.threadId)
    this.emitSession(input.threadId, 'session/closed')
  }

  private async tryRequestAndCacheModels(context: CodexSessionContext): Promise<void> {
    try {
      const result = await this.sendRequest<ModelListResponse>(
        context,
        'model/list',
        { includeHidden: false },
        5_000
      )
      const models = parseModelList(result)
      if (models.length > 0) this.cachedModels = models
    } catch (error) {
      this.emitError(context.session.threadId, 'model/list failed', error)
    }
  }

  private async fetchModelsViaTempProcess(): Promise<ModelInfo[]> {
    await this.assertVersion()
    const child = (this.options.spawnProcess ?? spawn)(this.codexBinaryPath(), ['app-server'], {
      env: {
        ...process.env,
        ...(this.options.codexHomePath ? { CODEX_HOME: this.options.codexHomePath } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })

    const sentinel = `__model_probe_${Date.now()}`
    const context: CodexSessionContext = {
      session: {
        provider: 'codex',
        status: 'connecting',
        runtimeMode: 'approval-required',
        threadId: sentinel,
        createdAt: nowIso(),
        updatedAt: nowIso()
      },
      child,
      output: createInterface({ input: child.stdout }),
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      nextRequestId: 1,
      stopping: false
    }

    this.contexts.set(sentinel, context)
    this.attachProcessListeners(context)

    try {
      await this.sendRequest(context, 'initialize', buildCodexInitializeParams())
      this.writeMessage(context, { method: 'initialized' })
      const result = await this.sendRequest<ModelListResponse>(
        context,
        'model/list',
        { includeHidden: false },
        5_000
      )
      const models = parseModelList(result)
      if (models.length > 0) this.cachedModels = models
      return this.cachedModels ?? []
    } catch {
      return this.cachedModels ?? []
    } finally {
      context.stopping = true
      this.contexts.delete(sentinel)
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
  }

  private async resumeOrStartThread(
    context: CodexSessionContext,
    providerThreadId: string,
    mode: ReturnType<typeof mapCodexRuntimeMode>,
    input: { cwd?: string; model?: string }
  ): Promise<Record<string, unknown>> {
    try {
      return await this.sendRequest<Record<string, unknown>>(context, 'thread/resume', {
        threadId: providerThreadId,
        ...mode
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      if (!isRecoverableMissingThread(message)) throw error
      return this.sendRequest<Record<string, unknown>>(context, 'thread/start', {
        cwd: input.cwd,
        ...optionalModel(input.model),
        ...mode
      })
    }
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on('line', (line) => this.handleStdoutLine(context, line))
    context.child.stderr.on('data', (chunk) => {
      for (const message of parseCodexStderr(String(chunk))) {
        if (message.level === 'ignore') continue
        this.emitError(context.session.threadId, message.message, message.detail)
      }
    })
    context.child.on('exit', (code, signal) => {
      if (!context.stopping) {
        context.session = { ...context.session, status: 'closed', updatedAt: nowIso() }
        this.emitSession(context.session.threadId, 'session/exited', { code, signal })
        this.contexts.delete(context.session.threadId)
      }
    })
    context.child.on('error', (error) => this.emitError(context.session.threadId, error.message))
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.emitError(context.session.threadId, 'Invalid JSON from Codex app-server', { line })
      return
    }

    if (isResponse(message)) {
      this.handleResponse(context, message)
      return
    }

    if (isServerRequest(message)) {
      this.handleServerRequest(context, message)
      return
    }

    if (isServerNotification(message)) {
      const params = readRecord(message.params)
      // turn/started and turn/completed carry { threadId, turn: { id, status, ... } }
      // item/started and item/completed carry { item: { id, type, ... }, threadId, turnId }
      // delta notifications carry { threadId, turnId, itemId, delta }
      const turnRecord = readRecord(params['turn'])
      const itemRecord = readRecord(params['item'])
      const turnId = readString(params, 'turnId') ?? readString(turnRecord, 'id')
      const itemId = readString(params, 'itemId') ?? readString(itemRecord, 'id')
      this.emitRaw({
        kind: 'notification',
        threadId: context.session.threadId,
        method: message.method,
        turnId,
        itemId,
        textDelta: readString(params, 'delta') ?? readString(params, 'textDelta'),
        payload: params
      })
      return
    }

    this.emitError(context.session.threadId, 'Unknown JSON-RPC message from Codex', message)
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const pending = context.pending.get(String(response.id))
    if (!pending) return
    clearTimeout(pending.timeout)
    context.pending.delete(String(response.id))
    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message}`))
      return
    }
    pending.resolve(response.result)
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const params = readRecord(request.params)
    const requestId = createEventId('request')
    const pending = {
      requestId,
      jsonRpcId: request.id,
      method: request.method,
      threadId: context.session.threadId,
      turnId: readString(params, 'turnId'),
      itemId: readString(params, 'itemId')
    }

    if (request.method === 'item/tool/requestUserInput') {
      context.pendingUserInputs.set(requestId, pending)
    } else if (request.method.includes('requestApproval')) {
      context.pendingApprovals.set(requestId, pending)
    } else {
      this.writeMessage(context, {
        id: request.id,
        error: { code: -32601, message: `Unsupported request: ${request.method}` }
      })
    }

    this.emitRaw({
      kind: 'request',
      threadId: context.session.threadId,
      method: request.method,
      requestId,
      turnId: pending.turnId,
      itemId: pending.itemId,
      payload: params
    })
  }

  private async sendRequest<T>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const id = context.nextRequestId++
    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id))
        reject(new Error(`Timed out waiting for ${method}.`))
      }, timeoutMs)

      context.pending.set(String(id), { method, timeout, resolve, reject })
      this.writeMessage(context, { method, id, params })
    })
    return result as T
  }

  private async tryRequest(
    context: CodexSessionContext,
    method: string,
    params: unknown
  ): Promise<void> {
    try {
      await this.sendRequest(context, method, params, 5_000)
    } catch (error) {
      this.emitError(context.session.threadId, `${method} failed`, error)
    }
  }

  private writeMessage(context: CodexSessionContext, message: Record<string, unknown>): void {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private requireContext(threadId: string): CodexSessionContext {
    const context = this.contexts.get(threadId)
    if (!context) throw new Error(`No active Codex session for thread: ${threadId}`)
    return context
  }

  private async assertVersion(): Promise<void> {
    const summary = await this.getSummary()
    if (summary.status !== 'available')
      throw new Error(summary.detail ?? 'Codex CLI is not available.')
  }

  private codexBinaryPath(): string {
    return this.options.codexBinaryPath ?? process.env.CODEX_BINARY_PATH ?? 'codex'
  }

  private emitSession(threadId: string, method: string, payload?: unknown): void {
    this.emitRaw({ kind: 'session', threadId, method, payload })
  }

  private emitError(threadId: string, message: string, detail?: unknown): void {
    this.emitRaw({ kind: 'error', threadId, method: 'runtime/error', message, payload: detail })
  }

  private emitRaw(input: Omit<ProviderEvent, 'id' | 'provider' | 'createdAt'>): void {
    const event = {
      id: createEventId('raw'),
      provider: 'codex',
      createdAt: nowIso(),
      ...input
    } satisfies ProviderEvent
    logEvent('codex/raw', event)
    this.emitter.emit('event', event)
  }
}

function logEvent(label: string, payload: unknown): void {
  console.log(`[patronus:${label}]`, payload)
}

export function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
} {
  switch (runtimeMode) {
    case 'approval-required':
      return { approvalPolicy: 'untrusted', sandbox: 'read-only' }
    case 'auto-accept-edits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  }
}

export function buildCodexInitializeParams(): {
  clientInfo: { name: string; title: string; version: string }
  capabilities: { experimentalApi: true }
} {
  return {
    clientInfo: {
      name: 'patronus_desktop',
      title: 'Patronus Desktop',
      version: '0.1.0'
    },
    capabilities: {
      experimentalApi: true
    }
  }
}

export function parseCodexStderr(
  chunk: string
): Array<{ level: 'error' | 'ignore'; message: string; detail?: unknown }> {
  const messages: Array<{ level: 'error' | 'ignore'; message: string; detail?: unknown }> = []
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseJsonRecord(trimmed)
    if (!parsed) {
      messages.push({ level: 'error', message: trimmed })
      continue
    }
    const level = readString(parsed, 'level')?.toUpperCase()
    if (level && level !== 'ERROR') {
      messages.push({ level: 'ignore', message: readCodexLogMessage(parsed) ?? trimmed })
      continue
    }
    messages.push({
      level: 'error',
      message: readCodexLogMessage(parsed) ?? trimmed,
      detail: parsed
    })
  }
  return messages
}

function isServerRequest(value: unknown): value is JsonRpcRequest {
  return hasMethod(value) && hasId(value)
}

function isServerNotification(value: unknown): value is { method: string; params?: unknown } {
  return hasMethod(value) && !hasId(value)
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return hasId(value) && !hasMethod(value)
}

function hasMethod(value: unknown): value is { method: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { method?: unknown }).method === 'string'
  )
}

function hasId(value: unknown): value is { id: JsonRpcId } {
  const id =
    typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : undefined
  return typeof id === 'string' || typeof id === 'number'
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown, key: string): string | undefined {
  const record = readRecord(value)
  const candidate = record[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return readRecord(parsed)
  } catch {
    return null
  }
}

function readCodexLogMessage(value: Record<string, unknown>): string | undefined {
  const fields = readRecord(value['fields'])
  return readString(fields, 'message') ?? readString(value, 'message')
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const record = readRecord(value)
  const candidate = record[key]
  return typeof candidate === 'boolean' ? candidate : undefined
}

export function readProviderThreadId(value: unknown): string | undefined {
  const thread = readRecord(value).thread
  return (
    readString(value, 'threadId') ??
    readString(value, 'id') ??
    readString(thread, 'threadId') ??
    readString(thread, 'id')
  )
}

function readResumeThreadId(value: unknown): string | undefined {
  return readString(value, 'threadId')
}

function isRecoverableMissingThread(message: string): boolean {
  return ['not found', 'missing thread', 'no such thread', 'unknown thread', 'does not exist'].some(
    (snippet) => message.includes(snippet)
  )
}

export function parseModelList(result: unknown): ModelInfo[] {
  const record = readRecord(result)
  const raw = Array.isArray(record['data']) ? record['data'] : record['models']
  if (!Array.isArray(raw)) return []
  const models: ModelInfo[] = []
  for (const item of raw) {
    const id = readString(item, 'id') ?? readString(item, 'model')
    if (!id) continue
    models.push({
      id,
      name: readString(item, 'displayName') ?? readString(item, 'name'),
      description: readString(item, 'description'),
      hidden: readBoolean(item, 'hidden'),
      isDefault: readBoolean(item, 'isDefault')
    })
  }
  return models
}

function optionalModel(model: string | undefined): { model?: string } {
  const trimmed = model?.trim()
  return trimmed ? { model: trimmed } : {}
}

function normalizeCodexAnswers(
  answers: Record<string, unknown>
): Record<string, { answers: string[] }> {
  const normalized: Record<string, { answers: string[] }> = {}
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === 'string') normalized[key] = { answers: [value] }
    else if (Array.isArray(value)) normalized[key] = { answers: value.map(String) }
    else if (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as { answers?: unknown }).answers)
    ) {
      normalized[key] = { answers: (value as { answers: unknown[] }).answers.map(String) }
    } else normalized[key] = { answers: [String(value)] }
  }
  return normalized
}

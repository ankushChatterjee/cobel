import type { Part, PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2'
import type {
  CanonicalItemType,
  CanonicalRequestType,
  FileReadPreview,
  ProviderApprovalDecision,
  ProviderRuntimeEvent
} from '../../../../shared/agent'
import type { FileEditChange } from '../../../../shared/fileEditChanges'
import { fileEditChangesFromOpenCodeMetadata } from '../../../../shared/fileEditChanges'
import { createEventId, nowIso } from '../types'
import {
  appendOpenCodeAssistantTextDelta,
  mergeOpenCodeAssistantText,
  openCodeQuestionId
} from './opencodeRuntime'

// ─── Top-level turn phases ──────────────────────────────────────────────────

type TurnPhase = 'idle' | 'running' | 'awaiting_idle' | 'interrupted' | 'failed' | 'completed'

const TERMINAL_PHASES: ReadonlySet<TurnPhase> = new Set(['interrupted', 'failed', 'completed'])

// ─── Sub-FSM phases ──────────────────────────────────────────────────────────

type PartPhase = 'pending' | 'running' | 'terminal'
type PermissionPhase = 'open' | 'replying' | 'resolved'
type QuestionPhase = 'open' | 'resolved'

interface PermissionLifecycleRecord {
  phase: PermissionPhase
  requestType: CanonicalRequestType
  request: PermissionRequest
  toolCallId?: string
  detail: string
  args: unknown
  finalDecision?: ProviderApprovalDecision
}

export interface PermissionReplyTransition {
  effects: ProviderRuntimeEvent[]
  shouldReplyToSdk: boolean
}

// ─── SDK event shape ─────────────────────────────────────────────────────────

export type SdkEventRaw = {
  type: string
  properties: Record<string, unknown>
}

// ─── FSM result ─────────────────────────────────────────────────────────────

export type InvalidReason = 'terminal' | 'duplicate' | 'unknown_id' | 'wrong_phase' | 'no_active_turn' | 'dropped'

export type FsmResult =
  | { ok: true; effects: ProviderRuntimeEvent[] }
  | { ok: false; reason: InvalidReason; effects?: never }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value).toISOString()
}

function basenamePath(filePath: string): string {
  const t = filePath.trim()
  if (!t) return t
  const norm = t.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

function readInputFilePath(state: Extract<Part, { type: 'tool' }>['state']): string | undefined {
  if (!('input' in state) || !state.input || typeof state.input !== 'object') return undefined
  const fp = (state.input as Record<string, unknown>).filePath
  return typeof fp === 'string' && fp.trim() ? fp.trim() : undefined
}

function textFromPart(part: Part): string | undefined {
  if (part.type === 'text' || part.type === 'reasoning') return part.text
  return undefined
}

function toToolLifecycleItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase()
  if (normalized.includes('bash') || normalized.includes('command')) return 'command_execution'
  if (
    normalized.includes('edit') ||
    normalized.includes('write') ||
    normalized.includes('patch') ||
    normalized.includes('multiedit')
  ) {
    return 'file_change'
  }
  if (normalized === 'grep') return 'code_search'
  if (normalized.includes('web')) return 'web_search'
  if (normalized.includes('mcp')) return 'mcp_tool_call'
  if (normalized.includes('image')) return 'image_view'
  if (
    normalized.includes('task') ||
    normalized.includes('agent') ||
    normalized.includes('subtask')
  ) {
    return 'collab_agent_tool_call'
  }
  return 'dynamic_tool_call'
}

export function mapPermissionToRequestType(permission: string): CanonicalRequestType {
  switch (permission) {
    case 'bash':
      return 'command_execution_approval'
    case 'read':
      return 'file_read_approval'
    case 'edit':
      return 'file_change_approval'
    default:
      return 'unknown'
  }
}

function mapPermissionDecision(reply: 'once' | 'always' | 'reject'): ProviderApprovalDecision {
  switch (reply) {
    case 'once':
      return 'accept'
    case 'always':
      return 'acceptForSession'
    case 'reject':
    default:
      return 'decline'
  }
}

function toolPartItemId(part: Extract<Part, { type: 'tool' }>): string {
  return part.callID || part.id
}

function toolStateCreatedAt(part: Extract<Part, { type: 'tool' }>): string | undefined {
  switch (part.state.status) {
    case 'running':
      return isoFromEpochMs(part.state.time?.start)
    case 'completed':
    case 'error':
      return isoFromEpochMs(part.state.time?.end)
    default:
      return undefined
  }
}

function detailFromToolPart(part: Extract<Part, { type: 'tool' }>): string | undefined {
  switch (part.state.status) {
    case 'completed':
      return part.state.output
    case 'error':
      return part.state.error
    case 'running':
      return part.state.title
    default:
      return undefined
  }
}

function parseOpenCodeReadTaggedOutput(output: string):
  | { path: string; resourceType?: string; content: string }
  | undefined {
  const pathMatch = output.match(/<path>([\s\S]*?)<\/path>/i)
  const typeMatch = output.match(/<type>([\s\S]*?)<\/type>/i)
  const contentMatch = output.match(/<content>([\s\S]*?)<\/content>/i)
  if (!pathMatch && !contentMatch) return undefined
  const path = pathMatch?.[1]?.trim() ?? ''
  const resourceType = typeMatch?.[1]?.trim()
  const content = contentMatch?.[1]?.trim() ?? ''
  if (!path && !content) return undefined
  return { path: path || '(file)', resourceType, content }
}

function fileReadPreviewFromOpenCodeReadTool(
  part: Extract<Part, { type: 'tool' }>
): FileReadPreview | undefined {
  if (part.tool.toLowerCase() !== 'read') return undefined
  const { state } = part
  let path = readInputFilePath(state) ?? ''
  let content = ''
  let resourceType: string | undefined
  let truncated: boolean | undefined

  if (state.status === 'completed' && 'output' in state && typeof state.output === 'string') {
    const parsed = parseOpenCodeReadTaggedOutput(state.output)
    if (parsed) {
      path = path || parsed.path
      content = parsed.content
      resourceType = parsed.resourceType
    } else if (state.output.trim()) {
      content = state.output
    }
  } else if (
    (state.status === 'running' || state.status === 'pending') &&
    'metadata' in state &&
    state.metadata &&
    typeof state.metadata === 'object'
  ) {
    const m = state.metadata as Record<string, unknown>
    if (typeof m.preview === 'string') content = m.preview
    if (typeof m.truncated === 'boolean') truncated = m.truncated
  }

  if (!path && !content.trim()) return undefined
  return { path: path || '(file)', content, resourceType, truncated }
}

export function fileEditChangesFromOpenCodeToolPart(part: Part): FileEditChange[] | undefined {
  if (part.type !== 'tool') return undefined
  const toolName = part.tool.toLowerCase()
  if (
    !toolName.includes('edit') &&
    !toolName.includes('write') &&
    !toolName.includes('patch') &&
    !toolName.includes('multiedit')
  ) {
    return undefined
  }
  const fallbacks: string[] = []
  const { state } = part
  if (
    state.status !== 'pending' &&
    'input' in state &&
    state.input &&
    typeof state.input === 'object'
  ) {
    const fp = (state.input as Record<string, unknown>).filePath
    if (typeof fp === 'string' && fp.trim()) fallbacks.push(fp)
  }
  const stateMeta =
    (state.status === 'running' || state.status === 'completed' || state.status === 'error') &&
    'metadata' in state &&
    state.metadata &&
    typeof state.metadata === 'object'
      ? state.metadata
      : undefined
  const fromState = fileEditChangesFromOpenCodeMetadata(stateMeta, fallbacks)
  if (fromState && fromState.length > 0) return fromState
  const partMeta = part.metadata && typeof part.metadata === 'object' ? part.metadata : undefined
  const fromPart = fileEditChangesFromOpenCodeMetadata(partMeta, fallbacks)
  if (fromPart && fromPart.length > 0) return fromPart
  return undefined
}

export function todoItemsFromOpenCodeToolPart(part: Extract<Part, { type: 'tool' }>): Array<{
  id?: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}> {
  if (part.tool.toLowerCase() !== 'todowrite') return []
  const sources: unknown[] = []
  if ('output' in part.state && typeof part.state.output === 'string') {
    try {
      sources.push(JSON.parse(part.state.output))
    } catch {
      // ignore
    }
  }
  if ('metadata' in part.state) sources.push(part.state.metadata)
  sources.push(part.metadata)
  if ('input' in part.state) sources.push(part.state.input)
  for (const source of sources) {
    const items = readTodoItems(source)
    if (items.length > 0) return items
  }
  return []
}

function readTodoItems(value: unknown): Array<{
  id?: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!record) return []
  const candidates = [record.todos, record.items, record.steps, record.tasks, record.plan]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const items = candidate
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null
          const r = entry as Record<string, unknown>
          const textCandidate = [r.content, r.text, r.step, r.task, r.title].find(
            (c) => typeof c === 'string' && (c as string).trim().length > 0
          )
          if (typeof textCandidate !== 'string') return null
          const normalized = (r.status as string | undefined)?.trim().toLowerCase() ?? ''
          const status =
            normalized === 'completed' || normalized === 'done' || normalized === 'success'
              ? ('completed' as const)
              : normalized === 'in_progress' ||
                  normalized === 'inprogress' ||
                  normalized === 'active' ||
                  normalized === 'running' ||
                  normalized === 'current'
                ? ('in_progress' as const)
                : ('pending' as const)
          return { id: typeof r.id === 'string' ? r.id : undefined, text: textCandidate.trim(), status }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      if (items.length > 0) return items
    }
  }
  return []
}

export function toolLifecycleTitle(part: Extract<Part, { type: 'tool' }>): string {
  const st = part.state
  const toolLower = part.tool.toLowerCase()

  if (toolLower === 'todowrite') return 'Editing todos'

  // Pending with no input yet → placeholder title
  if (st.status === 'pending') {
    const fp = readInputFilePath(st)
    if (fp) return basenamePath(fp)
    return `Preparing ${part.tool}`
  }

  // For running/completed prefer filePath from input over state title
  const fp = readInputFilePath(st)
  if (fp) return basenamePath(fp)

  if ('title' in st && typeof st.title === 'string' && st.title.trim()) {
    const t = st.title.trim()
    if (!(toolLower === 'grep' && t.toLowerCase() === 'grep')) return t
  }

  if (toolLower === 'grep' && 'input' in st && st.input && typeof st.input === 'object') {
    const input = st.input as Record<string, unknown>
    const pattern =
      typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : ''
    if (pattern) {
      const include =
        typeof input.include === 'string' && input.include.trim() ? input.include.trim() : ''
      return include ? `${pattern} (${include})` : pattern
    }
  }

  return part.tool
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return 'OpenCode session failed.'
  const data = 'data' in error && error.data && typeof error.data === 'object' ? error.data : null
  const message = data && 'message' in data ? data.message : null
  return typeof message === 'string' && message.trim().length > 0
    ? message
    : 'OpenCode session failed.'
}

function isMessageAbortedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as Record<string, unknown>
  if (typeof e.name === 'string' && e.name === 'MessageAbortedError') return true
  const data = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : null
  if (data && typeof data.name === 'string' && data.name === 'MessageAbortedError') return true
  const msg = sessionErrorMessage(error)
  return msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('MessageAborted'.toLowerCase())
}

function normalizeQuestionRequest(request: QuestionRequest): Array<{
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }>
}> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description
    }))
  }))
}

// ─── OpenCodeSessionFsm ──────────────────────────────────────────────────────

/**
 * Strict finite-state machine for a single OpenCode session context.
 *
 * Owns all per-turn and per-message maps.  Each method returns a list of
 * `ProviderRuntimeEvent` objects ("effects") that the adapter must emit in
 * order.  No side effects beyond updating internal state.
 */
export class OpenCodeSessionFsm {
  private readonly PROVIDER = 'opencode' as const

  // ── Turn-level state ────────────────────────────────────────────────────────
  private turnPhase: TurnPhase = 'idle'
  private _activeTurnId: string | undefined
  private _lastTurnId: string | undefined
  /** B4: next turn queued while previous is awaiting_idle */
  private queuedTurnId: string | undefined
  private queuedTurnModelSlug: string | undefined
  private queuedTurnEffort: string | undefined
  /** B5: set by interrupt(), cleared on swallow or next startTurn */
  private pendingInterruptId: string | undefined

  // ── Sub-FSM maps ────────────────────────────────────────────────────────────
  private readonly partPhaseById = new Map<string, PartPhase>()
  private readonly permissionPhaseById = new Map<string, PermissionPhase>()
  private readonly permissionTypeById = new Map<string, CanonicalRequestType>()
  private readonly permissionById = new Map<string, PermissionLifecycleRecord>()
  private readonly toolKeyToRequestId = new Map<string, string>()
  private readonly questionPhaseById = new Map<string, QuestionPhase>()
  private readonly completedReasoningPartIds = new Set<string>()

  // ── Data maps (moved from OpenCodeSessionContext) ───────────────────────────
  private readonly messageRoleById = new Map<string, 'user' | 'assistant'>()
  private readonly messageTurnIdById = new Map<string, string>()
  private readonly _partById = new Map<string, Part>()
  private readonly partTurnIdById = new Map<string, string>()
  private readonly emittedTextByPartId = new Map<string, string>()
  private readonly pendingPartTextDeltas = new Map<string, string>()
  private readonly _pendingPermissions = new Map<string, PermissionRequest>()
  private readonly _pendingQuestions = new Map<string, QuestionRequest>()

  // ── Plan-mode accumulated text ──────────────────────────────────────────────
  private readonly planTextByMessageId = new Map<string, string>()

  private _interactionMode: string = 'default'

  constructor(
    private readonly threadId: string,
    private readonly openCodeSessionId: string
  ) {}

  // ── Public getters ──────────────────────────────────────────────────────────

  get activeTurnId(): string | undefined {
    return this._activeTurnId
  }

  get lastTurnId(): string | undefined {
    return this._lastTurnId
  }

  get pendingPermissions(): ReadonlyMap<string, PermissionRequest> {
    return this._pendingPermissions
  }

  get pendingQuestions(): ReadonlyMap<string, QuestionRequest> {
    return this._pendingQuestions
  }

  get partById(): ReadonlyMap<string, Part> {
    return this._partById
  }

  hasPermissionRequest(requestId: string): boolean {
    return this.permissionPhaseById.has(requestId)
  }

  hasQuestionRequest(requestId: string): boolean {
    return this.questionPhaseById.has(requestId)
  }

  setInteractionMode(mode: string): void {
    this._interactionMode = mode
  }

  // ── Context belonging ───────────────────────────────────────────────────────

  eventBelongsToContext(event: SdkEventRaw): boolean {
    const sessionId = event.properties?.sessionID as string | undefined
    if (sessionId) return sessionId === this.openCodeSessionId

    switch (event.type) {
      case 'message.updated': {
        const info = event.properties.info as { id?: string } | undefined
        const messageId = info?.id
        if (!messageId) return false
        if (this.messageRoleById.has(messageId)) return true
        for (const part of this._partById.values()) {
          if (part.messageID === messageId) return true
        }
        return false
      }
      case 'message.removed': {
        const messageId = event.properties.messageID as string | undefined
        return Boolean(messageId && this.messageRoleById.has(messageId))
      }
      case 'message.part.removed':
      case 'message.part.delta': {
        const partId = event.properties.partID as string | undefined
        return Boolean(
          partId && (this._partById.has(partId) || this.pendingPartTextDeltas.has(partId))
        )
      }
      case 'message.part.updated': {
        const part = event.properties.part as Part | undefined
        if (!part) return false
        if (this._partById.has(part.id)) return true
        if (this.messageRoleById.has(part.messageID)) return true
        return false
      }
      case 'permission.replied': {
        const requestId = event.properties.requestID as string | undefined
        return Boolean(requestId && this._pendingPermissions.has(requestId))
      }
      case 'question.replied':
      case 'question.rejected': {
        const requestId = event.properties.requestID as string | undefined
        return Boolean(requestId && this._pendingQuestions.has(requestId))
      }
      default:
        return false
    }
  }

  // ── Turn lifecycle (called from adapter) ────────────────────────────────────

  /**
   * Called from `sendTurn`.  If already awaiting_idle, queues the new turn
   * and defers its `turn.started` emission until the next `idle()`.  Always
   * returns the effects that must be emitted immediately.
   */
  beginTurn(
    turnId: string,
    opts: { model?: string; effort?: string } = {}
  ): ProviderRuntimeEvent[] {
    // Reset pendingInterruptId on every new turn start
    this.pendingInterruptId = undefined

    if (this.turnPhase === 'awaiting_idle') {
      // B4: queue the next turn, do NOT emit turn.started yet
      this.queuedTurnId = turnId
      this.queuedTurnModelSlug = opts.model
      this.queuedTurnEffort = opts.effort
      return []
    }

    if (this.turnPhase === 'running') {
      // Already running — treat as queued too
      this.queuedTurnId = turnId
      this.queuedTurnModelSlug = opts.model
      this.queuedTurnEffort = opts.effort
      return []
    }

    // idle / terminal (after resetForNewTurn) → start the turn
    this.turnPhase = 'running'
    this._activeTurnId = turnId
    this._lastTurnId = turnId
    this.partPhaseById.clear()
    this.completedReasoningPartIds.clear()
    this.planTextByMessageId.clear()

    return [this.buildTurnStarted(turnId, opts.model, opts.effort)]
  }

  /**
   * Reset after a terminal turn so the next `beginTurn` can proceed.
   * Only called from `sendTurn` when starting fresh.
   */
  resetForNewTurn(): void {
    if (TERMINAL_PHASES.has(this.turnPhase)) {
      this.turnPhase = 'idle'
      this._activeTurnId = undefined
    }
    this.queuedTurnId = undefined
    this.queuedTurnModelSlug = undefined
    this.queuedTurnEffort = undefined
    this.pendingInterruptId = undefined
  }

  /**
   * Called from `interruptTurn`.  Marks turn as interrupted.
   * Returns `turn.completed: interrupted`.
   */
  doInterrupt(turnId: string | undefined): ProviderRuntimeEvent[] {
    const tid = turnId ?? this._activeTurnId
    if (!tid) return []
    this.pendingInterruptId = tid
    this._activeTurnId = undefined
    this._lastTurnId = tid
    this.turnPhase = 'interrupted'
    return [
      this.buildEvent({
        type: 'turn.completed',
        turnId: tid,
        payload: { state: 'interrupted' }
      })
    ]
  }

  // ── Main SDK event dispatcher ───────────────────────────────────────────────

  dispatch(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const wireSessionId = event.properties?.sessionID as string | undefined
    const sessionOwnsTurnLifecycle = wireSessionId === this.openCodeSessionId

    switch (event.type) {
      case 'message.updated':
        return this.handleMessageUpdated(event)
      case 'message.removed':
        return this.handleMessageRemoved(event)
      case 'message.part.removed':
        return this.handleMessagePartRemoved(event)
      case 'message.part.delta':
        return this.handleMessagePartDelta(event)
      case 'message.part.updated':
        return this.handleMessagePartUpdated(event)
      case 'permission.asked':
        return this.handlePermissionAsked(event)
      case 'permission.replied':
        return this.handlePermissionReplied(event)
      case 'question.asked':
        return this.handleQuestionAsked(event)
      case 'question.replied':
        return this.handleSdkQuestionReplied(event)
      case 'question.rejected':
        return this.handleSdkQuestionRejected(event)
      case 'session.status':
        return this.handleSessionStatus(event, sessionOwnsTurnLifecycle)
      case 'session.diff':
        // B3: drop cumulative diff tile entirely
        return []
      case 'session.compacted':
        return this.handleSessionCompacted(event)
      case 'session.idle':
        return this.handleSessionIdle(event, sessionOwnsTurnLifecycle)
      case 'session.error':
        return this.handleSessionError(event, sessionOwnsTurnLifecycle)
      default:
        return []
    }
  }

  // ── Permission reply (called from respondToApproval) ─────────────────────────

  replyToPermission(
    requestId: string,
    decision: ProviderApprovalDecision,
    raw: unknown
  ): PermissionReplyTransition {
    const record = this.permissionById.get(requestId)
    if (!record || record.phase !== 'open') {
      return { effects: [], shouldReplyToSdk: false }
    }
    record.phase = 'replying'
    this.permissionPhaseById.set(requestId, 'replying')
    const effects = this.resolvePermission(requestId, decision, raw)
    return { effects, shouldReplyToSdk: effects.length > 0 }
  }

  /**
   * Marks a permission as in-replying state without resolving it yet.
   * Used when we want to defer resolution to the permission.replied echo.
   */
  markPermissionReplying(requestId: string): void {
    const phase = this.permissionPhaseById.get(requestId)
    if (phase === 'open') this.permissionPhaseById.set(requestId, 'replying')
  }

  private resolvePermission(
    requestId: string,
    decision: ProviderApprovalDecision,
    raw: unknown
  ): ProviderRuntimeEvent[] {
    const phase = this.permissionPhaseById.get(requestId)
    if (!phase || phase === 'resolved') return []
    this.permissionPhaseById.set(requestId, 'resolved')
    const record = this.permissionById.get(requestId)
    if (record) {
      record.phase = 'resolved'
      record.finalDecision = decision
    }
    this._pendingPermissions.delete(requestId)
    const requestType = record?.requestType ?? this.permissionTypeById.get(requestId) ?? 'unknown'
    const turnId = this._activeTurnId ?? this._lastTurnId
    return [
      this.buildEvent({
        type: 'request.resolved',
        turnId,
        requestId,
        raw,
        payload: { requestType, decision }
      })
    ]
  }

  // ── Question reply (called from respondToUserInput — B8 optimistic close) ───

  replyToQuestion(
    requestId: string,
    answers: Record<string, unknown>,
    request: QuestionRequest,
    raw: unknown
  ): ProviderRuntimeEvent[] {
    const phase = this.questionPhaseById.get(requestId)
    if (!phase || phase === 'resolved') return []
    this.questionPhaseById.set(requestId, 'resolved')
    this._pendingQuestions.delete(requestId)
    const mappedAnswers = Object.fromEntries(
      request.questions.map((q, i) => [openCodeQuestionId(i, q), answers[openCodeQuestionId(i, q)] ?? answers[q.header] ?? answers[q.question] ?? ''])
    )
    const turnId = this._activeTurnId ?? this._lastTurnId
    return [
      this.buildEvent({
        type: 'user-input.resolved',
        turnId,
        requestId,
        raw,
        payload: { answers: mappedAnswers }
      })
    ]
  }

  // ── compact (called from session.compacted handler and externally) ───────────

  compact(raw: unknown): ProviderRuntimeEvent[] {
    // Clear per-message and per-part caches — keeps active turn FSM state
    this.messageRoleById.clear()
    this.messageTurnIdById.clear()
    this._partById.clear()
    this.partTurnIdById.clear()
    this.emittedTextByPartId.clear()
    this.pendingPartTextDeltas.clear()
    this.partPhaseById.clear()
    this.completedReasoningPartIds.clear()
    this.planTextByMessageId.clear()
    return [
      this.buildEvent({
        type: 'runtime.info',
        raw,
        payload: { kind: 'session.compacted', message: 'Session compacted' }
      })
    ]
  }

  // ── Private handlers ──────────────────────────────────────────────────────────

  private handleMessageUpdated(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const turnId = this._activeTurnId
    const info = event.properties.info as {
      id?: string
      role?: 'user' | 'assistant'
      finish?: unknown
    }
    if (info.id && info.role) this.messageRoleById.set(info.id, info.role)
    if (info.id && turnId) this.messageTurnIdById.set(info.id, turnId)

    const effects: ProviderRuntimeEvent[] = []

    if (info.role === 'assistant') {
      this.handleAssistantFinish(info.finish)
    }

    // Flush buffered deltas for parts of this message
    if (info.role === 'assistant' && info.id) {
      for (const part of this._partById.values()) {
        if (part.messageID !== info.id) continue
        const partTurnId = this.resolveTurnIdForPart(part.id, turnId)
        effects.push(...this.flushBufferedDelta(part, partTurnId, event))
      }
    }

    // Re-emit text for parts of this message (dedup via emittedTextByPartId)
    if (info.role === 'assistant' && info.id) {
      for (const part of this._partById.values()) {
        if (part.messageID !== info.id) continue
        const partTurnId = this.resolveTurnIdForPart(part.id, turnId)
        effects.push(...this.emitAssistantTextDelta(part, partTurnId, event))
      }
    }

    return effects
  }

  private handleMessageRemoved(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const messageID = event.properties.messageID as string
    this.messageRoleById.delete(messageID)
    this.messageTurnIdById.delete(messageID)
    return []
  }

  private handleMessagePartRemoved(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const partID = event.properties.partID as string
    this._partById.delete(partID)
    this.pendingPartTextDeltas.delete(partID)
    this.emittedTextByPartId.delete(partID)
    return []
  }

  private handleMessagePartDelta(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const partID = event.properties.partID as string
    const delta = (event.properties.delta as string) ?? ''
    if (!delta) return []

    const existingPart = this._partById.get(partID)
    if (!existingPart) {
      const buf = this.pendingPartTextDeltas.get(partID) ?? ''
      this.pendingPartTextDeltas.set(partID, buf + delta)
      return []
    }

    const role = this.messageRoleForPart(existingPart)
    if (role !== 'assistant') return []

    const partTurnId = this.resolveTurnIdForPart(partID, this._activeTurnId)
    const streamKind = this.resolveTextStreamKind(existingPart)
    const previousText =
      this.emittedTextByPartId.get(partID) ?? textFromPart(existingPart) ?? ''
    const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta)
    if (!deltaToEmit) return []

    this.emittedTextByPartId.set(partID, nextText)
    if (existingPart.type === 'text' || existingPart.type === 'reasoning') {
      this._partById.set(partID, { ...existingPart, text: nextText })
    }

    return [
      this.buildEvent({
        type: 'content.delta',
        turnId: partTurnId,
        itemId: partID,
        raw: event,
        payload: { streamKind, delta: deltaToEmit }
      })
    ]
  }

  private handleMessagePartUpdated(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const part = event.properties.part as Part
    const turnId = this._activeTurnId
    this._partById.set(part.id, part)
    if (turnId) this.messageTurnIdById.set(part.messageID, turnId)
    const partTurnId = this.resolveTurnIdForPart(part.id, turnId)

    const effects: ProviderRuntimeEvent[] = []

    // Flush buffered delta if any
    effects.push(...this.flushBufferedDelta(part, partTurnId, event))

    // For assistant text/reasoning parts, emit delta
    const messageRole = this.messageRoleForPart(part)
    if (messageRole === 'assistant') {
      effects.push(...this.emitAssistantTextDelta(part, partTurnId, event))
    }

    // For tool parts
    if (part.type === 'tool') {
      effects.push(...this.handleToolPartUpdated(part, partTurnId, event))
    }

    return effects
  }

  private handleToolPartUpdated(
    part: Extract<Part, { type: 'tool' }>,
    partTurnId: string | undefined,
    raw: SdkEventRaw
  ): ProviderRuntimeEvent[] {
    const itemId = toolPartItemId(part)
    const effects: ProviderRuntimeEvent[] = []

    // Sub-FSM: check if we should emit a snapshot for this tool
    const currentPhase = this.partPhaseById.get(itemId)
    const isTerminal = part.state.status === 'completed' || part.state.status === 'error'

    if (isTerminal) {
      if (currentPhase === 'terminal') return [] // already completed → stale late event
      this.partPhaseById.set(itemId, 'terminal')
    } else if (part.state.status === 'running') {
      if (currentPhase === 'terminal') return [] // running after completed → drop
      this.partPhaseById.set(itemId, 'running')
    } else {
      // pending
      if (currentPhase === undefined) {
        this.partPhaseById.set(itemId, 'pending')
      } else if (currentPhase === 'terminal') {
        return []
      }
    }

    // Todo items
    const todoItems = todoItemsFromOpenCodeToolPart(part)
    if (todoItems.length > 0) {
      effects.push(
        this.buildEvent({
          type: 'todo.updated',
          turnId: partTurnId,
          itemId,
          createdAt: toolStateCreatedAt(part),
          raw,
          payload: { source: 'todo', title: 'Todos', items: todoItems }
        })
      )
    }

    const itemType = toToolLifecycleItemType(part.tool)
    const title = toolLifecycleTitle(part)
    const fileReadPreview = fileReadPreviewFromOpenCodeReadTool(part)
    const detail =
      part.state.status === 'error'
        ? detailFromToolPart(part)
        : fileReadPreview
          ? undefined
          : detailFromToolPart(part)
    const fileEditChanges = fileEditChangesFromOpenCodeToolPart(part)

    const payload: ProviderRuntimeEvent['payload'] & object = {
      itemType,
      ...(part.state.status === 'error'
        ? { status: 'failed' as const }
        : part.state.status === 'completed'
          ? { status: 'completed' as const }
          : { status: 'inProgress' as const }),
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(fileEditChanges ? { fileEditChanges } : {}),
      ...(fileReadPreview ? { fileReadPreview } : {}),
      data: { tool: part.tool, state: part.state }
    }

    const evType =
      part.state.status === 'pending'
        ? 'item.started'
        : part.state.status === 'completed' || part.state.status === 'error'
          ? 'item.completed'
          : 'item.updated'

    effects.push(
      this.buildEvent({
        type: evType,
        turnId: partTurnId,
        itemId,
        createdAt: toolStateCreatedAt(part),
        raw,
        payload
      })
    )

    // Resolve the permission associated with this tool if terminal
    if (isTerminal) {
      const decision: ProviderApprovalDecision = part.state.status === 'error' ? 'cancel' : 'accept'
      effects.push(...this.resolvePermissionForTool(itemId, decision, raw))
    }

    return effects
  }

  private handlePermissionAsked(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const id = event.properties.id as string
    const permission = event.properties.permission as string
    const requestType = mapPermissionToRequestType(permission)
    const tool = event.properties.tool as { callID?: string } | undefined
    const patterns = Array.isArray(event.properties.patterns)
      ? (event.properties.patterns as string[])
      : []
    const existing = this.permissionById.get(id)
    if (existing) {
      if (existing.phase !== 'open') return []
      existing.requestType = requestType
      existing.request = event.properties as unknown as PermissionRequest
      existing.toolCallId = tool?.callID
      existing.detail =
        patterns.length > 0 ? patterns.join('\n') : String(event.properties.permission ?? '')
      existing.args = event.properties.metadata
      this.permissionTypeById.set(id, requestType)
      if (tool?.callID) this.toolKeyToRequestId.set(tool.callID, id)
      this._pendingPermissions.set(id, existing.request)
      return []
    }

    this.permissionPhaseById.set(id, 'open')
    this.permissionTypeById.set(id, requestType)
    if (tool?.callID) this.toolKeyToRequestId.set(tool.callID, id)
    this._pendingPermissions.set(id, event.properties as unknown as PermissionRequest)
    const detail =
      patterns.length > 0 ? patterns.join('\n') : String(event.properties.permission ?? '')
    this.permissionById.set(id, {
      phase: 'open',
      requestType,
      request: event.properties as unknown as PermissionRequest,
      toolCallId: tool?.callID,
      detail,
      args: event.properties.metadata
    })

    const permissionFileEdit =
      requestType === 'file_change_approval'
        ? fileEditChangesFromOpenCodeMetadata(event.properties.metadata, patterns)
        : undefined

    const turnId = this._activeTurnId
    return [
      this.buildEvent({
        type: 'request.opened',
        turnId,
        requestId: id,
        raw: event,
        payload: {
          requestType,
          ...(tool?.callID ? { toolCallId: tool.callID } : {}),
          detail,
          args: event.properties.metadata,
          ...(permissionFileEdit ? { fileEditChanges: permissionFileEdit } : {})
        }
      })
    ]
  }

  private handlePermissionReplied(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const requestID = event.properties.requestID as string
    const reply = event.properties.reply as 'once' | 'always' | 'reject'
    const decision = mapPermissionDecision(reply)
    return this.resolvePermission(requestID, decision, event)
  }

  private handleQuestionAsked(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const id = event.properties.id as string
    const question = event.properties as unknown as QuestionRequest
    this.questionPhaseById.set(id, 'open')
    this._pendingQuestions.set(id, question)

    const turnId = this._activeTurnId
    return [
      this.buildEvent({
        type: 'user-input.requested',
        turnId,
        requestId: id,
        raw: event,
        payload: { questions: normalizeQuestionRequest(question) }
      })
    ]
  }

  private handleSdkQuestionReplied(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const requestID = event.properties.requestID as string
    // If already resolved (B8 optimistic close), drop the echo
    const phase = this.questionPhaseById.get(requestID)
    if (phase === 'resolved') return []

    const request = this._pendingQuestions.get(requestID)
    this.questionPhaseById.set(requestID, 'resolved')
    this._pendingQuestions.delete(requestID)

    const fromSdk = event.properties.answers as string[][] | undefined
    const answers = Object.fromEntries(
      (request?.questions ?? []).map((question, index) => [
        openCodeQuestionId(index, question),
        fromSdk?.[index]?.join(', ') ?? ''
      ])
    )
    const turnId = this._activeTurnId ?? this._lastTurnId
    return [
      this.buildEvent({
        type: 'user-input.resolved',
        turnId,
        requestId: requestID,
        raw: event,
        payload: { answers }
      })
    ]
  }

  private handleSdkQuestionRejected(event: SdkEventRaw): ProviderRuntimeEvent[] {
    const requestID = event.properties.requestID as string
    const phase = this.questionPhaseById.get(requestID)
    if (phase === 'resolved') return []

    this.questionPhaseById.set(requestID, 'resolved')
    this._pendingQuestions.delete(requestID)

    const turnId = this._activeTurnId ?? this._lastTurnId
    return [
      this.buildEvent({
        type: 'user-input.resolved',
        turnId,
        requestId: requestID,
        raw: event,
        payload: { answers: {} }
      })
    ]
  }

  private handleSessionStatus(
    event: SdkEventRaw,
    sessionOwnsTurnLifecycle: boolean
  ): ProviderRuntimeEvent[] {
    const status = event.properties.status as { type?: string; message?: string }

    if (status.type === 'retry') {
      const turnId = this._activeTurnId
      return [
        this.buildEvent({
          type: 'runtime.warning',
          turnId,
          raw: event,
          payload: { message: status.message ?? 'Retry', detail: status }
        })
      ]
    }

    if (status.type === 'busy' && sessionOwnsTurnLifecycle) {
      // Just internal bookkeeping; the turn is already running
      return []
    }

    if (status.type === 'idle' && sessionOwnsTurnLifecycle) {
      return this.handleIdleTransition(event)
    }

    return []
  }

  private handleSessionIdle(
    event: SdkEventRaw,
    sessionOwnsTurnLifecycle: boolean
  ): ProviderRuntimeEvent[] {
    if (!sessionOwnsTurnLifecycle) return []
    return this.handleIdleTransition(event)
  }

  private handleIdleTransition(raw: SdkEventRaw): ProviderRuntimeEvent[] {
    const effects: ProviderRuntimeEvent[] = []

    // Resolve all still-open permissions with 'cancel'
    effects.push(...this.resolveAllOpenPermissions(raw))

    if (this.turnPhase !== 'running' && this.turnPhase !== 'awaiting_idle') {
      // Idle arrived but no active turn (e.g., between turns) — just emit session.state.changed
      effects.push(
        this.buildEvent({
          type: 'session.state.changed',
          raw,
          payload: { state: 'ready' }
        })
      )
      return effects
    }

    const turnId = this._activeTurnId
    if (!turnId) {
      effects.push(
        this.buildEvent({
          type: 'session.state.changed',
          raw,
          payload: { state: 'ready' }
        })
      )
      return effects
    }

    // Complete the current turn
    this.turnPhase = 'completed'
    this._activeTurnId = undefined
    this._lastTurnId = turnId

    effects.push(
      this.buildEvent({
        type: 'session.state.changed',
        turnId,
        raw,
        payload: { state: 'ready' }
      })
    )
    effects.push(
      this.buildEvent({
        type: 'turn.completed',
        turnId,
        raw,
        payload: { state: 'completed' }
      })
    )

    // B4: if a turn was queued, start it now
    if (this.queuedTurnId) {
      const nextTurnId = this.queuedTurnId
      const nextModel = this.queuedTurnModelSlug
      const nextEffort = this.queuedTurnEffort
      this.queuedTurnId = undefined
      this.queuedTurnModelSlug = undefined
      this.queuedTurnEffort = undefined

      this.turnPhase = 'running'
      this._activeTurnId = nextTurnId
      this._lastTurnId = nextTurnId
      this.partPhaseById.clear()
      this.completedReasoningPartIds.clear()
      this.planTextByMessageId.clear()

      effects.push(this.buildTurnStarted(nextTurnId, nextModel, nextEffort))
    }

    return effects
  }

  private handleSessionError(
    event: SdkEventRaw,
    sessionOwnsTurnLifecycle: boolean
  ): ProviderRuntimeEvent[] {
    if (!sessionOwnsTurnLifecycle) return []

    const error = event.properties.error
    const message = sessionErrorMessage(error)

    // B5: swallow MessageAbortedError that follows our own interrupt
    if (this.pendingInterruptId && isMessageAbortedError(error)) {
      this.pendingInterruptId = undefined
      return []
    }
    this.pendingInterruptId = undefined

    const effects: ProviderRuntimeEvent[] = []

    if (this.turnPhase === 'running' || this.turnPhase === 'awaiting_idle') {
      const turnId = this._activeTurnId
      if (turnId) {
        this.turnPhase = 'failed'
        this._activeTurnId = undefined
        this._lastTurnId = turnId
        // Resolve all open permissions with cancel
        effects.push(...this.resolveAllOpenPermissions(event))
        effects.push(
          this.buildEvent({
            type: 'runtime.error',
            turnId,
            raw: event,
            payload: { message, detail: error }
          })
        )
        effects.push(
          this.buildEvent({
            type: 'turn.completed',
            turnId,
            raw: event,
            payload: { state: 'failed', errorMessage: message }
          })
        )
      }
    } else if (this.turnPhase === 'idle' || this.turnPhase === 'completed') {
      // Error without an active turn — still surface as runtime.error
      effects.push(
        this.buildEvent({
          type: 'runtime.error',
          raw: event,
          payload: { message, detail: error }
        })
      )
    }

    return effects
  }

  private handleSessionCompacted(event: SdkEventRaw): ProviderRuntimeEvent[] {
    return this.compact(event)
  }

  // ── Assistantn finish logic ─────────────────────────────────────────────────

  private handleAssistantFinish(finish: unknown): void {
    if (this.turnPhase !== 'running' && this.turnPhase !== 'awaiting_idle') return
    if (finish === 'tool-calls') {
      this.turnPhase = 'running'
    } else if (finish === 'stop') {
      this.turnPhase = 'awaiting_idle'
    }
  }

  // ── Text delta helpers ────────────────────────────────────────────────────

  private flushBufferedDelta(
    part: Part,
    partTurnId: string | undefined,
    raw: SdkEventRaw
  ): ProviderRuntimeEvent[] {
    const buffered = this.pendingPartTextDeltas.get(part.id)
    if (!buffered) return []
    this.pendingPartTextDeltas.delete(part.id)
    if (this.messageRoleForPart(part) !== 'assistant') return []

    const streamKind = this.resolveTextStreamKind(part)
    const previousText = this.emittedTextByPartId.get(part.id) ?? textFromPart(part) ?? ''
    const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, buffered)
    if (!deltaToEmit) return []

    this.emittedTextByPartId.set(part.id, nextText)
    if (part.type === 'text' || part.type === 'reasoning') {
      this._partById.set(part.id, { ...part, text: nextText })
    }

    return [
      this.buildEvent({
        type: 'content.delta',
        turnId: partTurnId,
        itemId: part.id,
        raw,
        payload: { streamKind, delta: deltaToEmit }
      })
    ]
  }

  private emitAssistantTextDelta(
    part: Part,
    partTurnId: string | undefined,
    raw: SdkEventRaw
  ): ProviderRuntimeEvent[] {
    const text = textFromPart(part)
    if (text === undefined) return []

    const previousText = this.emittedTextByPartId.get(part.id)
    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text)
    this.emittedTextByPartId.set(part.id, latestText)

    if (latestText !== text && (part.type === 'text' || part.type === 'reasoning')) {
      this._partById.set(part.id, { ...part, text: latestText })
    }

    const effects: ProviderRuntimeEvent[] = []

    if (deltaToEmit.length > 0) {
      const streamKind = this.resolveTextStreamKind(part)
      const createdAt =
        part.type === 'text' || part.type === 'reasoning'
          ? isoFromEpochMs(part.time?.start)
          : undefined
      effects.push(
        this.buildEvent({
          type: 'content.delta',
          turnId: partTurnId,
          itemId: part.id,
          createdAt,
          raw,
          payload: { streamKind, delta: deltaToEmit }
        })
      )

      // B7: Accumulate plan text for plan-mode turns
      if (streamKind === 'plan_text') {
        const msg = part.type === 'text' || part.type === 'reasoning' ? part.messageID : undefined
        if (msg) {
          const prev = this.planTextByMessageId.get(msg) ?? ''
          this.planTextByMessageId.set(msg, prev + deltaToEmit)
        }
      }
    }

    // Complete reasoning part once time.end is set
    if (part.type === 'reasoning' && this.shouldCompleteReasoningPart(part)) {
      effects.push(
        this.buildEvent({
          type: 'item.completed',
          turnId: partTurnId,
          itemId: part.id,
          createdAt: isoFromEpochMs(part.time.end),
          raw,
          payload: { itemType: 'reasoning', status: 'completed', title: 'Reasoning' }
        })
      )
    }

    return effects
  }

  private shouldCompleteReasoningPart(part: Extract<Part, { type: 'reasoning' }>): boolean {
    if (part.time?.end === undefined || this.completedReasoningPartIds.has(part.id)) return false
    this.completedReasoningPartIds.add(part.id)
    return true
  }

  // ── Permission helpers ────────────────────────────────────────────────────

  private resolvePermissionForTool(
    toolKey: string,
    decision: ProviderApprovalDecision,
    raw: unknown
  ): ProviderRuntimeEvent[] {
    const requestId = this.toolKeyToRequestId.get(toolKey)
    if (!requestId) return []
    return this.resolvePermission(requestId, decision, raw)
  }

  private resolveAllOpenPermissions(raw: unknown): ProviderRuntimeEvent[] {
    const effects: ProviderRuntimeEvent[] = []
    for (const [requestId, phase] of this.permissionPhaseById) {
      if (phase !== 'open' && phase !== 'replying') continue
      effects.push(...this.resolvePermission(requestId, 'cancel', raw))
    }
    return effects
  }

  // ── Utility helpers ────────────────────────────────────────────────────────

  private resolveTurnIdForPart(partId: string, currentTurnId: string | undefined): string | undefined {
    if (currentTurnId) {
      this.partTurnIdById.set(partId, currentTurnId)
      return currentTurnId
    }
    const mapped = this.partTurnIdById.get(partId)
    if (mapped) return mapped
    const part = this._partById.get(partId)
    const messageTurnId = part ? this.messageTurnIdById.get(part.messageID) : undefined
    if (messageTurnId) {
      this.partTurnIdById.set(partId, messageTurnId)
      return messageTurnId
    }
    return this._lastTurnId
  }

  private messageRoleForPart(part: Pick<Part, 'messageID' | 'type'>): 'assistant' | 'user' | undefined {
    const known = this.messageRoleById.get(part.messageID)
    if (known) return known
    return part.type === 'tool' ? 'assistant' : undefined
  }

  private resolveTextStreamKind(part: Part): 'assistant_text' | 'reasoning_text' | 'plan_text' {
    if (part.type === 'reasoning') return 'reasoning_text'
    if (this._interactionMode === 'plan' && part.type === 'text') return 'plan_text'
    return 'assistant_text'
  }

  // ── Event builders ────────────────────────────────────────────────────────

  private buildEvent(opts: {
    type: ProviderRuntimeEvent['type']
    turnId?: string
    itemId?: string
    requestId?: string
    createdAt?: string
    raw?: unknown
    payload: ProviderRuntimeEvent['payload']
  }): ProviderRuntimeEvent {
    return {
      eventId: createEventId('oc'),
      provider: this.PROVIDER,
      threadId: this.threadId,
      createdAt: opts.createdAt ?? nowIso(),
      ...(opts.turnId ? { turnId: opts.turnId } : {}),
      ...(opts.itemId ? { itemId: opts.itemId } : {}),
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
      ...(opts.raw !== undefined
        ? { raw: { source: 'opencode.sdk' as const, payload: opts.raw } }
        : {}),
      type: opts.type,
      payload: opts.payload
    } as ProviderRuntimeEvent
  }

  private buildTurnStarted(
    turnId: string,
    model?: string,
    effort?: string
  ): ProviderRuntimeEvent {
    return this.buildEvent({
      type: 'turn.started',
      turnId,
      payload: { model, effort }
    })
  }
}

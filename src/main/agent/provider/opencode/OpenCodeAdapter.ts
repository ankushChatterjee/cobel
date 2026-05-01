import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest
} from '@opencode-ai/sdk/v2'
import type {
  CanonicalItemType,
  CanonicalRequestType,
  ChatAttachment,
  FileReadPreview,
  ModelInfo,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSummary,
  ReasoningEffort,
  UserInputQuestion
} from '../../../../shared/agent'
import type { FileEditChange } from '../../../../shared/fileEditChanges'
import { fileEditChangesFromOpenCodeMetadata } from '../../../../shared/fileEditChanges'
import {
  buildThreadTitlePrompt,
  parseThreadTitleResponse,
  THREAD_TITLE_OUTPUT_SCHEMA
} from '../../../../shared/threadTitle'
import {
  createEventId,
  nowIso,
  type ProviderAdapter,
  type SendTurnInput,
  type StartSessionInput,
  ProviderEventBus
} from '../types'
import {
  appendOpenCodeAssistantTextDelta,
  buildOpenCodePermissionRules,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  inventoryToModelInfos,
  loadOpenCodeInventory,
  mergeOpenCodeAssistantText,
  openCodeQuestionId,
  parseOpenCodeModelSlug,
  readOpencodeResumeSessionId,
  readOpenCodeConfigFromEnv,
  resolveOpenCodeBinaryPath,
  runOpenCodeCommand,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection
} from './opencodeRuntime'
import { traceCommandEvent } from '../../debug/commandEventTrace'
import { dumpOpenCodeSubscribeRawMessage } from './openCodeRawMessageDump'

const PROVIDER = 'opencode' as const

type SdkEvent = {
  type: string
  properties: Record<string, unknown>
}

interface OpenCodeSessionContext {
  session: ProviderSession
  readonly client: OpencodeClient
  readonly server: OpenCodeServerConnection
  readonly directory: string
  readonly openCodeSessionId: string
  /** Maps composer effort → OpenCode `variant` for this session's model (from catalog). */
  variantByEffort: Partial<Record<ReasoningEffort, string>>
  readonly pendingPermissions: Map<string, PermissionRequest>
  readonly pendingQuestions: Map<string, QuestionRequest>
  readonly messageRoleById: Map<string, 'user' | 'assistant'>
  readonly partById: Map<string, Part>
  readonly partTurnIdById: Map<string, string>
  readonly emittedTextByPartId: Map<string, string>
  readonly completedAssistantPartIds: Set<string>
  activeTurnId: string | undefined
  stopped: boolean
  readonly eventsAbortController: AbortController
}

interface OpenCodeProbeResult {
  summary: ProviderSummary
  models: ModelInfo[]
  resolvedBinaryPath: string | null
}

function buildEventBase(input: {
  threadId: string
  turnId?: string
  itemId?: string
  requestId?: string
  createdAt?: string
  raw?: unknown
}): Omit<ProviderRuntimeEvent, 'type' | 'payload'> & { raw?: ProviderRuntimeEvent['raw'] } {
  return {
    eventId: createEventId('oc'),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: 'opencode.sdk',
            payload: input.raw
          }
        }
      : {})
  }
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
  if (normalized.includes('task') || normalized.includes('agent') || normalized.includes('subtask')) {
    return 'collab_agent_tool_call'
  }
  return 'dynamic_tool_call'
}

function mapPermissionToRequestType(permission: string): CanonicalRequestType {
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

function mapPermissionDecision(reply: 'once' | 'always' | 'reject'): string {
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

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text
    default:
      return undefined
  }
}

function resolveTextStreamKind(part: Part | undefined): 'assistant_text' | 'reasoning_text' {
  return part?.type === 'reasoning' ? 'reasoning_text' : 'assistant_text'
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, 'messageID' | 'type'>
): 'assistant' | 'user' | undefined {
  const known = context.messageRoleById.get(part.messageID)
  if (known) return known
  return part.type === 'tool' ? 'assistant' : undefined
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value).toISOString()
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

function toolStateCreatedAt(part: Extract<Part, { type: 'tool' }>): string | undefined {
  switch (part.state.status) {
    case 'running':
      return isoFromEpochMs(part.state.time.start)
    case 'completed':
    case 'error':
      return isoFromEpochMs(part.state.time.end)
    default:
      return undefined
  }
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
  if (state.status !== 'pending' && 'input' in state && state.input && typeof state.input === 'object') {
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

function fileEditChangesFromSessionDiff(diff: unknown): FileEditChange[] | undefined {
  if (!Array.isArray(diff)) return undefined
  const out: FileEditChange[] = []
  for (const entry of diff) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const file = typeof e.file === 'string' ? e.file : ''
    const patch = typeof e.patch === 'string' ? e.patch.trimEnd() : ''
    if (file && patch) out.push({ path: file, diff: patch })
  }
  return out.length > 0 ? out : undefined
}

function basenamePath(filePath: string): string {
  const t = filePath.trim()
  if (!t) return t
  const norm = t.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

/** OpenCode read tool wraps path/type/content in pseudo-tags on stdout. */
function parseOpenCodeReadTaggedOutput(output: string): {
  path: string
  resourceType?: string
  content: string
} | undefined {
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

function readInputFilePath(state: Extract<Part, { type: 'tool' }>['state']): string | undefined {
  if (!('input' in state) || !state.input || typeof state.input !== 'object') return undefined
  const fp = (state.input as Record<string, unknown>).filePath
  return typeof fp === 'string' && fp.trim() ? fp.trim() : undefined
}

function fileReadPreviewFromOpenCodeReadTool(part: Extract<Part, { type: 'tool' }>): FileReadPreview | undefined {
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

export function todoItemsFromOpenCodeToolPart(
  part: Extract<Part, { type: 'tool' }>
): Array<{
  id?: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}> {
  if (part.tool.toLowerCase() !== 'todowrite') return []

  const sources: unknown[] = []
  if ('input' in part.state) sources.push(part.state.input)
  if ('metadata' in part.state) sources.push(part.state.metadata)
  sources.push(part.metadata)
  if ('output' in part.state && typeof part.state.output === 'string') {
    const parsed = tryParseJson(part.state.output)
    if (parsed !== null) sources.push(parsed)
  }

  for (const source of sources) {
    const items = readTodoItems(source)
    if (items.length > 0) return items
  }
  return []
}

function readTodoItems(
  value: unknown
): Array<{
  id?: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!record) return []
  const candidates = [
    record.todos,
    record.items,
    record.steps,
    record.tasks,
    record.plan
  ]
  for (const candidate of candidates) {
    const items = readTodoItemsArray(candidate)
    if (items.length > 0) return items
  }
  return []
}

function readTodoItemsArray(
  value: unknown
): Array<{
  id?: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}> {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const record = entry as Record<string, unknown>
      const textCandidate = [
        record.content,
        record.text,
        record.step,
        record.task,
        record.title
      ].find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
      if (typeof textCandidate !== 'string') return null
      return {
        id: typeof record.id === 'string' ? record.id : undefined,
        text: textCandidate.trim(),
        status: normalizeOpenCodeTodoStatus(record.status)
      }
    })
    .filter(
      (
        item
      ): item is {
        id?: string
        text: string
        status: 'pending' | 'in_progress' | 'completed'
      } => item !== null
    )
}

function normalizeOpenCodeTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  if (typeof value !== 'string') return 'pending'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'completed' || normalized === 'done' || normalized === 'success')
    return 'completed'
  if (
    normalized === 'in_progress' ||
    normalized === 'inprogress' ||
    normalized === 'active' ||
    normalized === 'running' ||
    normalized === 'current'
  ) {
    return 'in_progress'
  }
  return 'pending'
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toolLifecycleTitle(part: Extract<Part, { type: 'tool' }>): string {
  const st = part.state
  const toolLower = part.tool.toLowerCase()

  if ('title' in st && typeof st.title === 'string' && st.title.trim()) {
    const t = st.title.trim()
    if (!(toolLower === 'grep' && t.toLowerCase() === 'grep')) return t
  }

  if (toolLower === 'grep' && 'input' in st && st.input && typeof st.input === 'object') {
    const input = st.input as Record<string, unknown>
    const pattern = typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : ''
    if (pattern) {
      const include =
        typeof input.include === 'string' && input.include.trim() ? input.include.trim() : ''
      return include ? `${pattern} (${include})` : pattern
    }
  }

  const fp = readInputFilePath(st)
  if (fp) return basenamePath(fp)
  return part.tool
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return 'OpenCode session failed.'
  const data = 'data' in error && error.data && typeof error.data === 'object' ? error.data : null
  const message = data && 'message' in data ? data.message : null
  return typeof message === 'string' && message.trim().length > 0 ? message : 'OpenCode session failed.'
}

function normalizeQuestionRequest(request: QuestionRequest): UserInputQuestion[] {
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

function effortToVariant(effort: ReasoningEffort | undefined): string | undefined {
  if (!effort) return undefined
  return effort
}

function resolveOpenCodePromptVariant(
  variantByEffort: Partial<Record<ReasoningEffort, string>>,
  effort: ReasoningEffort | undefined
): string | undefined {
  const e = effort ?? 'medium'
  const mapped = variantByEffort[e]
  if (mapped) return mapped
  return effortToVariant(e)
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = PROVIDER
  readonly supportsStructuredOutput = false
  private readonly bus = new ProviderEventBus()
  private readonly sessions = new Map<string, OpenCodeSessionContext>()
  private probeCache: { at: number; result: OpenCodeProbeResult } | null = null
  private readonly cacheTtlMs = 45_000
  /** When true, child `opencode serve` exiting (e.g. SIGINT during app teardown) must not surface as a runtime error. */
  private suppressUnexpectedServerExit = false

  streamEvents(listener: (event: ProviderRuntimeEvent) => void): () => void {
    return this.bus.subscribe(listener)
  }

  async resolveCLI(): Promise<ProviderSummary> {
    const { summary } = await this.probe()
    return summary
  }

  /**
   * Stops every OpenCode session and closes managed `opencode serve` processes.
   * Call from app `before-quit` so the child is not left to die from SIGINT alone.
   */
  async disposeAllSessions(): Promise<void> {
    this.suppressUnexpectedServerExit = true
    const contexts = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(contexts.map((ctx) => stopOpenCodeContext(ctx)))
  }

  async getSummary(): Promise<ProviderSummary> {
    return this.resolveCLI()
  }

  async listModels(): Promise<ModelInfo[]> {
    const { models } = await this.probe()
    return models
  }

  private async probe(): Promise<OpenCodeProbeResult> {
    const now = Date.now()
    if (this.probeCache && now - this.probeCache.at < this.cacheTtlMs) {
      return this.probeCache.result
    }
    const cfg = readOpenCodeConfigFromEnv()
    let summary: ProviderSummary
    let models: ModelInfo[] = []
    let resolvedBinaryPath: string | null = null
    try {
      let version = ''
      resolvedBinaryPath = resolveBinarySafe(cfg.binaryPath)
      if (resolvedBinaryPath) {
        const r = await runOpenCodeCommand({
          binaryPath: resolvedBinaryPath,
          args: ['--version']
        })
        if (r.code === 0) version = r.stdout.trim().split('\n')[0] ?? ''
      }
      if (!resolvedBinaryPath && !cfg.serverUrl) {
        throw new Error(`OpenCode CLI was not found: ${cfg.binaryPath}`)
      }
      const server = await connectToOpenCodeServer({
        binaryPath: resolvedBinaryPath ?? cfg.binaryPath,
        serverUrl: cfg.serverUrl || null
      })
      try {
        const client = createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: process.cwd(),
          ...(server.external && cfg.serverPassword ? { serverPassword: cfg.serverPassword } : {})
        })
        const inv = await loadOpenCodeInventory(client)
        models = inventoryToModelInfos(inv)
        const detailParts = [
          version || (server.external ? 'Remote server' : 'OpenCode CLI'),
          resolvedBinaryPath,
          `${models.length} model${models.length === 1 ? '' : 's'}`
        ].filter((part): part is string => Boolean(part))
        summary = {
          id: PROVIDER,
          name: 'OpenCode',
          status: models.length > 0 ? 'available' : 'error',
          detail:
            models.length > 0
              ? detailParts.join(' · ')
              : 'No connected upstream models (check provider auth in OpenCode).'
        }
      } finally {
        server.close()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      summary = {
        id: PROVIDER,
        name: 'OpenCode',
        status: 'missing',
        detail: formatProbeFailure(msg, cfg.serverUrl)
      }
    }
    const result = { summary, models, resolvedBinaryPath }
    this.probeCache = { at: now, result }
    return result
  }

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    const cfg = readOpenCodeConfigFromEnv()
    const directory = input.cwd?.trim() || process.cwd()

    const alive = this.sessions.get(input.threadId)
    if (alive && !alive.stopped) {
      const modelSlug = input.model?.trim() || alive.session.model || ''
      const { models: catalogModels } = await this.probe()
      alive.variantByEffort =
        catalogModels.find((row) => row.id === modelSlug)?.openCodeVariantByEffort ?? {}
      const resumeCursor = { threadId: alive.openCodeSessionId }
      alive.session = {
        ...alive.session,
        interactionMode: input.interactionMode,
        runtimeMode: input.runtimeMode,
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        resumeCursor,
        updatedAt: nowIso()
      }
      await alive.client.session
        .update({
          sessionID: alive.openCodeSessionId,
          directory: alive.directory,
          permission: buildOpenCodePermissionRules(input.runtimeMode)
        })
        .catch(() => undefined)
      this.emit({
        ...buildEventBase({ threadId: input.threadId }),
        type: 'session.state.changed',
        payload: { state: 'ready' }
      })
      return alive.session
    }
    if (alive && alive.stopped) {
      this.sessions.delete(input.threadId)
    }

    const server = await connectToOpenCodeServer({
      binaryPath: await this.resolveBinaryPath(),
      serverUrl: cfg.serverUrl || null
    })
    const client = createOpenCodeSdkClient({
      baseUrl: server.url,
      directory,
      ...(server.external && cfg.serverPassword ? { serverPassword: cfg.serverPassword } : {})
    })

    const resumeId = readOpencodeResumeSessionId(input.resumeCursor)
    let openCodeSessionId: string | undefined

    if (resumeId) {
      const got = await client.session.get({ sessionID: resumeId, directory })
      const row = got.data as { id?: string } | undefined
      if (row?.id) {
        openCodeSessionId = row.id
      }
    }

    let createdSessionViaApi = false
    if (!openCodeSessionId) {
      const created = await client.session.create({
        title: `Thread ${input.threadId}`,
        permission: buildOpenCodePermissionRules(input.runtimeMode)
      })
      const sessionData = created.data as { id?: string } | undefined
      openCodeSessionId = sessionData?.id
      createdSessionViaApi = true
    }

    if (!openCodeSessionId) {
      server.close()
      throw new Error('OpenCode could not create or resume a session (missing session id).')
    }

    if (!createdSessionViaApi) {
      await client.session
        .update({
          sessionID: openCodeSessionId,
          directory,
          permission: buildOpenCodePermissionRules(input.runtimeMode)
        })
        .catch(() => undefined)
    }

    const { models: catalogModels } = await this.probe()
    const modelSlug = input.model?.trim() ?? ''
    const variantByEffort =
      catalogModels.find((row) => row.id === modelSlug)?.openCodeVariantByEffort ?? {}
    const now = nowIso()
    const resumeCursor = { threadId: openCodeSessionId }
    const session: ProviderSession = {
      provider: PROVIDER,
      status: 'ready',
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      cwd: input.cwd,
      model: input.model,
      threadId: input.threadId,
      resumeCursor,
      createdAt: now,
      updatedAt: now
    }
    const context: OpenCodeSessionContext = {
      session,
      client,
      server,
      directory,
      openCodeSessionId,
      variantByEffort,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      messageRoleById: new Map(),
      partById: new Map(),
      partTurnIdById: new Map(),
      emittedTextByPartId: new Map(),
      completedAssistantPartIds: new Set(),
      activeTurnId: undefined,
      stopped: false,
      eventsAbortController: new AbortController()
    }
    const race = this.sessions.get(input.threadId)
    if (race && !race.stopped) {
      if (race.openCodeSessionId !== openCodeSessionId) {
        await client.session.abort({ sessionID: openCodeSessionId }).catch(() => undefined)
      }
      server.close()
      return race.session
    }
    this.sessions.set(input.threadId, context)
    this.startEventPump(context)
    this.emit({
      ...buildEventBase({ threadId: input.threadId }),
      type: 'session.state.changed',
      payload: { state: 'ready' }
    })
    this.emit({
      ...buildEventBase({ threadId: input.threadId }),
      type: 'thread.started',
      payload: { providerThreadId: openCodeSessionId }
    })
    return session
  }

  async sendTurn(input: SendTurnInput): Promise<{ turnId: string; resumeCursor?: unknown }> {
    const ctx = this.requireSession(input.threadId)
    const turnId = `oc-turn:${randomUUID()}`
    const modelSlug = (input.model ?? ctx.session.model ?? '').trim()
    const parsed = parseOpenCodeModelSlug(modelSlug)
    if (!parsed) {
      throw new Error("OpenCode requires model id in the form 'upstream/model-id' (e.g. anthropic/claude-sonnet-4-20250514).")
    }
    const text = input.input?.trim() ?? ''
    const fileParts = toOpenCodeFileParts({
      attachments: input.attachments,
      resolveAttachmentPath: resolveComposerAttachment
    })
    if (!text && fileParts.length === 0) {
      throw new Error('OpenCode turns require text or at least one resolvable file attachment.')
    }
    const variant = resolveOpenCodePromptVariant(ctx.variantByEffort, input.effort)
    const resolvedEffort = input.effort ?? 'medium'
    const agent = input.interactionMode === 'plan' ? 'plan' : undefined
    ctx.activeTurnId = turnId
    this.emit({
      ...buildEventBase({ threadId: input.threadId, turnId }),
      type: 'turn.started',
      payload: { model: modelSlug || input.model, effort: resolvedEffort }
    })
    try {
      await ctx.client.session.promptAsync({
        sessionID: ctx.openCodeSessionId,
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        parts: [...(text ? [{ type: 'text' as const, text }] : []), ...fileParts]
      })
    } catch (e) {
      ctx.activeTurnId = undefined
      const msg = e instanceof Error ? e.message : String(e)
      this.emit({
        ...buildEventBase({ threadId: input.threadId, turnId }),
        type: 'turn.completed',
        payload: { state: 'failed', errorMessage: msg }
      })
      throw e
    }
    return { turnId, resumeCursor: { threadId: ctx.openCodeSessionId } }
  }

  async generateThreadTitle(input: {
    cwd?: string
    input: string
    model?: string
    useStructuredOutput?: boolean
  }): Promise<string | null> {
    const cfg = readOpenCodeConfigFromEnv()
    const directory = input.cwd?.trim() || process.cwd()
    const server = await connectToOpenCodeServer({
      binaryPath: await this.resolveBinaryPath(),
      serverUrl: cfg.serverUrl || null
    })
    try {
      const client = createOpenCodeSdkClient({
        baseUrl: server.url,
        directory,
        ...(server.external && cfg.serverPassword ? { serverPassword: cfg.serverPassword } : {})
      })
      const inv = await loadOpenCodeInventory(client)
      const models = inventoryToModelInfos(inv)
      const slug = input.model && parseOpenCodeModelSlug(input.model) ? input.model : models[0]?.id
      const parsed = parseOpenCodeModelSlug(slug)
      if (!parsed) return null
      const titleSession = await client.session.create({
        title: 'title-gen',
        permission: buildOpenCodePermissionRules('approval-required')
      })
      const sid = (titleSession.data as { id?: string })?.id
      if (!sid) return null
      const prompt = buildThreadTitlePrompt(input.input)
      const result = await client.session.prompt({
        sessionID: sid,
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        parts: [{ type: 'text', text: prompt }],
        ...(input.useStructuredOutput
          ? {
              format: {
                type: 'json_schema' as const,
                schema: THREAD_TITLE_OUTPUT_SCHEMA,
                retryCount: 2
              }
            }
          : {})
      })
      await client.session.delete({ sessionID: sid }).catch(() => undefined)
      const structured = (result.data?.info as { structured?: unknown })?.structured
      if (
        structured &&
        typeof structured === 'object' &&
        structured !== null &&
        typeof (structured as Record<string, unknown>).title === 'string'
      ) {
        return parseThreadTitleResponse(JSON.stringify(structured))
      }
      // Fallback: read the assistant text from the response parts
      let assistantText = ''
      for (const p of (result.data?.parts ?? []) as Array<{ type?: string; text?: string }>) {
        if (p.type === 'text' && p.text) assistantText += p.text
      }
      const raw = assistantText.trim()
      if (!raw) return null
      return parseThreadTitleResponse(raw)
    } catch {
      return null
    } finally {
      server.close()
    }
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    const ctx = this.sessions.get(input.threadId)
    if (!ctx) return
    await ctx.client.session.abort({ sessionID: ctx.openCodeSessionId }).catch(() => undefined)
    const tid = input.turnId ?? ctx.activeTurnId
    if (tid) {
      this.emit({
        ...buildEventBase({ threadId: input.threadId, turnId: tid }),
        type: 'turn.completed',
        payload: { state: 'interrupted' }
      })
    }
    ctx.activeTurnId = undefined
  }

  async rollbackConversation(input: { threadId: string; numTurns: number }): Promise<void> {
    const ctx = this.requireSession(input.threadId)
    const messages = await ctx.client.session.messages({ sessionID: ctx.openCodeSessionId })
    const data = messages.data as Array<{ info?: { role?: string; id?: string } }> | undefined
    const list = data ?? []
    const assistantMessages = list.filter((m) => m.info?.role === 'assistant')
    const targetIndex = assistantMessages.length - input.numTurns - 1
    const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null
    await ctx.client.session.revert({
      sessionID: ctx.openCodeSessionId,
      ...(target?.info?.id ? { messageID: target.info.id } : {})
    })
  }

  async respondToApproval(input: {
    threadId: string
    requestId: string
    decision: ProviderApprovalDecision
  }): Promise<void> {
    const ctx = this.requireSession(input.threadId)
    const perm = ctx.pendingPermissions.get(input.requestId)
    if (!perm) throw new Error(`Unknown pending permission request: ${input.requestId}`)
    await ctx.client.permission.reply({
      requestID: input.requestId,
      reply: toOpenCodePermissionReply(input.decision)
    })
  }

  async respondToUserInput(input: {
    threadId: string
    requestId: string
    answers: Record<string, unknown>
  }): Promise<void> {
    const ctx = this.requireSession(input.threadId)
    const request = ctx.pendingQuestions.get(input.requestId)
    if (!request) throw new Error(`Unknown pending question request: ${input.requestId}`)
    const answers = toOpenCodeQuestionAnswers(request, input.answers)
    await ctx.client.question.reply({
      requestID: input.requestId,
      answers
    })
  }

  async stopSession(input: { threadId: string }): Promise<void> {
    const ctx = this.sessions.get(input.threadId)
    if (!ctx) return
    await stopOpenCodeContext(ctx)
    this.sessions.delete(input.threadId)
    this.emit({
      ...buildEventBase({ threadId: input.threadId }),
      type: 'session.state.changed',
      payload: { state: 'stopped', reason: 'Session stopped.' }
    })
  }

  async readThread(input: { threadId: string }): Promise<unknown> {
    const ctx = this.sessions.get(input.threadId)
    if (!ctx) return null
    return ctx.client.session.messages({ sessionID: ctx.openCodeSessionId })
  }

  private emit(event: ProviderRuntimeEvent): void {
    traceCommandEvent('provider.runtime', {
      provider: 'opencode',
      eventId: event.eventId,
      threadId: event.threadId,
      turnId: event.turnId ?? null,
      itemId: event.itemId ?? null,
      method: typeof event.raw?.source === 'string' ? event.raw.source : 'opencode.sdk',
      itemType:
        event.type === 'content.delta'
          ? event.payload.streamKind === 'command_output'
            ? 'command_execution'
            : null
          : (readTracePayloadString(event.payload, 'itemType') ?? null),
      streamKind: event.type === 'content.delta' ? event.payload.streamKind : null,
      title: event.type === 'content.delta' ? null : (readTracePayloadString(event.payload, 'title') ?? null),
      detail: event.type === 'content.delta' ? null : (readTracePayloadString(event.payload, 'detail') ?? null),
      runtimeType: event.type
    })
    this.bus.emit(event)
  }

  private async resolveBinaryPath(): Promise<string> {
    const { resolvedBinaryPath } = await this.probe()
    const cfg = readOpenCodeConfigFromEnv()
    if (resolvedBinaryPath) return resolvedBinaryPath
    if (cfg.serverUrl) return cfg.binaryPath
    throw new Error(`OpenCode CLI was not found: ${cfg.binaryPath}`)
  }

  private requireSession(threadId: string): OpenCodeSessionContext {
    const ctx = this.sessions.get(threadId)
    if (!ctx || ctx.stopped) throw new Error(`No active OpenCode session for thread ${threadId}`)
    return ctx
  }

  private startEventPump(context: OpenCodeSessionContext): void {
    void (async () => {
      try {
        const subscription = await context.client.event.subscribe(undefined, {
          signal: context.eventsAbortController.signal
        })
        for await (const rawEvent of subscription.stream) {
          dumpOpenCodeSubscribeRawMessage(rawEvent, { threadId: context.session.threadId })
          const event = rawEvent as SdkEvent
          const payloadSessionId = event.properties?.sessionID as string | undefined
          if (payloadSessionId !== context.openCodeSessionId) continue
          await this.dispatchSdkEvent(context, event)
        }
      } catch (error) {
        if (context.eventsAbortController.signal.aborted || context.stopped) return
        const msg = error instanceof Error ? error.message : 'OpenCode event stream failed.'
        this.emitUnexpectedExit(context, msg)
      }
    })()

    context.server.process?.once('exit', (code, signal) => {
      if (context.stopped || this.suppressUnexpectedServerExit) return
      if (signal === 'SIGINT' || signal === 'SIGTERM') return
      this.emitUnexpectedExit(
        context,
        `OpenCode server exited unexpectedly (${signal ?? code ?? 'unknown'}).`
      )
    })
  }

  private emitUnexpectedExit(context: OpenCodeSessionContext, message: string): void {
    if (context.stopped || this.suppressUnexpectedServerExit) return
    context.stopped = true
    this.sessions.delete(context.session.threadId)
    try {
      context.server.close()
    } catch {
      // ignore
    }
    const turnId = context.activeTurnId
    this.emit({
      ...buildEventBase({ threadId: context.session.threadId, turnId }),
      type: 'runtime.error',
      payload: { message, detail: { class: 'transport_error' } }
    })
    if (turnId) {
      this.emit({
        ...buildEventBase({ threadId: context.session.threadId, turnId }),
        type: 'turn.completed',
        payload: { state: 'failed', errorMessage: message }
      })
    }
  }

  private async dispatchSdkEvent(context: OpenCodeSessionContext, event: SdkEvent): Promise<void> {
    const turnId = context.activeTurnId
    switch (event.type) {
      case 'message.updated': {
        const info = event.properties.info as { id?: string; role?: 'user' | 'assistant' }
        if (info.id && info.role) context.messageRoleById.set(info.id, info.role)
        if (info.role === 'assistant') {
          for (const part of context.partById.values()) {
            if (part.messageID !== info.id) continue
            await this.emitAssistantTextDelta(
              context,
              part,
              this.resolveTurnIdForPart(context, part.id, turnId),
              event
            )
          }
        }
        break
      }
      case 'message.removed': {
        const messageID = event.properties.messageID as string
        context.messageRoleById.delete(messageID)
        break
      }
      case 'message.part.delta': {
        const partID = event.properties.partID as string
        const existingPart = context.partById.get(partID)
        if (!existingPart) break
        if (messageRoleForPart(context, existingPart) !== 'assistant') break
        const partTurnId = this.resolveTurnIdForPart(context, partID, turnId)
        const streamKind = resolveTextStreamKind(existingPart)
        const delta = (event.properties.delta as string) ?? ''
        if (!delta) break
        const previousText =
          context.emittedTextByPartId.get(partID) ?? textFromPart(existingPart) ?? ''
        const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta)
        if (!deltaToEmit) break
        context.emittedTextByPartId.set(partID, nextText)
        if (existingPart.type === 'text' || existingPart.type === 'reasoning') {
          context.partById.set(partID, { ...existingPart, text: nextText })
        }
        this.emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: partTurnId,
            itemId: partID,
            raw: event
          }),
          type: 'content.delta',
          payload: { streamKind, delta: deltaToEmit }
        })
        break
      }
      case 'message.part.updated': {
        const part = event.properties.part as Part
        context.partById.set(part.id, part)
        const partTurnId = this.resolveTurnIdForPart(context, part.id, turnId)
        const messageRole = messageRoleForPart(context, part)
        if (messageRole === 'assistant') {
          await this.emitAssistantTextDelta(context, part, partTurnId, event)
        }
        if (part.type === 'tool') {
          const todoItems = todoItemsFromOpenCodeToolPart(part)
          if (todoItems.length > 0) {
            this.emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId: partTurnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event
              }),
              type: 'todo.updated',
              payload: {
                source: 'todo',
                title: 'Todos',
                items: todoItems
              }
            })
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
          const payload = {
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
          this.emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: partTurnId,
              itemId: part.callID,
              createdAt: toolStateCreatedAt(part),
              raw: event
            }),
            type: evType,
            payload
          })
        }
        break
      }
      case 'permission.asked': {
        const id = event.properties.id as string
        context.pendingPermissions.set(id, event.properties as unknown as PermissionRequest)
        const patterns = Array.isArray(event.properties.patterns)
          ? (event.properties.patterns as string[])
          : []
        const requestType = mapPermissionToRequestType(event.properties.permission as string)
        const permissionFileEdit =
          requestType === 'file_change_approval'
            ? fileEditChangesFromOpenCodeMetadata(event.properties.metadata, patterns)
            : undefined
        this.emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: id,
            raw: event
          }),
          type: 'request.opened',
          payload: {
            requestType,
            detail:
              Array.isArray(event.properties.patterns) && event.properties.patterns.length > 0
                ? (event.properties.patterns as string[]).join('\n')
                : String(event.properties.permission ?? ''),
            args: event.properties.metadata,
            ...(permissionFileEdit ? { fileEditChanges: permissionFileEdit } : {})
          }
        })
        break
      }
      case 'permission.replied': {
        const requestID = event.properties.requestID as string
        context.pendingPermissions.delete(requestID)
        this.emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: requestID,
            raw: event
          }),
          type: 'request.resolved',
          payload: {
            requestType: 'unknown',
            decision: mapPermissionDecision(event.properties.reply as 'once' | 'always' | 'reject')
          }
        })
        break
      }
      case 'question.asked': {
        const id = event.properties.id as string
        context.pendingQuestions.set(id, event.properties as unknown as QuestionRequest)
        this.emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: id,
            raw: event
          }),
          type: 'user-input.requested',
          payload: { questions: normalizeQuestionRequest(event.properties as unknown as QuestionRequest) }
        })
        break
      }
      case 'question.replied': {
        const requestID = event.properties.requestID as string
        const request = context.pendingQuestions.get(requestID)
        context.pendingQuestions.delete(requestID)
        const fromSdk = event.properties.answers as string[][] | undefined
        const answers = Object.fromEntries(
          (request?.questions ?? []).map((question, index) => [
            openCodeQuestionId(index, question),
            fromSdk?.[index]?.join(', ') ?? ''
          ])
        )
        this.emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: requestID,
            raw: event
          }),
          type: 'user-input.resolved',
          payload: { answers }
        })
        break
      }
      case 'question.rejected': {
        const requestID = event.properties.requestID as string
        context.pendingQuestions.delete(requestID)
        this.emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: requestID,
            raw: event
          }),
          type: 'user-input.resolved',
          payload: { answers: {} }
        })
        break
      }
      case 'session.status': {
        const status = event.properties.status as { type?: string; message?: string }
        if (status.type === 'busy') {
          context.session = { ...context.session, status: 'running', activeTurnId: turnId, updatedAt: nowIso() }
        }
        if (status.type === 'retry') {
          this.emit({
            ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
            type: 'runtime.warning',
            payload: { message: status.message ?? 'Retry', detail: status }
          })
          break
        }
        if (status.type === 'idle' && turnId) {
          context.activeTurnId = undefined
          context.session = {
            ...context.session,
            status: 'ready',
            updatedAt: nowIso()
          }
          this.emit({
            ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
            type: 'turn.completed',
            payload: { state: 'completed' }
          })
        }
        break
      }
      case 'session.diff': {
        const diff = event.properties.diff
        const fileEditChanges = fileEditChangesFromSessionDiff(diff)
        if (fileEditChanges && fileEditChanges.length > 0) {
          const title =
            fileEditChanges.length === 1
              ? basenamePath(fileEditChanges[0].path)
              : 'file changes'
          this.emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: 'opencode:session-diff',
              raw: event
            }),
            type: 'item.completed',
            payload: {
              itemType: 'file_change',
              status: 'completed',
              title,
              fileEditChanges
            }
          })
        }
        break
      }
      case 'session.error': {
        const message = sessionErrorMessage(event.properties.error)
        const activeTurn = context.activeTurnId
        context.activeTurnId = undefined
        this.emit({
          ...buildEventBase({ threadId: context.session.threadId, turnId: activeTurn, raw: event }),
          type: 'runtime.error',
          payload: { message, detail: event.properties.error }
        })
        if (activeTurn) {
          this.emit({
            ...buildEventBase({ threadId: context.session.threadId, turnId: activeTurn, raw: event }),
            type: 'turn.completed',
            payload: { state: 'failed', errorMessage: message }
          })
        }
        break
      }
      default:
        break
    }
  }

  private async emitAssistantTextDelta(
    context: OpenCodeSessionContext,
    part: Part,
    turnId: string | undefined,
    raw: unknown
  ): Promise<void> {
    const text = textFromPart(part)
    if (text === undefined) return
    const previousText = context.emittedTextByPartId.get(part.id)
    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text)
    context.emittedTextByPartId.set(part.id, latestText)
    if (latestText !== text && (part.type === 'text' || part.type === 'reasoning')) {
      context.partById.set(part.id, { ...part, text: latestText })
    }
    if (deltaToEmit.length > 0) {
      this.emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt:
            part.type === 'text' || part.type === 'reasoning'
              ? isoFromEpochMs(part.time?.start)
              : undefined,
          raw
        }),
        type: 'content.delta',
        payload: {
          streamKind: resolveTextStreamKind(part),
          delta: deltaToEmit
        }
      })
    }
    if (
      part.type === 'text' &&
      part.time?.end !== undefined &&
      !context.completedAssistantPartIds.has(part.id)
    ) {
      context.completedAssistantPartIds.add(part.id)
      this.emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt: isoFromEpochMs(part.time.end),
          raw
        }),
        type: 'item.completed',
        payload: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          ...(latestText.length > 0 ? { detail: latestText } : {})
        }
      })
    }
  }

  private resolveTurnIdForPart(
    context: OpenCodeSessionContext,
    partId: string,
    currentTurnId: string | undefined
  ): string | undefined {
    if (currentTurnId) {
      context.partTurnIdById.set(partId, currentTurnId)
      return currentTurnId
    }
    return context.partTurnIdById.get(partId)
  }
}

async function stopOpenCodeContext(context: OpenCodeSessionContext): Promise<void> {
  context.stopped = true
  context.eventsAbortController.abort()
  try {
    await context.client.session.abort({ sessionID: context.openCodeSessionId }).catch(() => undefined)
  } catch {
    // ignore
  }
  context.server.close()
}

function resolveBinarySafe(binaryPath: string): string | null {
  try {
    return resolveOpenCodeBinaryPath(binaryPath)
  } catch {
    return null
  }
}

function formatProbeFailure(message: string, serverUrl: string): string {
  if (!serverUrl) return message
  if (message.includes(serverUrl)) return message
  return `${message} (remote server: ${serverUrl})`
}

function resolveComposerAttachment(attachment: ChatAttachment): string | null {
  try {
    if (attachment.url.startsWith('file:')) {
      return fileURLToPath(attachment.url)
    }
  } catch {
    return null
  }
  return null
}

function readTracePayloadString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

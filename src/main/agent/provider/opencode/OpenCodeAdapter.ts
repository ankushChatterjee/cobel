import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  ChatAttachment,
  ModelInfo,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSummary,
  ReasoningEffort
} from '../../../../shared/agent'
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
import type { ProviderLifecycleCapabilities } from '../types'
import {
  buildOpenCodePermissionRules,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  inventoryToModelInfos,
  loadOpenCodeInventory,
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
import { dumpOpenCodeRawMessage } from './openCodeRawMessageDump'
import {
  OpenCodeSessionFsm,
  fileEditChangesFromOpenCodeToolPart,
  todoItemsFromOpenCodeToolPart,
  toolLifecycleTitle
} from './OpenCodeSessionFsm'

export { fileEditChangesFromOpenCodeToolPart, todoItemsFromOpenCodeToolPart, toolLifecycleTitle }

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
  readonly fsm: OpenCodeSessionFsm
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
            source: 'opencode.sdk' as const,
            payload: input.raw
          }
        }
      : {})
  }
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
  readonly lifecycleCapabilities: ProviderLifecycleCapabilities = {
    completesOnReadySession: true,
    closesOnApprovalDecline: false,
    promotesRuntimeErrorsToTurnFailure: 'fatal-only'
  }
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
      alive.fsm.setInteractionMode(input.interactionMode)
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
        directory,
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

    const fsm = new OpenCodeSessionFsm(input.threadId, openCodeSessionId)
    fsm.setInteractionMode(input.interactionMode)

    const context: OpenCodeSessionContext = {
      session,
      client,
      server,
      directory,
      openCodeSessionId,
      variantByEffort,
      fsm,
      stopped: false,
      eventsAbortController: new AbortController()
    }
    const race = this.sessions.get(input.threadId)
    if (race && !race.stopped) {
      if (race.openCodeSessionId !== openCodeSessionId) {
        await client.session.abort({ sessionID: openCodeSessionId, directory }).catch(() => undefined)
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
      throw new Error(
        "OpenCode requires model id in the form 'upstream/model-id' (e.g. anthropic/claude-sonnet-4-20250514)."
      )
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

    // Update FSM interaction mode in case it changed
    ctx.fsm.setInteractionMode(input.interactionMode ?? ctx.session.interactionMode ?? 'default')

    // Reset FSM if previous turn ended in a terminal phase
    ctx.fsm.resetForNewTurn()

    // B4: beginTurn may queue the turnId if we're in awaiting_idle
    const beginEffects = ctx.fsm.beginTurn(turnId, { model: modelSlug || input.model, effort: resolvedEffort })
    for (const e of beginEffects) this.emit(e)

    // If beginTurn emitted a turn.started, the SDK call is in-progress from now
    // If it queued, we still need to send to OpenCode (it will process after the current turn)
    try {
      await ctx.client.session.promptAsync({
        sessionID: ctx.openCodeSessionId,
        directory: ctx.directory,
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        parts: [...(text ? [{ type: 'text' as const, text }] : []), ...fileParts]
      })
    } catch (e) {
      // If we queued this turn but promptAsync failed, unqueue it
      ctx.fsm.resetForNewTurn()
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
        directory,
        title: 'title-gen',
        permission: buildOpenCodePermissionRules('approval-required')
      })
      const sid = (titleSession.data as { id?: string })?.id
      if (!sid) return null
      const prompt = buildThreadTitlePrompt(input.input)
      const result = await client.session.prompt({
        sessionID: sid,
        directory,
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
      await client.session.delete({ sessionID: sid, directory }).catch(() => undefined)
      const structured = (result.data?.info as { structured?: unknown })?.structured
      if (
        structured &&
        typeof structured === 'object' &&
        structured !== null &&
        typeof (structured as Record<string, unknown>).title === 'string'
      ) {
        return parseThreadTitleResponse(JSON.stringify(structured))
      }
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
    await ctx.client.session
      .abort({ sessionID: ctx.openCodeSessionId, directory: ctx.directory })
      .catch(() => undefined)
    const tid = input.turnId ?? ctx.fsm.activeTurnId
    const effects = ctx.fsm.doInterrupt(tid)
    for (const e of effects) this.emit(e)
  }

  async rollbackConversation(input: { threadId: string; numTurns: number }): Promise<void> {
    const ctx = this.requireSession(input.threadId)
    const messages = await ctx.client.session.messages({
      sessionID: ctx.openCodeSessionId,
      directory: ctx.directory
    })
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
    const perm = ctx.fsm.pendingPermissions.get(input.requestId)
    if (!perm) {
      if (ctx.fsm.hasPermissionRequest(input.requestId)) return
      this.emit({
        ...buildEventBase({ threadId: input.threadId, requestId: input.requestId }),
        type: 'request.resolved',
        payload: {
          requestType: 'unknown',
          decision: 'cancel',
          resolution: { reason: 'stale_after_restart' }
        }
      })
      return
    }
    const { effects, shouldReplyToSdk } = ctx.fsm.replyToPermission(
      input.requestId,
      input.decision,
      undefined
    )
    for (const e of effects) this.emit(e)
    if (!shouldReplyToSdk) return
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
    const request = ctx.fsm.pendingQuestions.get(input.requestId)
    if (!request) {
      if (ctx.fsm.hasQuestionRequest(input.requestId)) return
      this.emit({
        ...buildEventBase({ threadId: input.threadId, requestId: input.requestId }),
        type: 'user-input.resolved',
        payload: { answers: input.answers }
      })
      return
    }
    const answers = toOpenCodeQuestionAnswers(request, input.answers)
    // B8: Optimistic local resolution — close even if SDK reply or echo is delayed.
    const effects = ctx.fsm.replyToQuestion(input.requestId, input.answers, request, undefined)
    for (const e of effects) this.emit(e)
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
    return ctx.client.session.messages({ sessionID: ctx.openCodeSessionId, directory: ctx.directory })
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
      title:
        event.type === 'content.delta'
          ? null
          : (readTracePayloadString(event.payload, 'title') ?? null),
      detail:
        event.type === 'content.delta'
          ? null
          : (readTracePayloadString(event.payload, 'detail') ?? null),
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
        const subscription = await context.client.event.subscribe(
          { directory: context.directory },
          { signal: context.eventsAbortController.signal }
        )
        for await (const rawEvent of subscription.stream) {
          dumpOpenCodeRawMessage(rawEvent, {
            threadId: context.session.threadId,
            source: 'sdk.subscribe'
          })
          const event = rawEvent as SdkEvent
          if (context.stopped) break
          if (!context.fsm.eventBelongsToContext(event)) continue
          const effects = context.fsm.dispatch(event)
          for (const e of effects) this.emit(e)
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
    const turnId = context.fsm.activeTurnId
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
}

async function stopOpenCodeContext(context: OpenCodeSessionContext): Promise<void> {
  context.stopped = true
  context.eventsAbortController.abort()
  try {
    await context.client.session
      .abort({ sessionID: context.openCodeSessionId, directory: context.directory })
      .catch(() => undefined)
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
  if (attachment.type !== 'image') return null
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

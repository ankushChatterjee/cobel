import type {
  CanonicalItemType,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  ReasoningEffort,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
  RuntimeContentStreamKind,
  RuntimeSessionState
} from '../../../shared/agent'
import { mergeFileEditChanges, readCanonicalFileEditChanges } from '../../../shared/fileEditChanges'
import { OrchestrationEngine } from './OrchestrationEngine'

const MAX_BUFFERED_ASSISTANT_CHARS = 24_000
const MAX_BUFFERED_REASONING_TEXT_CHARS = 16_000

interface AssistantSegmentState {
  baseKey: string
  nextSegmentIndex: number
  activeMessageId: string | null
  buffer: string
}

interface PlanBufferState {
  text: string
  createdAt: string
}

function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return (
    value === undefined ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max' ||
    value === 'xhigh'
  )
}

export class ProviderRuntimeIngestion {
  private readonly queue: ProviderRuntimeEvent[] = []
  private readonly assistantSegments = new Map<string, AssistantSegmentState>()
  private readonly streamedAssistantItems = new Set<string>()
  private readonly planBuffers = new Map<string, PlanBufferState>()
  private readonly completedTurns = new Map<string, 'completed' | 'failed'>()
  private draining = false
  private drainPromise: Promise<void> = Promise.resolve()

  constructor(private readonly engine: OrchestrationEngine) {}

  enqueue(event: ProviderRuntimeEvent): void {
    logEvent('runtime/enqueue', event)
    this.queue.push(event)
    if (!this.draining) {
      this.drainPromise = this.drainInternal()
    }
  }

  async drain(): Promise<void> {
    await this.drainPromise
  }

  private async drainInternal(): Promise<void> {
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()
        if (event) this.ingest(event)
      }
    } finally {
      this.draining = false
    }
  }

  private ingest(event: ProviderRuntimeEvent): void {
    logEvent('runtime/ingest', event)
    this.engine.ensureThread({ threadId: event.threadId })

    switch (event.type) {
      case 'session.state.changed':
        this.closeTurnForTerminalSession(event)
        this.engine.setSession({
          threadId: event.threadId,
          status: mapSessionStatus(event.payload.state),
          providerName: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          interactionMode:
            this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
          effort: this.engine.getThread(event.threadId).session?.effort,
          activeTurnId:
            event.payload.state === 'running'
              ? (event.turnId ??
                this.engine.getThread(event.threadId).session?.activeTurnId ??
                null)
              : null,
          activePlanId:
            event.payload.state === 'running'
              ? (this.engine.getThread(event.threadId).session?.activePlanId ?? null)
              : null,
          lastError:
            event.payload.state === 'error' ? (event.payload.reason ?? 'Provider error') : null,
          createdAt: event.createdAt
        })
        return

      case 'turn.started':
        const currentEffort = this.engine.getThread(event.threadId).session?.effort
        const nextEffort = isReasoningEffort(event.payload.effort)
          ? event.payload.effort
          : currentEffort
        this.engine.setLatestTurn(event.threadId, {
          id: event.turnId ?? event.eventId,
          status: 'running',
          startedAt: event.createdAt,
          completedAt: null
        })
        this.engine.setSession({
          threadId: event.threadId,
          status: 'running',
          providerName: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          interactionMode:
            this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
          effort: nextEffort,
          activeTurnId: event.turnId ?? null,
          activePlanId: this.engine.getThread(event.threadId).session?.activePlanId ?? null,
          lastError: null,
          createdAt: event.createdAt
        })
        return

      case 'turn.completed':
        this.flushAssistant(event, { closeSegment: true })
        this.finalizePlan(event)
        this.closeActiveTurn(event)
        return

      case 'content.delta':
        this.ingestContentDelta(event)
        return

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.ingestItem(event)
        if (event.type === 'item.completed' && event.payload.itemType !== 'reasoning')
          this.flushAssistant(event, { closeSegment: true })
        return

      case 'request.opened':
        this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
        this.flushAssistant(event, { closeSegment: true })
        {
          const approvalFileEdit = readCanonicalFileEditChanges(event.payload)
          this.engine.upsertActivity(
            {
              id: `approval:${event.requestId ?? event.eventId}`,
              kind: 'approval.requested',
              tone: 'approval',
              summary: event.payload.detail ?? titleForRequest(event.payload.requestType),
              payload: {
                requestType: event.payload.requestType,
                args: event.payload.args,
                ...(approvalFileEdit.length > 0 ? { fileEditChanges: approvalFileEdit } : {})
              },
              turnId: event.turnId ?? null,
              resolved: false,
              createdAt: event.createdAt
            },
            event.threadId
          )
        }
        this.engine.setSession({
          threadId: event.threadId,
          status: 'ready',
          providerName: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          interactionMode:
            this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
          effort: this.engine.getThread(event.threadId).session?.effort,
          activeTurnId: event.turnId ?? null,
          activePlanId: this.engine.getThread(event.threadId).session?.activePlanId ?? null,
          lastError: null,
          createdAt: event.createdAt
        })
        return

      case 'request.resolved':
        {
          const existing = this.findApprovalForResolution(event)
          const id = existing?.id ?? `approval:${event.requestId ?? event.eventId}`
          this.engine.upsertActivity(
            {
              id,
              kind: 'approval.resolved',
              tone: 'info',
              summary: existing?.summary ?? `Approval ${event.payload.decision ?? 'resolved'}`,
              payload: {
                ...existing?.payload,
                requestType:
                  event.payload.requestType && event.payload.requestType !== 'unknown'
                    ? event.payload.requestType
                    : (readPayloadString(existing?.payload, 'requestType') ??
                      event.payload.requestType),
                decision: event.payload.decision,
                resolution: event.payload.resolution
              },
              turnId: event.turnId ?? existing?.turnId ?? null,
              resolved: true,
              createdAt: event.createdAt
            },
            event.threadId
          )
        }
        return

      case 'user-input.requested':
        this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
        this.flushAssistant(event, { closeSegment: true })
        this.engine.upsertActivity(
          {
            id: `user-input:${event.requestId ?? event.eventId}`,
            kind: 'user-input.requested',
            tone: 'approval',
            summary: event.payload.questions[0]?.question ?? 'Codex needs input',
            payload: { questions: event.payload.questions },
            turnId: event.turnId ?? null,
            resolved: false,
            createdAt: event.createdAt
          },
          event.threadId
        )
        return

      case 'user-input.resolved':
        this.engine.upsertActivity(
          {
            id: `user-input:${event.requestId ?? event.eventId}`,
            kind: 'user-input.resolved',
            tone: 'info',
            summary: 'User input submitted',
            payload: { answers: event.payload.answers },
            turnId: event.turnId ?? null,
            resolved: true,
            createdAt: event.createdAt
          },
          event.threadId
        )
        return

      case 'runtime.error':
      case 'runtime.warning':
        this.engine.upsertActivity(
          {
            id: `${event.type}:${event.eventId}`,
            kind: event.type === 'runtime.error' ? 'runtime.error' : 'runtime.warning',
            tone: event.type === 'runtime.error' ? 'error' : 'info',
            summary: event.payload.message,
            payload: { detail: event.payload.detail },
            turnId: event.turnId ?? null,
            createdAt: event.createdAt
          },
          event.threadId
        )
        if (event.type === 'runtime.error' && this.shouldPromoteRuntimeError(event)) {
          this.engine.setSession({
            threadId: event.threadId,
            status: 'error',
            providerName: event.provider,
            runtimeMode:
              this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
            interactionMode:
              this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
            effort: this.engine.getThread(event.threadId).session?.effort,
            activeTurnId: null,
            activePlanId: null,
            lastError: event.payload.message,
            createdAt: event.createdAt
          })
        }
        return

      case 'thread.started':
        return
    }
  }

  private shouldPromoteRuntimeError(event: ProviderRuntimeEvent): boolean {
    if (!event.turnId) return true
    const activeTurnId = this.engine.getThread(event.threadId).session?.activeTurnId
    return activeTurnId === event.turnId
  }

  private ingestContentDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const streamKind = event.payload.streamKind
    if (streamKind === 'assistant_text' || streamKind === 'plan_text' || isToolOutput(streamKind)) {
      this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
    }

    if (event.payload.streamKind === 'assistant_text') {
      const key = this.assistantStateKey(event)
      const isFinalSnapshot = this.isFinalAssistantItemSnapshot(event)
      if (isFinalSnapshot) {
        if (this.streamedAssistantItems.has(key)) {
          this.flushAssistant(event, { closeSegment: true, streaming: false })
          return
        }
      } else {
        this.streamedAssistantItems.add(key)
      }
      const state = this.getAssistantState(event)
      state.buffer += event.payload.delta
      this.flushAssistant(event, {
        closeSegment: isFinalSnapshot,
        streaming: !isFinalSnapshot
      })
      if (state.buffer.length >= MAX_BUFFERED_ASSISTANT_CHARS)
        this.flushAssistant(event, { closeSegment: true, streaming: true })
      return
    }

    if (event.payload.streamKind === 'plan_text') {
      const key = this.planKey(event.threadId, event.turnId ?? event.eventId)
      const existing = this.planBuffers.get(key)
      if (existing) {
        existing.text += event.payload.delta
      } else {
        this.planBuffers.set(key, { text: event.payload.delta, createdAt: event.createdAt })
      }
      return
    }

    if (event.payload.streamKind === 'reasoning_text') {
      this.appendReasoningTextDelta(event)
      return
    }

    if (isToolOutput(event.payload.streamKind)) {
      this.appendToolOutput(event)
    }
  }

  private ingestItem(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    if (event.payload.itemType === 'user_message') return
    if (event.payload.itemType === 'reasoning') {
      this.ingestThinking(event)
      return
    }
    this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
    if (event.payload.itemType === 'assistant_message') {
      this.ingestAssistantItem(event)
      return
    }
    if (event.payload.itemType === 'plan') {
      this.ingestPlanItem(event)
      return
    }

    const id = toolActivityId(event)
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    const existingStatus = readPayloadString(existing?.payload, 'status')
    const completedTurnStatus = this.completedTurnToolStatus(event)
    const nextStatus = nextToolStatus(existingStatus, completedTurnStatus ?? event.payload.status)
    const kind =
      existing?.kind === 'tool.completed' || isTerminalToolStatus(nextStatus)
        ? 'tool.completed'
        : event.type === 'item.started'
          ? 'tool.started'
          : 'tool.updated'
    const mergedFileEdit = mergeFileEditChanges(
      (() => {
        const inc = readCanonicalFileEditChanges(event.payload)
        return inc.length > 0 ? inc : undefined
      })(),
      (() => {
        const prev = readCanonicalFileEditChanges(existing?.payload)
        return prev.length > 0 ? prev : undefined
      })()
    )
    const toolPayload: Record<string, unknown> = {
      ...existing?.payload,
      itemType: event.payload.itemType ?? readPayloadString(existing?.payload, 'itemType'),
      status: nextStatus,
      title: event.payload.title ?? readPayloadString(existing?.payload, 'title'),
      detail: event.payload.detail ?? readPayloadString(existing?.payload, 'detail'),
      data: event.payload.data ?? existing?.payload?.data
    }
    if (mergedFileEdit && mergedFileEdit.length > 0) {
      toolPayload.fileEditChanges = mergedFileEdit
    }
    this.engine.upsertActivity(
      {
        id,
        kind,
        tone: toneForItem(event.payload.itemType),
        summary:
          event.payload.title ??
          existing?.summary ??
          event.payload.detail ??
          titleForItem(event.payload.itemType),
        payload: toolPayload,
        turnId: event.turnId ?? null,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private ingestPlanItem(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    if (event.type !== 'item.completed') return
    const text = normalizeProposedPlanText(
      readNestedPayloadString(event.payload.data, 'item', 'text') ??
        readNestedPayloadString(event.payload.data, 'text')
    )
    if (!text) return
    this.finalizePlan(event, text)
  }

  private ingestAssistantItem(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    const text = readNestedPayloadString(
      event.payload.data,
      'text',
      'content',
      'message',
      'markdown'
    )
    if (!text) return
    const state = this.getAssistantState(event)
    state.buffer += text
    this.flushAssistant(event, {
      closeSegment: true,
      streaming: event.type !== 'item.completed'
    })
  }

  private ingestThinking(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    const id = `thinking:${event.itemId ?? event.turnId ?? event.eventId}`
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    const existingStatus = readPayloadString(existing?.payload, 'status')
    const preservedReasoningText = readPayloadString(existing?.payload, 'reasoningText')
    const completed =
      existing?.resolved === true ||
      isTerminalToolStatus(existingStatus) ||
      this.completedTurnToolStatus(event) !== undefined ||
      event.type === 'item.completed' ||
      event.payload.status === 'completed'
    this.engine.upsertActivity(
      {
        id,
        kind: completed
          ? 'task.completed'
          : event.type === 'item.started'
            ? 'task.started'
            : 'task.progress',
        tone: 'thinking',
        summary: 'Thinking',
        payload: {
          itemType: event.payload.itemType,
          status: completed ? 'completed' : (event.payload.status ?? 'inProgress'),
          data: event.payload.data,
          ...(preservedReasoningText !== undefined ? { reasoningText: preservedReasoningText } : {})
        },
        turnId: event.turnId ?? null,
        resolved: completed,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  /**
   * Stops the reasoning "spinner" in the UI once another stream (assistant, plan, tool output)
   * or non-reasoning item begins for the same turn, even if the reasoning item has not completed yet.
   */
  private resolveReasoningThinkingForTurn(
    threadId: string,
    turnId: string | null | undefined,
    createdAt: string
  ): void {
    const thread = this.engine.getThread(threadId)
    const effectiveTurnId = turnId ?? thread.session?.activeTurnId ?? null
    if (!effectiveTurnId) return

    for (const activity of thread.activities) {
      if (activity.turnId !== effectiveTurnId) continue
      if (!activity.id.startsWith('thinking:')) continue
      if (activity.resolved === true) continue
      if (readPayloadString(activity.payload, 'itemType') !== 'reasoning') continue

      const basePayload =
        typeof activity.payload === 'object' && activity.payload !== null
          ? { ...(activity.payload as Record<string, unknown>) }
          : {}

      this.engine.upsertActivity(
        {
          ...activity,
          kind: 'task.completed',
          resolved: true,
          payload: {
            ...basePayload,
            itemType: 'reasoning',
            status: 'completed'
          },
          createdAt
        },
        threadId
      )
    }
  }

  private appendReasoningTextDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const id = `thinking:${event.itemId ?? event.turnId ?? event.eventId}`
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    if (existing?.resolved === true) return

    const prevText = readPayloadString(existing?.payload, 'reasoningText') ?? ''
    const merged = `${prevText}${event.payload.delta}`
    const nextText =
      merged.length > MAX_BUFFERED_REASONING_TEXT_CHARS
        ? merged.slice(merged.length - MAX_BUFFERED_REASONING_TEXT_CHARS)
        : merged

    const existingKind = existing?.kind
    const nextKind: OrchestrationThreadActivity['kind'] =
      existingKind === 'task.started' || existingKind === 'task.progress'
        ? 'task.progress'
        : 'task.started'

    const itemType = readPayloadString(existing?.payload, 'itemType') ?? 'reasoning'
    const status = readPayloadString(existing?.payload, 'status') ?? 'inProgress'
    const basePayload =
      typeof existing?.payload === 'object' && existing.payload !== null
        ? (existing.payload as Record<string, unknown>)
        : {}

    this.engine.upsertActivity(
      {
        id,
        kind: nextKind,
        tone: 'thinking',
        summary: 'Thinking',
        payload: {
          ...basePayload,
          itemType,
          status,
          reasoningText: nextText
        },
        turnId: event.turnId ?? existing?.turnId ?? null,
        resolved: false,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private appendToolOutput(event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>): void {
    const id = toolActivityId(event)
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    const output = `${readPayloadString(existing?.payload, 'output') ?? ''}${event.payload.delta}`
    const existingStatus = readPayloadString(existing?.payload, 'status')
    const completedTurnStatus = this.completedTurnToolStatus(event)
    const completed =
      completedTurnStatus === 'completed' ||
      existing?.kind === 'tool.completed' ||
      existingStatus === 'completed' ||
      existingStatus === 'success'
    const terminal = completed || completedTurnStatus === 'failed'
    this.engine.upsertActivity(
      {
        id,
        kind: terminal ? 'tool.completed' : 'tool.updated',
        tone: 'tool',
        summary: existing?.summary ?? 'Tool output',
        payload: {
          ...existing?.payload,
          itemType: readPayloadString(existing?.payload, 'itemType') ?? 'unknown',
          status: completed
            ? 'completed'
            : (completedTurnStatus ?? existing?.payload?.status ?? 'inProgress'),
          output,
          streamKind: event.payload.streamKind
        },
        turnId: event.turnId ?? existing?.turnId ?? null,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private assistantStateKey(event: ProviderRuntimeEvent): string {
    return `${event.threadId}:${event.itemId ?? event.turnId ?? event.eventId}`
  }

  private isFinalAssistantItemSnapshot(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): boolean {
    return event.raw?.method === 'item/completed'
  }

  private getAssistantState(event: ProviderRuntimeEvent): AssistantSegmentState {
    const key = this.assistantStateKey(event)
    const existing = this.assistantSegments.get(key)
    if (existing) return existing

    const state: AssistantSegmentState = {
      baseKey: String(event.itemId ?? event.turnId ?? event.eventId),
      nextSegmentIndex: 0,
      activeMessageId: null,
      buffer: ''
    }
    this.assistantSegments.set(key, state)
    return state
  }

  private flushAssistant(
    event: ProviderRuntimeEvent,
    options: { closeSegment: boolean; streaming?: boolean } = { closeSegment: true }
  ): void {
    for (const [key, state] of this.assistantSegments) {
      if (!key.startsWith(`${event.threadId}:`)) continue
      if (state.buffer.length === 0) {
        if (options.closeSegment && state.activeMessageId) {
          this.closeAssistantMessage(event, state.activeMessageId, options.streaming)
          state.activeMessageId = null
          state.nextSegmentIndex += 1
        }
        continue
      }
      const messageId =
        state.activeMessageId ?? assistantSegmentMessageId(state.baseKey, state.nextSegmentIndex)
      const existing = this.engine
        .getThread(event.threadId)
        .messages.find((message) => message.id === messageId)
      const now = event.createdAt
      const message: OrchestrationMessage = {
        id: messageId,
        role: 'assistant',
        text: `${existing?.text ?? ''}${state.buffer}`,
        turnId: event.turnId ?? existing?.turnId ?? null,
        streaming: options.streaming ?? event.type !== 'turn.completed',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      this.engine.upsertMessage(message, event.threadId)
      state.buffer = ''
      state.activeMessageId = messageId
      if (options.closeSegment) {
        state.activeMessageId = null
        state.nextSegmentIndex += 1
      }
    }
  }

  private closeAssistantMessage(
    event: ProviderRuntimeEvent,
    messageId: string,
    streaming = event.type !== 'turn.completed'
  ): void {
    const existing = this.engine
      .getThread(event.threadId)
      .messages.find((message) => message.id === messageId)
    if (!existing || !existing.streaming) return
    this.engine.upsertMessage(
      {
        ...existing,
        streaming,
        updatedAt: event.createdAt
      },
      event.threadId
    )
  }

  private finalizePlan(event: ProviderRuntimeEvent, fallbackText?: string): void {
    const turnId = event.turnId ?? event.eventId
    const key = this.planKey(event.threadId, turnId)
    const buffer = this.planBuffers.get(key)
    const text = normalizeProposedPlanText(buffer?.text) ?? normalizeProposedPlanText(fallbackText)
    if (!text) return
    const thread = this.engine.getThread(event.threadId)
    const existingPlanId = thread.session?.activePlanId
    const existingPlan = existingPlanId
      ? thread.proposedPlans.find((plan) => plan.id === existingPlanId) ?? null
      : null
    const proposedPlan: OrchestrationProposedPlan = {
      id: existingPlan?.id ?? `plan:${event.threadId}:turn:${turnId}`,
      turnId,
      text,
      status: 'proposed',
      createdAt: existingPlan?.createdAt ?? buffer?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt
    }
    this.engine.upsertProposedPlan(proposedPlan, event.threadId)
    this.planBuffers.delete(key)
  }

  private closeActiveTurn(event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>): void {
    const thread = this.engine.getThread(event.threadId)
    const activeTurnId = thread.session?.activeTurnId

    this.completedTurns.set(
      this.turnCompletionKey(event.threadId, event.turnId ?? event.eventId),
      toolStatusForTurnCompletion(event.payload.state)
    )
    this.finalizeActivitiesForTurn(event)
    if (activeTurnId && event.turnId && activeTurnId !== event.turnId) return

    this.engine.setLatestTurn(event.threadId, {
      id: event.turnId ?? event.eventId,
      status: event.payload.state,
      startedAt: thread.latestTurn?.startedAt ?? event.createdAt,
      completedAt: event.createdAt
    })
    this.engine.setSession({
      threadId: event.threadId,
      status:
        event.payload.state === 'completed'
          ? 'ready'
          : event.payload.state === 'interrupted'
            ? 'interrupted'
            : 'error',
      providerName: event.provider,
      runtimeMode: thread.session?.runtimeMode ?? 'auto-accept-edits',
      interactionMode: thread.session?.interactionMode ?? 'default',
      effort: thread.session?.effort,
      activeTurnId: null,
      activePlanId: null,
      lastError: event.payload.errorMessage ?? null,
      createdAt: event.createdAt
    })
  }

  private closeTurnForTerminalSession(
    event: Extract<ProviderRuntimeEvent, { type: 'session.state.changed' }>
  ): void {
    if (event.payload.state !== 'stopped' && event.payload.state !== 'error') return
    const thread = this.engine.getThread(event.threadId)
    const activeTurnId =
      thread.session?.activeTurnId ??
      (thread.latestTurn?.status === 'running' ? thread.latestTurn.id : null)
    if (!activeTurnId) return

    const state = event.payload.state === 'error' ? 'failed' : 'interrupted'
    const cleanupEvent: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> = {
      ...event,
      type: 'turn.completed',
      turnId: activeTurnId,
      payload: {
        state,
        errorMessage: event.payload.reason
      }
    }
    this.completedTurns.set(
      this.turnCompletionKey(event.threadId, activeTurnId),
      toolStatusForTurnCompletion(state)
    )
    this.finalizeActivitiesForTurn(cleanupEvent)
    this.engine.setLatestTurn(event.threadId, {
      id: activeTurnId,
      status: state,
      startedAt: thread.latestTurn?.startedAt ?? event.createdAt,
      completedAt: event.createdAt
    })
  }

  private finalizeActivitiesForTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    this.resolvePendingThinkingForTurn(event)
    this.resolvePendingToolsForTurn(event)
    this.resolvePendingPromptsForTurn(event)
  }

  private resolvePendingThinkingForTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    const thread = this.engine.getThread(event.threadId)
    for (const activity of thread.activities) {
      if (activity.resolved) continue
      if (activity.tone !== 'thinking') continue
      if (!activityBelongsToTurn(activity, event.turnId)) continue
      this.engine.upsertActivity(
        {
          ...activity,
          kind: 'task.completed',
          resolved: true,
          payload: { ...activity.payload, status: 'completed' },
          createdAt: activity.createdAt
        },
        event.threadId
      )
    }
  }

  private resolvePendingToolsForTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    const thread = this.engine.getThread(event.threadId)
    const nextStatus = toolStatusForTurnCompletion(event.payload.state)
    for (const activity of thread.activities) {
      if (!activity.kind.startsWith('tool.')) continue
      if (!activityBelongsToTurn(activity, event.turnId)) continue
      const currentStatus = readPayloadString(activity.payload, 'status')
      if (activity.kind === 'tool.completed' && isTerminalToolStatus(currentStatus)) continue
      this.engine.upsertActivity(
        {
          ...activity,
          kind: 'tool.completed',
          payload: {
            ...activity.payload,
            status: isTerminalToolStatus(currentStatus) ? currentStatus : nextStatus
          },
          createdAt: activity.createdAt
        },
        event.threadId
      )
    }
  }

  private resolvePendingPromptsForTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    const thread = this.engine.getThread(event.threadId)
    for (const activity of thread.activities) {
      if (activity.resolved) continue
      if (activity.kind !== 'approval.requested' && activity.kind !== 'user-input.requested')
        continue
      if (!activityBelongsToTurn(activity, event.turnId)) continue
      this.engine.upsertActivity(
        {
          ...activity,
          kind:
            activity.kind === 'approval.requested' ? 'approval.resolved' : 'user-input.resolved',
          tone: 'info',
          summary: `${activity.summary} (cleared by turn end)`,
          resolved: true,
          createdAt: activity.createdAt
        },
        event.threadId
      )
    }
  }

  private planKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
  }

  private findApprovalForResolution(
    event: Extract<ProviderRuntimeEvent, { type: 'request.resolved' }>
  ): OrchestrationThreadActivity | undefined {
    const thread = this.engine.getThread(event.threadId)
    if (event.requestId) {
      const id = `approval:${event.requestId}`
      const exact = thread.activities.find((activity) => activity.id === id)
      if (exact) return exact
    }
    return thread.activities
      .filter(
        (activity) =>
          activity.kind === 'approval.requested' &&
          activity.resolved !== true &&
          activityBelongsToTurn(activity, event.turnId)
      )
      .at(-1)
  }

  private completedTurnToolStatus(
    event: Pick<ProviderRuntimeEvent, 'threadId' | 'turnId'>
  ): 'completed' | 'failed' | undefined {
    if (!event.turnId) return undefined
    return this.completedTurns.get(this.turnCompletionKey(event.threadId, event.turnId))
  }

  private turnCompletionKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
  }
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): string {
  return segmentIndex === 0
    ? `assistant:${baseKey}`
    : `assistant:${baseKey}:segment:${segmentIndex}`
}

function mapSessionStatus(
  state: RuntimeSessionState
): 'starting' | 'running' | 'ready' | 'stopped' | 'error' {
  switch (state) {
    case 'starting':
      return 'starting'
    case 'running':
    case 'waiting':
      return 'running'
    case 'ready':
      return 'ready'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
    default:
      return 'ready'
  }
}

function isToolOutput(kind: RuntimeContentStreamKind): boolean {
  return kind === 'command_output' || kind === 'file_change_output'
}

function toolActivityId(event: Pick<ProviderRuntimeEvent, 'itemId' | 'eventId'>): string {
  return `tool:${event.itemId ?? event.eventId}`
}

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

function readNestedPayloadString(value: unknown, ...keys: string[]): string | undefined {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string') return candidate
  }
  const item = record.item
  if (typeof item === 'object' && item !== null) return readNestedPayloadString(item, ...keys)
  return undefined
}

function normalizeProposedPlanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const unwrapped = trimmed.replace(
    /^<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>$/i,
    '$1'
  )
  return unwrapped.trim() || undefined
}

function activityBelongsToTurn(
  activity: OrchestrationThreadActivity,
  turnId: string | undefined
): boolean {
  return !turnId || !activity.turnId || activity.turnId === turnId
}

function toolStatusForTurnCompletion(
  state: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>['payload']['state']
): 'completed' | 'failed' {
  return state === 'completed' ? 'completed' : 'failed'
}

function isTerminalToolStatus(status: string | undefined): boolean {
  return (
    status === 'completed' || status === 'success' || status === 'failed' || status === 'declined'
  )
}

function nextToolStatus(
  existingStatus: string | undefined,
  incomingStatus: string | undefined
): string {
  if (isTerminalToolStatus(existingStatus)) return existingStatus ?? 'completed'
  return incomingStatus ?? existingStatus ?? 'inProgress'
}

function toneForItem(itemType: CanonicalItemType): OrchestrationThreadActivity['tone'] {
  if (itemType === 'reasoning') return 'thinking'
  if (itemType === 'error') return 'error'
  return 'tool'
}

function titleForItem(itemType: CanonicalItemType): string {
  return itemType.replaceAll('_', ' ')
}

function titleForRequest(requestType: string): string {
  return requestType.replaceAll('_', ' ')
}

function logEvent(label: string, payload: unknown): void {
  console.log(`[cobel:${label}]`, payload)
}

import type {
  ActiveTurnProjection,
  CanonicalItemType,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationTodo,
  OrchestrationTodoList,
  ReasoningEffort,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
  RuntimeContentStreamKind,
  RuntimeSessionState
} from '../../../shared/agent'
import { mergeFileEditChanges, readCanonicalFileEditChanges } from '../../../shared/fileEditChanges'
import { mergeFileReadPreview, readCanonicalFileReadPreview } from '../../../shared/fileReadPreview'
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
  private readonly turnFinalizeOutcome = new Map<string, 'completed' | 'failed' | 'interrupted'>()
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

  private eventMatchesActiveTurn(
    event: Pick<ProviderRuntimeEvent, 'turnId'>,
    activeTurn: ActiveTurnProjection
  ): boolean {
    if (!event.turnId) return true
    if (event.turnId === activeTurn.turnId) return true
    if (activeTurn.turnId.startsWith('pending:')) return true
    return false
  }

  private patchActiveTurn(
    threadId: string,
    updater: (prev: ActiveTurnProjection | null) => ActiveTurnProjection | null,
    createdAt: string
  ): void {
    const prev = this.engine.getThread(threadId).activeTurn ?? null
    const next = updater(prev)
    if (activeTurnProjectionEquals(prev, next)) return
    this.engine.setActiveTurn({ threadId, activeTurn: next, createdAt })
  }

  /** Re-derive tail phase/indicator from thread state (streaming assistant, tools, thinking, plan). */
  private recomputeIdleTailSurface(threadId: string, createdAt: string): void {
    this.patchActiveTurn(
      threadId,
      (prev) => {
        if (!prev) return prev
        return this.reconcileActiveTurnTail(threadId, prev, createdAt)
      },
      createdAt
    )
  }

  private reconcileActiveTurnTail(
    threadId: string,
    base: ActiveTurnProjection,
    createdAt: string
  ): ActiveTurnProjection {
    if (
      base.phase === 'completed' ||
      base.phase === 'failed' ||
      base.phase === 'interrupted' ||
      base.phase === 'idle' ||
      base.phase === 'finalizing' ||
      base.phase === 'queued'
    ) {
      return base
    }
    if (base.phase === 'waiting_for_input' && base.visibleIndicator === 'approval') {
      return base
    }
    if (base.turnId.startsWith('pending:')) {
      return { ...base, visibleIndicator: 'exploring', updatedAt: createdAt }
    }

    const thread = this.engine.getThread(threadId)
    const toolSlots = base.activeItemIds.filter((id) => !id.startsWith('approval:'))
    if (toolSlots.length > 0) {
      return { ...base, phase: 'tool_running', visibleIndicator: 'tool', updatedAt: createdAt }
    }
    const approvalSlots = base.activeItemIds.filter((id) => id.startsWith('approval:'))
    if (approvalSlots.length > 0) {
      return {
        ...base,
        phase: 'waiting_for_input',
        visibleIndicator: 'approval',
        updatedAt: createdAt
      }
    }
    if (this.turnHasUnresolvedReasoningThinking(thread, base.turnId)) {
      return { ...base, phase: 'thinking', visibleIndicator: 'thinking', updatedAt: createdAt }
    }
    if (this.turnHasStreamingAssistant(thread, base.turnId)) {
      return { ...base, phase: 'streaming', visibleIndicator: 'assistant_stream', updatedAt: createdAt }
    }
    if (this.turnHasStreamingPlan(thread, base.turnId)) {
      return { ...base, phase: 'streaming', visibleIndicator: 'plan', updatedAt: createdAt }
    }

    const phase: ActiveTurnProjection['phase'] = base.phase === 'starting' ? 'starting' : 'streaming'
    return { ...base, phase, visibleIndicator: 'exploring', updatedAt: createdAt }
  }

  private turnHasUnresolvedReasoningThinking(
    thread: ReturnType<OrchestrationEngine['getThread']>,
    turnId: string
  ): boolean {
    const sessionTurnId = thread.session?.activeTurnId
    for (const activity of thread.activities) {
      if (!activity.id.startsWith('thinking:')) continue
      if (activity.resolved === true) continue
      if (readPayloadString(activity.payload, 'itemType') !== 'reasoning') continue
      const aTurn = activity.turnId
      if (aTurn) {
        if (aTurn !== turnId) continue
      } else if (sessionTurnId !== turnId) {
        continue
      }
      return true
    }
    return false
  }

  private turnHasStreamingAssistant(
    thread: ReturnType<OrchestrationEngine['getThread']>,
    turnId: string
  ): boolean {
    return thread.messages.some(
      (m) => m.role === 'assistant' && m.turnId === turnId && m.streaming === true
    )
  }

  private turnHasStreamingPlan(
    thread: ReturnType<OrchestrationEngine['getThread']>,
    turnId: string
  ): boolean {
    return thread.proposedPlans.some((p) => p.turnId === turnId && p.status === 'streaming')
  }

  private applyTurnCompletedUi(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    const threadId = event.threadId
    const thread = this.engine.getThread(threadId)
    const activeTurnId = thread.session?.activeTurnId
    if (activeTurnId && event.turnId && activeTurnId !== event.turnId) return
    const prev = thread.activeTurn
    if (!prev) return

    const mapped = mapTurnCompletedPhase(event.payload.state)
    this.turnFinalizeOutcome.set(threadId, mapped)
    const ids = [...prev.activeItemIds]
    if (ids.length === 0) {
      this.turnFinalizeOutcome.delete(threadId)
      this.engine.setActiveTurn({
        threadId,
        activeTurn: {
          ...prev,
          phase: mapped,
          visibleIndicator: 'none',
          activeItemIds: [],
          updatedAt: event.createdAt
        },
        createdAt: event.createdAt
      })
      return
    }
    this.engine.setActiveTurn({
      threadId,
      activeTurn: {
        ...prev,
        phase: 'finalizing',
        visibleIndicator: 'tool',
        activeItemIds: ids,
        updatedAt: event.createdAt
      },
      createdAt: event.createdAt
    })
  }

  private onToolItemLifecycle(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    if (!isTrackedToolItemType(event.payload.itemType)) return
    const itemId = event.itemId
    if (!itemId) return
    this.patchActiveTurn(
      event.threadId,
      (prev) => {
        if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
        if (
          prev.phase === 'completed' ||
          prev.phase === 'failed' ||
          prev.phase === 'interrupted'
        ) {
          return prev
        }
        if (event.type === 'item.started') {
          const ids = prev.activeItemIds.includes(itemId)
            ? prev.activeItemIds
            : [...prev.activeItemIds, itemId]
          return {
            ...prev,
            phase: 'tool_running',
            visibleIndicator: 'tool',
            activeItemIds: ids,
            updatedAt: event.createdAt
          }
        }
        if (event.type === 'item.completed') {
          const ids = prev.activeItemIds.filter((id) => id !== itemId)
          return this.advanceAfterToolItemChange(event.threadId, prev, ids, event.createdAt)
        }
        // item.updated: re-derive tail state. OpenCode sometimes sends a stale `running` update
        // after `completed`; blindly forcing tool_running leaves an empty activeItemIds stuck
        // in a "tool running" UI phase.
        return this.reconcileActiveTurnTail(event.threadId, { ...prev, updatedAt: event.createdAt }, event.createdAt)
      },
      event.createdAt
    )
  }

  private advanceAfterToolItemChange(
    threadId: string,
    prev: ActiveTurnProjection,
    ids: string[],
    createdAt: string
  ): ActiveTurnProjection {
    const outcome = this.turnFinalizeOutcome.get(threadId)
    if (prev.phase === 'finalizing' && ids.length === 0 && outcome) {
      this.turnFinalizeOutcome.delete(threadId)
      return {
        ...prev,
        phase: outcome,
        visibleIndicator: 'none',
        activeItemIds: [],
        updatedAt: createdAt
      }
    }
    const draft: ActiveTurnProjection = {
      ...prev,
      activeItemIds: ids,
      updatedAt: createdAt
    }
    return this.reconcileActiveTurnTail(threadId, draft, createdAt)
  }

  private toolOutputActivityId(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): string {
    if (event.itemId) return `tool:${event.itemId}`
    const at = this.engine.getThread(event.threadId).activeTurn
    if (at && at.activeItemIds.length > 0) {
      for (let i = at.activeItemIds.length - 1; i >= 0; i -= 1) {
        const slot = at.activeItemIds[i]!
        if (!slot.startsWith('approval:')) {
          return `tool:${slot}`
        }
      }
    }
    return `tool:${event.eventId}`
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
          model: this.engine.getThread(event.threadId).session?.model,
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
        this.turnFinalizeOutcome.delete(event.threadId)
        {
          const turnId = event.turnId ?? event.eventId
          this.patchActiveTurn(
            event.threadId,
            (prev) => ({
              turnId,
              phase: 'starting',
              activeItemIds: [],
              visibleIndicator: 'exploring',
              startedAt: prev?.startedAt ?? event.createdAt,
              updatedAt: event.createdAt
            }),
            event.createdAt
          )
        }
        const currentModel = this.engine.getThread(event.threadId).session?.model
        const currentEffort = this.engine.getThread(event.threadId).session?.effort
        const nextModel = typeof event.payload.model === 'string' ? event.payload.model : currentModel
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
          model: nextModel,
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
        this.applyTurnCompletedUi(event)
        this.closeActiveTurn(event)
        return

      case 'content.delta':
        this.ingestContentDelta(event)
        return

      case 'todo.updated':
        this.ingestTodoUpdate(event)
        return

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.ingestItem(event)
        if (event.type === 'item.completed' && event.payload.itemType !== 'reasoning')
          this.flushAssistant(event, { closeSegment: true })
        return

      case 'request.opened': {
        const approvalSlotId = `approval:${event.requestId ?? event.eventId}`
        this.patchActiveTurn(
          event.threadId,
          (prev) => {
            if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
            const ids = prev.activeItemIds.includes(approvalSlotId)
              ? prev.activeItemIds
              : [...prev.activeItemIds, approvalSlotId]
            return {
              ...prev,
              phase: 'waiting_for_input',
              visibleIndicator: 'approval',
              activeItemIds: ids,
              updatedAt: event.createdAt
            }
          },
          event.createdAt
        )
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
          model: this.engine.getThread(event.threadId).session?.model,
          effort: this.engine.getThread(event.threadId).session?.effort,
          activeTurnId: event.turnId ?? null,
          activePlanId: this.engine.getThread(event.threadId).session?.activePlanId ?? null,
          lastError: null,
          createdAt: event.createdAt
        })
        return
      }

      case 'request.resolved': {
        const existing = this.findApprovalForResolution(event)
        const resolvedApprovalId = existing?.id ?? `approval:${event.requestId ?? event.eventId}`
        this.engine.upsertActivity(
          {
            id: resolvedApprovalId,
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
        this.patchActiveTurn(
          event.threadId,
          (prev) => {
            if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
            if (prev.phase !== 'waiting_for_input') return prev
            const ids = prev.activeItemIds.filter((slot) => slot !== resolvedApprovalId)
            const draft: ActiveTurnProjection = {
              ...prev,
              activeItemIds: ids,
              phase: ids.length > 0 ? 'tool_running' : 'streaming',
              updatedAt: event.createdAt
            }
            return this.reconcileActiveTurnTail(event.threadId, draft, event.createdAt)
          },
          event.createdAt
        )
        return
      }

      case 'user-input.requested':
        this.patchActiveTurn(
          event.threadId,
          (prev) => {
            if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
            return {
              ...prev,
              phase: 'waiting_for_input',
              visibleIndicator: 'approval',
              updatedAt: event.createdAt
            }
          },
          event.createdAt
        )
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
        this.patchActiveTurn(
          event.threadId,
          (prev) => {
            if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
            if (prev.phase !== 'waiting_for_input') return prev
            const ids = prev.activeItemIds
            const draft: ActiveTurnProjection = {
              ...prev,
              phase: ids.length > 0 ? 'tool_running' : 'streaming',
              updatedAt: event.createdAt
            }
            return this.reconcileActiveTurnTail(event.threadId, draft, event.createdAt)
          },
          event.createdAt
        )
        return

      case 'runtime.info':
        this.engine.upsertActivity(
          {
            id: `runtime-info:${event.eventId}`,
            kind: 'task.progress',
            tone: 'info',
            summary: event.payload.message ?? event.payload.kind ?? 'Info',
            payload: { detail: event.payload.detail, kind: event.payload.kind },
            turnId: event.turnId ?? null,
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
          this.turnFinalizeOutcome.delete(event.threadId)
          this.engine.setActiveTurn({
            threadId: event.threadId,
            activeTurn: null,
            createdAt: event.createdAt
          })
          this.engine.setSession({
            threadId: event.threadId,
            status: 'error',
            providerName: event.provider,
            runtimeMode:
              this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
            interactionMode:
              this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
            model: this.engine.getThread(event.threadId).session?.model,
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

  private patchActiveTurnFromContentDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>,
    phase: ActiveTurnProjection['phase'],
    visibleIndicator: ActiveTurnProjection['visibleIndicator']
  ): void {
    this.patchActiveTurn(
      event.threadId,
      (prev) => {
        if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
        if (
          prev.phase === 'completed' ||
          prev.phase === 'failed' ||
          prev.phase === 'interrupted' ||
          prev.phase === 'finalizing'
        ) {
          return prev
        }
        return { ...prev, phase, visibleIndicator, updatedAt: event.createdAt }
      },
      event.createdAt
    )
  }

  private ingestContentDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const streamKind = event.payload.streamKind
    if (streamKind === 'assistant_text' || streamKind === 'plan_text' || isToolOutput(streamKind)) {
      this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
    }

    if (event.payload.streamKind === 'assistant_text') {
      this.patchActiveTurnFromContentDelta(event, 'streaming', 'assistant_stream')
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
      this.patchActiveTurnFromContentDelta(event, 'streaming', 'plan')
      const key = this.planKey(event.threadId, event.turnId ?? event.eventId)
      const existing = this.planBuffers.get(key)
      if (existing) {
        existing.text += event.payload.delta
      } else {
        this.planBuffers.set(key, { text: event.payload.delta, createdAt: event.createdAt })
      }
      this.upsertStreamingPlan(event)
      return
    }

    if (event.payload.streamKind === 'reasoning_text') {
      this.patchActiveTurnFromContentDelta(event, 'thinking', 'thinking')
      this.appendReasoningTextDelta(event)
      return
    }

    if (isToolOutput(event.payload.streamKind)) {
      this.appendToolOutput(event)
      this.patchActiveTurnFromContentDelta(event, 'tool_running', 'tool')
      return
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
    const mergedReadPreview = mergeFileReadPreview(
      readCanonicalFileReadPreview(event.payload),
      readCanonicalFileReadPreview(existing?.payload)
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
    if (mergedReadPreview) {
      toolPayload.fileReadPreview = mergedReadPreview
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
    this.onToolItemLifecycle(event)
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

  private ingestTodoUpdate(
    event: Extract<ProviderRuntimeEvent, { type: 'todo.updated' }>
  ): void {
    const turnId = event.turnId ?? event.eventId
    const items = normalizeTodoItems(event.payload.items)
    if (items.length === 0) return
    const todoList: OrchestrationTodoList = {
      id: todoListId(event.threadId, turnId, event.payload.source),
      turnId,
      source: event.payload.source,
      title: event.payload.title,
      explanation: event.payload.explanation,
      items,
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    }
    this.engine.upsertTodoList(todoList, event.threadId)
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
    this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
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
    if (completed) {
      this.recomputeIdleTailSurface(event.threadId, event.createdAt)
    }
  }

  /**
   * Stops reasoning spinners once another stream or non-reasoning item begins. Some providers omit
   * turn ids on reasoning updates, so unassigned reasoning is treated as belonging to the active turn.
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
      if (activity.turnId && activity.turnId !== effectiveTurnId) continue
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
    this.recomputeIdleTailSurface(threadId, createdAt)
  }

  private appendReasoningTextDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const id = `thinking:${event.itemId ?? event.turnId ?? event.eventId}`
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    if (existing?.resolved === true) return
    const completedTurnStatus = this.completedTurnToolStatus(event)

    const prevText = readPayloadString(existing?.payload, 'reasoningText') ?? ''
    const merged = `${prevText}${event.payload.delta}`
    const nextText =
      merged.length > MAX_BUFFERED_REASONING_TEXT_CHARS
        ? merged.slice(merged.length - MAX_BUFFERED_REASONING_TEXT_CHARS)
        : merged

    const existingKind = existing?.kind
    const nextKind: OrchestrationThreadActivity['kind'] =
      completedTurnStatus !== undefined
        ? 'task.completed'
        : existingKind === 'task.started' || existingKind === 'task.progress'
          ? 'task.progress'
          : 'task.started'

    const itemType = readPayloadString(existing?.payload, 'itemType') ?? 'reasoning'
    const status =
      completedTurnStatus !== undefined
        ? 'completed'
        : (readPayloadString(existing?.payload, 'status') ?? 'inProgress')
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
        resolved: completedTurnStatus !== undefined,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private appendToolOutput(event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>): void {
    const id = this.toolOutputActivityId(event)
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
        summary: existing?.summary ?? titleForToolOutput(event.payload.streamKind),
        payload: {
          ...existing?.payload,
          itemType: readPayloadString(existing?.payload, 'itemType') ?? itemTypeForToolOutput(event.payload.streamKind),
          status: completed
            ? 'completed'
            : (completedTurnStatus ?? existing?.payload?.status ?? 'inProgress'),
          title:
            readPayloadString(existing?.payload, 'title') ?? titleForToolOutput(event.payload.streamKind),
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
    const effectiveStreaming = options.streaming ?? event.type !== 'turn.completed'
    for (const [key, state] of this.assistantSegments) {
      if (!key.startsWith(`${event.threadId}:`)) continue
      if (state.buffer.length === 0) {
        if (options.closeSegment && state.activeMessageId) {
          this.closeAssistantMessage(event, state.activeMessageId, effectiveStreaming)
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
        streaming: effectiveStreaming,
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
    if (
      options.closeSegment &&
      effectiveStreaming === false &&
      event.type !== 'turn.completed'
    ) {
      this.recomputeIdleTailSurface(event.threadId, event.createdAt)
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
    const proposedPlan = this.buildProposedPlan(event, {
      text,
      status: 'proposed',
      createdAt: buffer?.createdAt ?? event.createdAt
    })
    this.engine.upsertProposedPlan(proposedPlan, event.threadId)
    this.attachPlanArtifact(event, proposedPlan)
    this.planBuffers.delete(key)
  }

  private upsertStreamingPlan(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const turnId = event.turnId ?? event.eventId
    const buffer = this.planBuffers.get(this.planKey(event.threadId, turnId))
    const text = normalizeStreamingProposedPlanText(buffer?.text)
    const proposedPlan = this.buildProposedPlan(event, {
      text,
      status: 'streaming',
      createdAt: buffer?.createdAt ?? event.createdAt
    })
    this.engine.upsertProposedPlan(proposedPlan, event.threadId)
  }

  private buildProposedPlan(
    event: Pick<ProviderRuntimeEvent, 'threadId' | 'turnId' | 'eventId' | 'createdAt'>,
    input: {
      text: string | undefined
      status: OrchestrationProposedPlan['status']
      createdAt: string
    }
  ): OrchestrationProposedPlan {
    const turnId = event.turnId ?? event.eventId
    const thread = this.engine.getThread(event.threadId)
    const existingPlanId = thread.session?.activePlanId
    const existingPlan = existingPlanId
      ? thread.proposedPlans.find((plan) => plan.id === existingPlanId) ?? null
      : null
    return {
      id: existingPlan?.id ?? `plan:${event.threadId}:turn:${turnId}`,
      turnId,
      text: input.text ?? existingPlan?.text ?? '',
      status: input.status,
      createdAt: existingPlan?.createdAt ?? input.createdAt,
      updatedAt: event.createdAt
    }
  }

  private attachPlanArtifact(
    event: Pick<ProviderRuntimeEvent, 'threadId' | 'turnId' | 'eventId' | 'createdAt'>,
    plan: OrchestrationProposedPlan
  ): void {
    const turnId = event.turnId ?? event.eventId
    const thread = this.engine.getThread(event.threadId)
    const existingMessage = [...thread.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.turnId === turnId)
    const attachments = upsertPlanAttachment(existingMessage?.attachments, plan)
    if (existingMessage) {
      this.engine.upsertMessage(
        {
          ...existingMessage,
          attachments,
          streaming: false,
          updatedAt: event.createdAt
        },
        event.threadId
      )
      return
    }
    this.engine.upsertMessage(
      {
        id: `assistant:plan:${plan.id}`,
        role: 'assistant',
        text: '',
        attachments,
        turnId,
        streaming: false,
        createdAt: event.createdAt,
        updatedAt: event.createdAt
      },
      event.threadId
    )
  }

  private closeActiveTurn(event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>): void {
    const thread = this.engine.getThread(event.threadId)
    const activeTurnId = thread.session?.activeTurnId
    const completedTurnId = event.turnId ?? event.eventId

    this.completedTurns.set(
      this.turnCompletionKey(event.threadId, completedTurnId),
      toolStatusForTurnCompletion(event.payload.state)
    )
    this.finalizeActivitiesForTurn(event)
    this.engine.clearTodoListsForTurn(event.threadId, completedTurnId, event.createdAt)
    if (activeTurnId && event.turnId && activeTurnId !== event.turnId) return

    this.engine.setLatestTurn(event.threadId, {
      id: completedTurnId,
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
      model: thread.session?.model,
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
    this.engine.clearTodoListsForTurn(event.threadId, activeTurnId, event.createdAt)
    this.engine.setLatestTurn(event.threadId, {
      id: activeTurnId,
      status: state,
      startedAt: thread.latestTurn?.startedAt ?? event.createdAt,
      completedAt: event.createdAt
    })
    this.turnFinalizeOutcome.delete(event.threadId)
    this.engine.setActiveTurn({
      threadId: event.threadId,
      activeTurn: null,
      createdAt: event.createdAt
    })
  }

  private finalizeActivitiesForTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    this.resolvePendingAssistantMessagesForTurn(event)
    this.resolvePendingThinkingForTurn(event)
    this.resolvePendingToolsForTurn(event)
    this.resolvePendingPromptsForTurn(event)
  }

  private resolvePendingAssistantMessagesForTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): void {
    const thread = this.engine.getThread(event.threadId)
    for (const message of thread.messages) {
      if (message.role !== 'assistant' || message.streaming !== true) continue
      if (message.turnId !== event.turnId) continue
      this.engine.upsertMessage(
        {
          ...message,
          streaming: false,
          updatedAt: event.createdAt
        },
        event.threadId
      )
    }
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

function todoListId(
  threadId: string,
  turnId: string,
  source: OrchestrationTodoList['source']
): string {
  return `todo:${threadId}:turn:${turnId}:${source}`
}

function normalizeTodoItems(
  items: Array<{ id?: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>
): OrchestrationTodo[] {
  return items
    .map((item, index) => {
      const text = item.text.trim()
      if (!text) return null
      return {
        id: item.id?.trim() || `todo-item:${index}:${text.toLowerCase()}`,
        text,
        status: item.status,
        order: index
      }
    })
    .filter((item): item is OrchestrationTodo => item !== null)
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

function itemTypeForToolOutput(kind: RuntimeContentStreamKind): CanonicalItemType | 'unknown' {
  if (kind === 'command_output') return 'command_execution'
  if (kind === 'file_change_output') return 'file_change'
  return 'unknown'
}

function titleForToolOutput(kind: RuntimeContentStreamKind): string {
  if (kind === 'command_output') return 'terminal'
  if (kind === 'file_change_output') return 'file changes'
  return 'Tool output'
}

function toolActivityId(event: Pick<ProviderRuntimeEvent, 'itemId' | 'eventId'>): string {
  return `tool:${event.itemId ?? event.eventId}`
}

function activeTurnProjectionEquals(
  a: ActiveTurnProjection | null,
  b: ActiveTurnProjection | null
): boolean {
  if (a === null && b === null) return true
  if (!a || !b) return false
  if (a.turnId !== b.turnId || a.phase !== b.phase || a.visibleIndicator !== b.visibleIndicator) {
    return false
  }
  if (a.startedAt !== b.startedAt) return false
  if (a.activeItemIds.length !== b.activeItemIds.length) return false
  for (let i = 0; i < a.activeItemIds.length; i += 1) {
    if (a.activeItemIds[i] !== b.activeItemIds[i]) return false
  }
  return true
}

function mapTurnCompletedPhase(
  state: 'completed' | 'failed' | 'cancelled' | 'interrupted'
): 'completed' | 'failed' | 'interrupted' {
  if (state === 'failed') return 'failed'
  if (state === 'completed') return 'completed'
  return 'interrupted'
}

function isTrackedToolItemType(itemType: CanonicalItemType | undefined): boolean {
  if (!itemType) return false
  if (
    itemType === 'reasoning' ||
    itemType === 'assistant_message' ||
    itemType === 'plan' ||
    itemType === 'user_message'
  ) {
    return false
  }
  return true
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

function normalizeStreamingProposedPlanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed
    .replace(/^<proposed_plan>\s*/i, '')
    .replace(/\s*<\/proposed_plan>$/i, '')
    .trim()
}

function upsertPlanAttachment(
  attachments: OrchestrationMessage['attachments'],
  plan: OrchestrationProposedPlan
): OrchestrationMessage['attachments'] {
  const nextAttachment = {
    type: 'plan' as const,
    planId: plan.id,
    title: derivePlanTitle(plan.text),
    status: plan.status
  }
  const existing = attachments ?? []
  const withoutPlan = existing.filter((attachment) => attachment.type !== 'plan')
  return [...withoutPlan, nextAttachment]
}

function derivePlanTitle(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const heading = lines.find((line) => /^#{1,6}\s+/u.test(line))
  const title = heading ? heading.replace(/^#{1,6}\s+/u, '') : lines[0]
  return title?.trim() || 'Plan'
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

const COBEL_DEBUG_EVENTS_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.COBEL_DEBUG_EVENTS?.trim() ?? ''
)

function logEvent(label: string, payload: unknown): void {
  if (!COBEL_DEBUG_EVENTS_ENABLED) return
  console.log(`[cobel:${label}]`, payload)
}

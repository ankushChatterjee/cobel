import { randomUUID } from 'node:crypto'
import type {
  ActiveTurnProjection,
  CanonicalItemType,
  OrchestrationCommand,
  OrchestrationSession,
  ReasoningEffort,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
  RuntimeContentStreamKind
} from '../../../shared/agent'
import {
  DEFAULT_PROVIDER_LIFECYCLE_CAPABILITIES,
  type ProviderLifecycleCapabilities
} from '../provider/types'
import { reconcileActiveTurnTail, activeTurnProjectionEquals } from './ActiveTurnSurface'
import { compileResolveReasoningThinkingForTurn } from './compileResolveReasoningThinking'
import { compilePlanArtifactCommand } from './planArtifactCommands'
import { compileTodoEvent } from './RuntimeMiscCompiler'
import { compileApprovalEvent, compileUserInputEvent } from './RuntimeApprovalCompiler'
import { OrchestrationEngine } from './OrchestrationEngine'
import {
  compileRuntimeEvent,
  type CompileRuntimeEventOptions,
  type ThreadReader
} from './RuntimeOperationCompiler'
import { compileTurnLifecycleEvent } from './RuntimeTurnCompiler'
import { compileItemEvent } from './RuntimeToolCompiler'
import { RuntimeMessageCompiler } from './RuntimeMessageCompiler'

export type OrchestrationDomainInput =
  | {
      type: 'turn-start-requested'
      threadId: string
      provider: ProviderRuntimeEvent['provider']
      commandId?: string
      pendingTurnId?: string
      model?: string
      effort?: ReasoningEffort
      runtimeMode?: RuntimeModeLike
      interactionMode?: InteractionModeLike
      activePlanId?: string | null
      createdAt: string
    }
  | {
      type: 'turn-start-accepted'
      threadId: string
      provider: ProviderRuntimeEvent['provider']
      turnId: string
      pendingTurnId?: string
      model?: string
      effort?: ReasoningEffort
      runtimeMode?: RuntimeModeLike
      interactionMode?: InteractionModeLike
      activePlanId?: string | null
      createdAt: string
    }
  | {
      type: 'turn-start-failed'
      threadId: string
      provider: ProviderRuntimeEvent['provider']
      pendingTurnId?: string
      errorMessage: string
      createdAt: string
    }
  | {
      type: 'turn-interrupt-requested'
      threadId: string
      provider: ProviderRuntimeEvent['provider']
      turnId?: string
      createdAt: string
    }
  | {
      type: 'session-stop-requested'
      threadId: string
      provider: ProviderRuntimeEvent['provider']
      createdAt: string
    }

export type RuntimeIngestionInput =
  | { source: 'runtime'; event: ProviderRuntimeEvent }
  | { source: 'domain'; event: OrchestrationDomainInput }

type RuntimeModeLike = Parameters<OrchestrationEngine['setSession']>[0]['runtimeMode']
type InteractionModeLike = Parameters<OrchestrationEngine['setSession']>[0]['interactionMode']

type ProviderLifecycleResolver = (provider: ProviderRuntimeEvent['provider']) => ProviderLifecycleCapabilities

function openCodeReadyEventMeansTurnIdle(
  event: Extract<ProviderRuntimeEvent, { type: 'session.state.changed' }>
): boolean {
  if (event.provider !== 'opencode') return false
  const raw = event.raw?.payload
  if (!raw || typeof raw !== 'object') return false
  const type = (raw as Record<string, unknown>)['type']
  if (type === 'session.idle') return true
  if (type !== 'session.status') return false
  const properties = (raw as Record<string, unknown>)['properties']
  if (!properties || typeof properties !== 'object') return false
  const status = (properties as Record<string, unknown>)['status']
  if (!status || typeof status !== 'object') return false
  return (status as Record<string, unknown>)['type'] === 'idle'
}

export class ProviderRuntimeIngestion {
  private readonly queue: RuntimeIngestionInput[] = []
  private readonly messageCompiler = new RuntimeMessageCompiler()
  private readonly completedTurns = new Map<string, 'completed' | 'failed'>()
  private draining = false
  private drainPromise: Promise<void> = Promise.resolve()

  constructor(
    private readonly engine: OrchestrationEngine,
    private readonly resolveLifecycleCapabilities: ProviderLifecycleResolver = () =>
      DEFAULT_PROVIDER_LIFECYCLE_CAPABILITIES
  ) {}

  private runtimeCompileOptions(): CompileRuntimeEventOptions {
    return {
      messageCompiler: this.messageCompiler,
      completedTurnLookup: (threadId, turnId) => this.completedTurnLookup(threadId, turnId)
    }
  }

  enqueue(event: ProviderRuntimeEvent): void {
    this.enqueueInput({ source: 'runtime', event })
  }

  enqueueDomain(event: OrchestrationDomainInput): void {
    this.enqueueInput({ source: 'domain', event })
  }

  enqueueInput(input: RuntimeIngestionInput): void {
    logEvent('runtime/enqueue', input)
    this.queue.push(input)
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
        const input = this.queue.shift()
        if (input) this.ingestInput(input)
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

  private ingestInput(input: RuntimeIngestionInput): void {
    if (input.source === 'domain') {
      this.ingestDomain(input.event)
      return
    }
    this.ingest(input.event)
  }

  private ingestDomain(event: OrchestrationDomainInput): void {
    this.engine.ensureThread({ threadId: event.threadId })
    switch (event.type) {
      case 'turn-start-requested': {
        const pendingTurnId = event.pendingTurnId ?? `pending:${event.commandId ?? event.createdAt}`
        this.patchActiveTurn(
          event.threadId,
          () => ({
            turnId: pendingTurnId,
            phase: 'queued',
            activeItemIds: [],
            visibleIndicator: 'exploring',
            startedAt: event.createdAt,
            updatedAt: event.createdAt
          }),
          event.createdAt
        )
        this.dispatchProviderSessionUpdate({
          threadId: event.threadId,
          status: 'starting',
          provider: event.provider,
          runtimeMode:
            event.runtimeMode ?? this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          interactionMode:
            event.interactionMode ?? this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
          model: event.model ?? this.engine.getThread(event.threadId).session?.model,
          effort: event.effort ?? this.engine.getThread(event.threadId).session?.effort,
          activeTurnId: null,
          activePlanId:
            event.activePlanId ?? this.engine.getThread(event.threadId).session?.activePlanId ?? null,
          lastError: null,
          createdAt: event.createdAt
        })
        return
      }
      case 'turn-start-accepted':
        this.applyTurnStarted({
          eventId: `domain:${event.turnId}`,
          provider: event.provider,
          threadId: event.threadId,
          turnId: event.turnId,
          createdAt: event.createdAt,
          type: 'turn.started',
          payload: { model: event.model, effort: event.effort }
        } as Extract<ProviderRuntimeEvent, { type: 'turn.started' }>)
        return
      case 'turn-start-failed': {
        const activeTurnId =
          this.engine.getThread(event.threadId).session?.activeTurnId ??
          this.engine.getThread(event.threadId).activeTurn?.turnId ??
          event.pendingTurnId
        if (activeTurnId) {
          this.finalizeTurn({
            provider: event.provider,
            threadId: event.threadId,
            turnId: activeTurnId,
            state: 'failed',
            errorMessage: event.errorMessage,
            createdAt: event.createdAt
          })
        } else {
          this.patchActiveTurn(event.threadId, () => null, event.createdAt)
          this.dispatchProviderSessionUpdate({
            threadId: event.threadId,
            status: 'error',
            provider: event.provider,
            runtimeMode:
              this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
            interactionMode:
              this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
            model: this.engine.getThread(event.threadId).session?.model,
            effort: this.engine.getThread(event.threadId).session?.effort,
            activeTurnId: null,
            activePlanId: null,
            lastError: event.errorMessage,
            createdAt: event.createdAt
          })
        }
        return
      }
      case 'turn-interrupt-requested': {
        const turnId =
          event.turnId ??
          this.engine.getThread(event.threadId).session?.activeTurnId ??
          this.engine.getThread(event.threadId).activeTurn?.turnId
        if (turnId) {
          this.finalizeTurn({
            provider: event.provider,
            threadId: event.threadId,
            turnId,
            state: 'interrupted',
            errorMessage: 'Interrupted.',
            createdAt: event.createdAt
          })
        }
        return
      }
      case 'session-stop-requested': {
        const turnId =
          this.engine.getThread(event.threadId).session?.activeTurnId ??
          this.engine.getThread(event.threadId).activeTurn?.turnId
        if (turnId) {
          this.finalizeTurn({
            provider: event.provider,
            threadId: event.threadId,
            turnId,
            state: 'interrupted',
            errorMessage: 'Session stopped.',
            createdAt: event.createdAt
          })
        }
        this.dispatchProviderSessionUpdate({
          threadId: event.threadId,
          status: 'stopped',
          provider: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          interactionMode:
            this.engine.getThread(event.threadId).session?.interactionMode ?? 'default',
          model: this.engine.getThread(event.threadId).session?.model,
          effort: this.engine.getThread(event.threadId).session?.effort,
          activeTurnId: null,
          activePlanId: null,
          lastError: null,
          createdAt: event.createdAt
        })
        this.patchActiveTurn(event.threadId, () => null, event.createdAt)
        return
      }
    }
  }

  private patchActiveTurn(
    threadId: string,
    updater: (prev: ActiveTurnProjection | null) => ActiveTurnProjection | null,
    createdAt: string
  ): void {
    const prev = this.engine.getThread(threadId).activeTurn ?? null
    const next = updater(prev)
    if (activeTurnProjectionEquals(prev, next)) return
    this.engine.dispatch({
      type: 'provider.active-turn.set',
      commandId: `runtime:active-turn:${threadId}:${createdAt}:${randomUUID()}`,
      threadId,
      activeTurn: next,
      createdAt
    })
  }

  /** Re-derive tail phase/indicator from thread state (streaming assistant, tools, thinking, plan). */
  private recomputeIdleTailSurface(threadId: string, createdAt: string): void {
    this.patchActiveTurn(
      threadId,
      (prev) => {
        if (!prev) return prev
        return reconcileActiveTurnTail(this.engine.getThread(threadId), prev, createdAt)
      },
      createdAt
    )
  }

  private dispatchProviderSessionUpdate(input: {
    threadId: string
    status: OrchestrationSession['status']
    provider: ProviderRuntimeEvent['provider']
    runtimeMode: OrchestrationSession['runtimeMode']
    interactionMode: OrchestrationSession['interactionMode']
    model?: OrchestrationSession['model']
    effort?: OrchestrationSession['effort']
    activeTurnId: string | null
    activePlanId: string | null
    lastError: string | null
    createdAt: string
  }): void {
    void this.engine.dispatch({
      type: 'provider.session.update',
      commandId: `runtime:session:${input.threadId}:${input.createdAt}:${randomUUID()}`,
      threadId: input.threadId,
      status: input.status,
      providerName: input.provider,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      model: input.model,
      effort: input.effort,
      activeTurnId: input.activeTurnId,
      activePlanId: input.activePlanId,
      lastError: input.lastError,
      createdAt: input.createdAt
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
        // item.updated: if this is the first time we see the item (reconciliation fired after
        // `pending` already passed), add it to activeItemIds so the phase advances to tool_running.
        // Stale `running` updates after `completed` are already dropped by the FSM's partPhaseById
        // guard before they reach here.
        if (!prev.activeItemIds.includes(itemId)) {
          const ids = [...prev.activeItemIds, itemId]
          return this.advanceAfterToolItemChange(event.threadId, prev, ids, event.createdAt)
        }
        return reconcileActiveTurnTail(this.engine.getThread(event.threadId), { ...prev, updatedAt: event.createdAt }, event.createdAt)
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
    const draft: ActiveTurnProjection = {
      ...prev,
      activeItemIds: ids,
      updatedAt: createdAt
    }
    return reconcileActiveTurnTail(this.engine.getThread(threadId), draft, createdAt)
  }

  private shouldIgnoreNonTerminalRuntimeEvent(event: ProviderRuntimeEvent): boolean {
    if (
      event.type === 'session.state.changed' ||
      event.type === 'thread.started' ||
      event.type === 'turn.started' ||
      event.type === 'turn.completed' ||
      event.type === 'runtime.error' ||
      event.type === 'runtime.warning'
    ) {
      return false
    }
    if (!event.turnId) return false
    return this.isCompletedTurn(event.threadId, event.turnId)
  }

  private applyTurnStarted(event: Extract<ProviderRuntimeEvent, { type: 'turn.started' }>): void {
    const turnId = event.turnId ?? event.eventId
    if (this.isCompletedTurn(event.threadId, turnId)) return
    const thread = this.engine.getThread(event.threadId)
    const activeTurnId = thread.session?.activeTurnId
    if (activeTurnId && activeTurnId !== turnId && !activeTurnId.startsWith('pending:')) return
    const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
    this.engine.dispatchBatch(compileTurnLifecycleEvent(event, readThread))
  }

  private finalizeTurn(input: {
    provider: ProviderRuntimeEvent['provider']
    threadId: string
    turnId: string
    state: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    errorMessage?: string
    createdAt: string
  }): void {
    const turnCompleteState =
      input.state === 'cancelled' ? ('interrupted' as const) : input.state
    const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)

    this.completedTurns.set(
      this.turnCompletionKey(input.threadId, input.turnId),
      toolStatusForTurnCompletion(input.state)
    )

    const prelude: OrchestrationCommand[] = []
    prelude.push(
      ...this.messageCompiler.flushAssistantForThread(
        input.threadId,
        input.turnId,
        input.createdAt,
        false
      )
    )
    prelude.push(...this.messageCompiler.finalizePlan(input.threadId, input.turnId, input.createdAt, readThread))
    if (prelude.length > 0) this.engine.dispatchBatch(prelude)

    const nonce = `${input.threadId}:${input.turnId}:${input.createdAt}`
    const planArtifact = compilePlanArtifactCommand({
      threadId: input.threadId,
      turnId: input.turnId,
      createdAt: input.createdAt,
      nonce,
      thread: this.engine.getThread(input.threadId)
    })
    if (planArtifact.length > 0) this.engine.dispatchBatch(planArtifact)

    const thread = this.engine.getThread(input.threadId)
    const activeTurnId = thread.session?.activeTurnId
    const shouldCloseLifecycle =
      !activeTurnId || activeTurnId === input.turnId || activeTurnId.startsWith('pending:')
    if (!shouldCloseLifecycle && thread.latestTurn?.id !== input.turnId) {
      void this.engine.dispatch({
        type: 'provider.turn.complete',
        commandId: `finalize-stale-turn:${randomUUID()}`,
        threadId: input.threadId,
        turnId: input.turnId,
        provider: input.provider,
        shadow: true,
        state: turnCompleteState,
        errorMessage: input.errorMessage,
        createdAt: input.createdAt
      })
      return
    }

    void this.engine.dispatch({
      type: 'provider.turn.complete',
      commandId: `finalize-turn:${input.threadId}:${input.turnId}:${input.createdAt}`,
      threadId: input.threadId,
      turnId: input.turnId,
      provider: input.provider,
      state: turnCompleteState,
      errorMessage: input.errorMessage,
      createdAt: input.createdAt
    })
  }

  private ingest(event: ProviderRuntimeEvent): void {
    logEvent('runtime/ingest', event)
    this.engine.ensureThread({ threadId: event.threadId })
    if (this.shouldIgnoreNonTerminalRuntimeEvent(event)) return

    switch (event.type) {
      case 'session.state.changed':
        this.closeTurnForTerminalSession(event)
        this.closeTurnForReadySession(event)
        if (this.shouldIgnoreReadySessionWhileTurnIsActive(event)) return
        if (event.payload.state === 'running') {
          const activeTurnId =
            event.turnId ?? this.engine.getThread(event.threadId).session?.activeTurnId ?? null
          if (!activeTurnId || this.isCompletedTurn(event.threadId, activeTurnId)) return
        }
        {
          const readThread: ThreadReader = (tid) => this.engine.getThread(tid)
          const cmds = compileTurnLifecycleEvent(event, readThread)
          if (cmds.length > 0) this.engine.dispatchBatch(cmds)
        }
        return

      case 'turn.started':
        this.applyTurnStarted(event)
        return

      case 'turn.completed':
        this.finalizeTurn({
          provider: event.provider,
          threadId: event.threadId,
          turnId: event.turnId ?? event.eventId,
          state: event.payload.state,
          errorMessage: event.payload.errorMessage,
          createdAt: event.createdAt
        })
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
        if (event.type === 'item.completed') this.resolvePendingApprovalForTool(event)
        if (event.type === 'item.completed' && event.payload.itemType !== 'reasoning')
          this.flushAssistantChunks(event, true, false)
        return

      case 'request.opened': {
        const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
        const approvalSlotId = `approval:${event.requestId ?? event.eventId}`
        const existingApproval = readThread(event.threadId).activities.find(
          (activity) => activity.id === approvalSlotId
        )
        if (existingApproval?.resolved === true) return
        const cmds = compileApprovalEvent(event, readThread)
        if (cmds.length > 0) this.engine.dispatchBatch(cmds)
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
        this.flushAssistantChunks(event, true, false)
        return
      }

      case 'request.resolved': {
        const existing = this.findApprovalForResolution(event)
        const resolvedApprovalId = existing?.id ?? `approval:${event.requestId ?? event.eventId}`
        const resolvedTurnId = event.turnId ?? existing?.turnId ?? null
        const staleAfterRestart = resolutionReason(event.payload.resolution) === 'stale_after_restart'
        const staleToolCallId = staleAfterRestart
          ? readPayloadString(existing?.payload, 'toolCallId')
          : undefined
        const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
        const cmds = compileApprovalEvent(event, readThread)
        if (cmds.length > 0) this.engine.dispatchBatch(cmds)
        if (event.payload.decision === 'decline') {
          if (this.lifecycleCapabilities(event.provider).closesOnApprovalDecline) {
            const interruptedTurnId =
              resolvedTurnId ??
              this.engine.getThread(event.threadId).session?.activeTurnId ??
              this.engine.getThread(event.threadId).activeTurn?.turnId ??
              event.eventId
            this.finalizeTurn({
              provider: event.provider,
              threadId: event.threadId,
              turnId: interruptedTurnId,
              state: 'interrupted',
              errorMessage: 'Approval declined.',
              createdAt: event.createdAt
            })
            return
          }
        }
        this.patchActiveTurn(
          event.threadId,
          (prev) => {
            if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
            if (prev.phase !== 'waiting_for_input') return prev
            const ids = prev.activeItemIds.filter(
              (slot) => slot !== resolvedApprovalId && slot !== staleToolCallId
            )
            const draft: ActiveTurnProjection = {
              ...prev,
              activeItemIds: ids,
              phase: ids.length > 0 ? 'tool_running' : 'streaming',
              updatedAt: event.createdAt
            }
            return reconcileActiveTurnTail(this.engine.getThread(event.threadId), draft, event.createdAt)
          },
          event.createdAt
        )
        return
      }

      case 'user-input.requested':
        {
          const userInputSlotId = `user-input:${event.requestId ?? event.eventId}`
          this.patchActiveTurn(
            event.threadId,
            (prev) => {
              if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
              const ids = prev.activeItemIds.includes(userInputSlotId)
                ? prev.activeItemIds
                : [...prev.activeItemIds, userInputSlotId]
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
        }
        this.resolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt)
        this.flushAssistantChunks(event, true, false)
        {
          const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
          const cmds = compileUserInputEvent(event, readThread)
          if (cmds.length > 0) this.engine.dispatchBatch(cmds)
        }
        return

      case 'user-input.resolved': {
        const userInputSlotId = `user-input:${event.requestId ?? event.eventId}`
        const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
        const cmds = compileUserInputEvent(event, readThread)
        if (cmds.length > 0) this.engine.dispatchBatch(cmds)
        this.patchActiveTurn(
          event.threadId,
          (prev) => {
            if (!prev || !this.eventMatchesActiveTurn(event, prev)) return prev
            if (prev.phase !== 'waiting_for_input') return prev
            const ids = prev.activeItemIds.filter((slot) => slot !== userInputSlotId)
            const draft: ActiveTurnProjection = {
              ...prev,
              activeItemIds: ids,
              phase: ids.length > 0 ? 'tool_running' : 'streaming',
              updatedAt: event.createdAt
            }
            return reconcileActiveTurnTail(this.engine.getThread(event.threadId), draft, event.createdAt)
          },
          event.createdAt
        )
        return
      }

      case 'runtime.info':
        {
          const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
          const cmds = compileRuntimeEvent(event, readThread, this.runtimeCompileOptions())
          if (cmds.length > 0) this.engine.dispatchBatch(cmds)
        }
        return

      case 'runtime.error':
      case 'runtime.warning':
        {
          const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
          const cmds = compileRuntimeEvent(event, readThread, this.runtimeCompileOptions())
          if (cmds.length > 0) this.engine.dispatchBatch(cmds)
        }
        if (event.type === 'runtime.error' && this.shouldPromoteRuntimeError(event)) {
          const turnId =
            event.turnId ??
            this.engine.getThread(event.threadId).session?.activeTurnId ??
            this.engine.getThread(event.threadId).activeTurn?.turnId
          if (turnId) {
            this.finalizeTurn({
              provider: event.provider,
              threadId: event.threadId,
              turnId,
              state: 'failed',
              errorMessage: event.payload.message,
              createdAt: event.createdAt
            })
            return
          }
          this.patchActiveTurn(event.threadId, () => null, event.createdAt)
          this.dispatchProviderSessionUpdate({
            threadId: event.threadId,
            status: 'error',
            provider: event.provider,
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
    const capabilities = this.lifecycleCapabilities(event.provider)
    if (
      capabilities.promotesRuntimeErrorsToTurnFailure === 'fatal-only' &&
      !runtimeErrorIsFatal(event)
    ) {
      return false
    }
    if (!event.turnId) return true
    const activeTurnId = this.engine.getThread(event.threadId).session?.activeTurnId
    return activeTurnId === event.turnId
  }

  private lifecycleCapabilities(provider: ProviderRuntimeEvent['provider']): ProviderLifecycleCapabilities {
    return this.resolveLifecycleCapabilities(provider)
  }

  private ingestContentDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
    const streamKind = event.payload.streamKind

    const preamble =
      streamKind === 'assistant_text' || streamKind === 'plan_text' || isToolOutput(streamKind)
        ? compileResolveReasoningThinkingForTurn(event.threadId, event.turnId, event.createdAt, readThread)
        : []

    const body = compileRuntimeEvent(event, readThread, this.runtimeCompileOptions())

    const batch = [...preamble, ...body]
    if (batch.length > 0) this.engine.dispatchBatch(batch)

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
        const threadSnapshot = readThread(event.threadId)
        return reconcileActiveTurnTail(threadSnapshot, prev, event.createdAt)
      },
      event.createdAt
    )
  }

  private ingestItem(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    if (event.payload.itemType === 'user_message') return

    const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
    const preamble =
      event.payload.itemType === 'reasoning'
        ? []
        : compileResolveReasoningThinkingForTurn(
            event.threadId,
            event.turnId,
            event.createdAt,
            readThread
          )

    const body = compileItemEvent(event, readThread, (threadId, turnId) =>
      this.completedTurnLookup(threadId, turnId)
    )

    const batch = [...preamble, ...body]
    if (batch.length > 0) this.engine.dispatchBatch(batch)

    if (event.payload.itemType === 'reasoning') {
      this.recomputeIdleTailSurface(event.threadId, event.createdAt)
    }

    if (isTrackedToolItemType(event.payload.itemType) && event.itemId) {
      this.onToolItemLifecycle(event)
    }
  }



  private ingestTodoUpdate(
    event: Extract<ProviderRuntimeEvent, { type: 'todo.updated' }>
  ): void {
    const readThread: ThreadReader = (threadId) => this.engine.getThread(threadId)
    const cmds = compileTodoEvent(event, readThread)
    if (cmds.length > 0) this.engine.dispatchBatch(cmds)
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
    const readThread: ThreadReader = (tid) => this.engine.getThread(tid)
    const cmds = compileResolveReasoningThinkingForTurn(threadId, turnId, createdAt, readThread)
    if (cmds.length > 0) this.engine.dispatchBatch(cmds)
    this.recomputeIdleTailSurface(threadId, createdAt)
  }

  private flushAssistantChunks(
    event: Pick<ProviderRuntimeEvent, 'threadId' | 'turnId' | 'createdAt' | 'type'>,
    streaming: boolean,
    reconcileIdleTail: boolean
  ): void {
    const cmds = this.messageCompiler.flushAssistantForThread(
      event.threadId,
      event.turnId,
      event.createdAt,
      streaming
    )
    if (cmds.length > 0) this.engine.dispatchBatch(cmds)
    if (reconcileIdleTail) this.recomputeIdleTailSurface(event.threadId, event.createdAt)
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
    this.finalizeTurn({
      provider: event.provider,
      threadId: event.threadId,
      turnId: activeTurnId,
      state,
      errorMessage: event.payload.reason,
      createdAt: event.createdAt
    })
  }

  private closeTurnForReadySession(
    event: Extract<ProviderRuntimeEvent, { type: 'session.state.changed' }>
  ): void {
    if (event.payload.state !== 'ready') return
    if (!this.lifecycleCapabilities(event.provider).completesOnReadySession) return
    const thread = this.engine.getThread(event.threadId)
    if (event.provider === 'opencode' && thread.session?.status === 'running' && !openCodeReadyEventMeansTurnIdle(event)) {
      return
    }
    const activeTurnId =
      event.turnId ??
      thread.session?.activeTurnId ??
      thread.activeTurn?.turnId ??
      (thread.latestTurn?.status === 'running' ? thread.latestTurn.id : null)
    if (!activeTurnId) return
    if (this.isCompletedTurn(event.threadId, activeTurnId)) return

    this.finalizeTurn({
      provider: event.provider,
      threadId: event.threadId,
      turnId: activeTurnId,
      state: 'completed',
      createdAt: event.createdAt
    })
  }

  private shouldIgnoreReadySessionWhileTurnIsActive(
    event: Extract<ProviderRuntimeEvent, { type: 'session.state.changed' }>
  ): boolean {
    if (event.payload.state !== 'ready') return false
    if (this.lifecycleCapabilities(event.provider).completesOnReadySession) return false
    const thread = this.engine.getThread(event.threadId)
    const activeTurnId =
      event.turnId ??
      thread.session?.activeTurnId ??
      thread.activeTurn?.turnId ??
      (thread.latestTurn?.status === 'running' ? thread.latestTurn.id : null)
    return Boolean(activeTurnId && !this.isCompletedTurn(event.threadId, activeTurnId))
  }

  private resolvePendingApprovalForTool(event: ProviderRuntimeEvent): void {
    if (event.type !== 'item.completed') return
    if (!event.itemId) return
    const thread = this.engine.getThread(event.threadId)
    for (const activity of thread.activities) {
      if (activity.kind !== 'approval.requested' || activity.resolved === true) continue
      if (readPayloadString(activity.payload, 'toolCallId') !== event.itemId) continue
      void this.engine.dispatch({
        type: 'provider.activity.upsert',
        commandId: `provider:${event.eventId}:approval-clear:${activity.id}`,
        threadId: event.threadId,
        activity: {
          ...activity,
          kind: 'approval.resolved',
          tone: 'info',
          summary: `${activity.summary} (cleared by tool completion)`,
          payload: { ...activity.payload, decision: 'accept' },
          resolved: true,
          createdAt: event.createdAt
        },
        createdAt: event.createdAt
      })
    }
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

  private completedTurnLookup(
    threadId: string,
    turnId: string | null | undefined
  ): 'completed' | 'failed' | undefined {
    if (!turnId) return undefined
    return this.completedTurns.get(this.turnCompletionKey(threadId, turnId))
  }

  private isCompletedTurn(threadId: string, turnId: string): boolean {
    return this.completedTurns.has(this.turnCompletionKey(threadId, turnId))
  }

  private turnCompletionKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
  }
}

function isToolOutput(kind: RuntimeContentStreamKind): boolean {
  return kind === 'command_output' || kind === 'file_change_output'
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

function resolutionReason(resolution: unknown): string | undefined {
  if (!resolution || typeof resolution !== 'object') return undefined
  const reason = (resolution as Record<string, unknown>).reason
  return typeof reason === 'string' ? reason : undefined
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

function runtimeErrorIsFatal(event: ProviderRuntimeEvent): boolean {
  if (event.type !== 'runtime.error') return false
  if (event.payload.fatal === true || event.payload.severity === 'fatal') return true
  const detail = event.payload.detail
  if (!detail || typeof detail !== 'object') return false
  const record = detail as Record<string, unknown>
  if (record['fatal'] === true || record['severity'] === 'fatal') return true
  const className = record['class']
  return (
    className === 'transport_error' ||
    className === 'app_server_exit' ||
    className === 'protocol_error' ||
    className === 'turn_start_failed'
  )
}

const COBEL_DEBUG_EVENTS_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.COBEL_DEBUG_EVENTS?.trim() ?? ''
)

function logEvent(label: string, payload: unknown): void {
  if (!COBEL_DEBUG_EVENTS_ENABLED) return
  console.log(`[cobel:${label}]`, payload)
}

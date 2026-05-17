/**
 * Decider
 *
 * Maps an `OrchestrationCommand` + the current read model to one or more
 * `OrchestrationEvent`s that, when applied through the projector
 * (`orchestrationReducer`), advance the read model to the correct next state.
 *
 * The decider is a pure function: no I/O, no side effects. The engine is
 * responsible for assigning sequences, persisting events, and broadcasting.
 *
 * Architecture position (per plan):
 *   OrchestrationCommand → Decider → OrchestrationEvent[] → Projector → read model
 *
 * The `projector` is `applyOrchestrationEvent` from `orchestrationReducer.ts`.
 */
import { mergeThreadActivity } from '../../../shared/orchestrationThreadMerge'
import type {
  ActiveTurnProjection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity
} from '../../../shared/agent'

/** Distribute `Omit` across `OrchestrationEvent` union arms. */
type DistributeOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never

/** Events produced by the decider — sequences are not yet assigned. */
export type PendingEvent = DistributeOmit<OrchestrationEvent, 'sequence'>


function appendTurnFinalizeContent(
  thread: OrchestrationThread,
  command: Extract<OrchestrationCommand, { type: 'provider.turn.complete' }>,
  now: string
): PendingEvent[] {
  const events: PendingEvent[] = []
  const turnId = command.turnId

  for (const msg of thread.messages) {
    if (msg.role !== 'assistant' || !msg.streaming || msg.turnId !== turnId) continue
    const finalized: OrchestrationMessage = { ...msg, streaming: false, updatedAt: now }
    events.push({
      type: 'thread.message-upserted',
      threadId: command.threadId,
      message: finalized,
      createdAt: now,
      commandId: command.commandId
    })
  }

  const nextToolStatus = command.state === 'completed' ? 'completed' : 'failed'
  for (const activity of thread.activities) {
    if (!activityBelongsToTurn(activity, turnId)) continue
    const updated = finalizeActivity(activity, nextToolStatus, now)
    if (updated !== activity) {
      events.push({
        type: 'thread.activity-upserted',
        threadId: command.threadId,
        activity: updated,
        createdAt: now,
        commandId: command.commandId
      })
    }
  }

  return events
}


/**
 * Given a command and the current thread state, produce the ordered list of
 * pending events that implement the command's intent.
 *
 * `thread` is the current projection of the thread aggregate. It may be
 * undefined if the thread has not yet been created (only valid for commands
 * that bootstrap a thread).
 */
export function decide(
  command: OrchestrationCommand,
  thread: OrchestrationThread
): PendingEvent[] {
  const now = command.createdAt

  switch (command.type) {
    case 'provider.session.update': {
      const current = thread.session
      const next: OrchestrationSession = {
        threadId: command.threadId,
        status: command.status,
        providerName: command.providerName,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        model: command.model,
        effort: command.effort,
        activeTurnId: command.activeTurnId,
        activePlanId: command.activePlanId,
        lastError: command.lastError,
        updatedAt: now
      }
      if (sessionsEqual(current, next)) return []
      return [
        {
          type: 'thread.session-set',
          threadId: command.threadId,
          session: next,
          createdAt: now,
          commandId: command.commandId
        }
      ]
    }

    case 'provider.turn.start': {
      const turnId = command.turnId
      const session = thread.session
      const events: PendingEvent[] = []

      // Update active-turn projection
      const prevActiveTurn = thread.activeTurn
      const nextActiveTurn: ActiveTurnProjection = {
        turnId,
        phase: 'starting',
        activeItemIds: [],
        visibleIndicator: 'exploring',
        startedAt: prevActiveTurn?.startedAt ?? now,
        updatedAt: now
      }
      if (!activeTurnProjectionEquals(prevActiveTurn ?? null, nextActiveTurn)) {
        events.push({
          type: 'thread.active-turn-set',
          threadId: command.threadId,
          activeTurn: nextActiveTurn,
          createdAt: now,
          commandId: command.commandId
        })
      }

      // Update latest-turn
      events.push({
        type: 'thread.latest-turn-set',
        threadId: command.threadId,
        latestTurn: {
          id: turnId,
          status: 'running',
          startedAt: now,
          completedAt: null
        },
        createdAt: now,
        commandId: command.commandId
      })

      // Update session to running + activeTurnId
      const nextSession: OrchestrationSession = {
        threadId: command.threadId,
        status: 'running',
        providerName: session?.providerName ?? command.provider ?? null,
        runtimeMode: session?.runtimeMode ?? 'auto-accept-edits',
        interactionMode: session?.interactionMode ?? 'default',
        model: command.model ?? session?.model,
        effort: command.effort ?? session?.effort,
        activeTurnId: turnId,
        activePlanId: session?.activePlanId ?? null,
        lastError: null,
        updatedAt: now
      }
      if (!sessionsEqual(session ?? null, nextSession)) {
        events.push({
          type: 'thread.session-set',
          threadId: command.threadId,
          session: nextSession,
          createdAt: now,
          commandId: command.commandId
        })
      }

      return events
    }

    case 'provider.turn.complete': {
      const turnId = command.turnId
      const finalizeContent = appendTurnFinalizeContent(thread, command, now)
      if (command.shadow) return finalizeContent

      const events: PendingEvent[] = [...finalizeContent]

      // Clear active-turn
      if (thread.activeTurn) {
        events.push({
          type: 'thread.active-turn-set',
          threadId: command.threadId,
          activeTurn: null,
          createdAt: now,
          commandId: command.commandId
        })
      }

      // Update latest-turn
      const prevLatest = thread.latestTurn
      const latestTurn: OrchestrationLatestTurn = {
        id: turnId,
        status: command.state,
        startedAt: prevLatest?.id === turnId ? (prevLatest.startedAt) : now,
        completedAt: now
      }
      events.push({
        type: 'thread.latest-turn-set',
        threadId: command.threadId,
        latestTurn,
        createdAt: now,
        commandId: command.commandId
      })

      // Clear todo lists for this turn
      events.push({
        type: 'thread.todo-lists-cleared',
        threadId: command.threadId,
        turnId,
        createdAt: now,
        commandId: command.commandId
      })

      // Update session
      const session = thread.session
      const sessionStatus: OrchestrationSession['status'] =
        command.state === 'completed'
          ? 'ready'
          : command.state === 'interrupted'
            ? 'interrupted'
            : 'error'
      const nextSession: OrchestrationSession = {
        threadId: command.threadId,
        status: sessionStatus,
        providerName: session?.providerName ?? command.provider ?? null,
        runtimeMode: session?.runtimeMode ?? 'auto-accept-edits',
        interactionMode: session?.interactionMode ?? 'default',
        model: session?.model,
        effort: session?.effort,
        activeTurnId: null,
        activePlanId: null,
        lastError: command.state !== 'completed' ? (command.errorMessage ?? null) : null,
        updatedAt: now
      }
      if (!sessionsEqual(session ?? null, nextSession)) {
        events.push({
          type: 'thread.session-set',
          threadId: command.threadId,
          session: nextSession,
          createdAt: now,
          commandId: command.commandId
        })
      }

      return events
    }

    case 'provider.message.upsert': {
      const existing = thread.messages.find((m) => m.id === command.message.id)
      const next: OrchestrationMessage = existing
        ? { ...existing, ...command.message, text: `${existing.text ?? ''}${command.message.text}` }
        : command.message
      return [
        {
          type: 'thread.message-upserted',
          threadId: command.threadId,
          message: next,
          createdAt: now,
          commandId: command.commandId
        }
      ]
    }

    case 'provider.activity.upsert': {
      const existing = thread.activities.find((a) => a.id === command.activity.id)
      const merged = mergeThreadActivity(existing, command.activity)
      const next: OrchestrationThreadActivity = {
        ...merged,
        createdAt: existing?.createdAt ?? command.activity.createdAt
      }
      return [
        {
          type: 'thread.activity-upserted',
          threadId: command.threadId,
          activity: next,
          createdAt: now,
          commandId: command.commandId
        }
      ]
    }

    case 'provider.active-turn.set': {
      if (activeTurnProjectionEquals(thread.activeTurn ?? null, command.activeTurn)) return []
      return [
        {
          type: 'thread.active-turn-set',
          threadId: command.threadId,
          activeTurn: command.activeTurn,
          createdAt: now,
          commandId: command.commandId
        }
      ]
    }

    case 'provider.latest-turn.set':
      return [
        {
          type: 'thread.latest-turn-set',
          threadId: command.threadId,
          latestTurn: command.latestTurn,
          createdAt: now,
          commandId: command.commandId
        }
      ]

    case 'provider.proposed-plan.upsert':
      return [
        {
          type: 'thread.proposed-plan-upserted',
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
          createdAt: now,
          commandId: command.commandId
        }
      ]

    case 'provider.todo-list.upsert':
      return [
        {
          type: 'thread.todo-list-upserted',
          threadId: command.threadId,
          todoList: command.todoList,
          createdAt: now,
          commandId: command.commandId
        }
      ]

    case 'provider.todo-lists.clear':
      return [
        {
          type: 'thread.todo-lists-cleared',
          threadId: command.threadId,
          turnId: command.turnId,
          createdAt: now,
          commandId: command.commandId
        }
      ]

    default: {
      const _exhaustive: never = command
      return _exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionsEqual(
  a: OrchestrationSession | null | undefined,
  b: OrchestrationSession | null | undefined
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.status === b.status &&
    a.providerName === b.providerName &&
    a.runtimeMode === b.runtimeMode &&
    a.interactionMode === b.interactionMode &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.activeTurnId === b.activeTurnId &&
    a.activePlanId === b.activePlanId &&
    a.lastError === b.lastError
  )
}

function activeTurnProjectionEquals(
  a: ActiveTurnProjection | null,
  b: ActiveTurnProjection | null
): boolean {
  if (a === null && b === null) return true
  if (!a || !b) return false
  return (
    a.turnId === b.turnId &&
    a.phase === b.phase &&
    a.visibleIndicator === b.visibleIndicator &&
    a.startedAt === b.startedAt &&
    a.activeItemIds.length === b.activeItemIds.length &&
    a.activeItemIds.every((id, i) => id === b.activeItemIds[i])
  )
}

function activityBelongsToTurn(
  activity: OrchestrationThreadActivity,
  turnId: string
): boolean {
  return !activity.turnId || activity.turnId === turnId
}

function finalizeActivity(
  activity: OrchestrationThreadActivity,
  nextToolStatus: 'completed' | 'failed',
  _now: string
): OrchestrationThreadActivity {
  if (activity.resolved === true) return activity

  if (activity.tone === 'thinking') {
    return {
      ...activity,
      kind: 'task.completed',
      resolved: true,
      payload: { ...activity.payload, status: 'completed' }
    }
  }

  if (activity.kind === 'approval.requested' || activity.kind === 'user-input.requested') {
    return {
      ...activity,
      kind: activity.kind === 'approval.requested' ? 'approval.resolved' : 'user-input.resolved',
      tone: 'info',
      summary: `${activity.summary} (cleared by turn end)`,
      resolved: true
    }
  }

  if (activity.kind.startsWith('tool.')) {
    const currentStatus = activity.payload
      ? (activity.payload['status'] as string | undefined)
      : undefined
    const isAlreadyTerminal =
      currentStatus === 'completed' ||
      currentStatus === 'success' ||
      currentStatus === 'failed' ||
      currentStatus === 'declined'
    return {
      ...activity,
      kind: 'tool.completed',
      payload: {
        ...activity.payload,
        status: isAlreadyTerminal ? currentStatus : nextToolStatus
      }
    }
  }

  return activity
}

/**
 * Thread selectors
 *
 * Pure functions that derive view-model values from `ThreadDetailState` (or
 * directly from `OrchestrationThread`). No React hooks — these are called from
 * components that have already retrieved state from the store.
 *
 * Callers should memoize (e.g. with `useMemo`) when the derived value is
 * expensive or used as a stable reference to avoid unnecessary re-renders.
 */
import type {
  ActiveTurnProjection,
  ActiveTurnVisibleIndicator,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationTodoList
} from '../../../shared/agent'
import type { ThreadDetailState } from './threadDetailReducer'

// ---------------------------------------------------------------------------
// Basic thread selectors
// ---------------------------------------------------------------------------

export function selectThread(state: ThreadDetailState): OrchestrationThread | null {
  return state.thread
}

export function selectActiveTurn(state: ThreadDetailState): ActiveTurnProjection | null {
  return state.thread?.activeTurn ?? null
}

export function selectSession(state: ThreadDetailState) {
  return state.thread?.session ?? null
}

export function selectMessages(state: ThreadDetailState): OrchestrationMessage[] {
  return state.thread?.messages ?? []
}

export function selectActivities(state: ThreadDetailState): OrchestrationThreadActivity[] {
  return state.thread?.activities ?? []
}

export function selectProposedPlans(state: ThreadDetailState): OrchestrationProposedPlan[] {
  return state.thread?.proposedPlans ?? []
}

export function selectTodoLists(state: ThreadDetailState): OrchestrationTodoList[] {
  return state.thread?.todoLists ?? []
}

export function selectCheckpoints(state: ThreadDetailState): OrchestrationCheckpointSummary[] {
  return state.thread?.checkpoints ?? []
}

// ---------------------------------------------------------------------------
// Derived: tail indicator
// ---------------------------------------------------------------------------

/**
 * Returns the tail visible indicator for the current active turn, or `null`
 * when there is no active turn.
 */
export function selectTailIndicator(
  thread: OrchestrationThread | null
): ActiveTurnVisibleIndicator | null {
  const activeTurn = thread?.activeTurn
  if (!activeTurn) return null
  if (
    activeTurn.phase === 'completed' ||
    activeTurn.phase === 'failed' ||
    activeTurn.phase === 'interrupted'
  ) {
    return null
  }
  return activeTurn.visibleIndicator
}

/**
 * Returns true if the tail row should display a spinner.
 */
export function selectTailShowsSpinner(thread: OrchestrationThread | null): boolean {
  const indicator = selectTailIndicator(thread)
  return (
    indicator === 'exploring' ||
    indicator === 'thinking' ||
    indicator === 'assistant_stream' ||
    indicator === 'tool' ||
    indicator === 'plan'
  )
}

/**
 * Returns true if the tail row is visible (there is active progress to show).
 */
export function selectTailVisible(thread: OrchestrationThread | null): boolean {
  const activeTurn = thread?.activeTurn
  if (!activeTurn) return false
  return (
    activeTurn.phase !== 'completed' &&
    activeTurn.phase !== 'failed' &&
    activeTurn.phase !== 'interrupted' &&
    activeTurn.phase !== 'idle'
  )
}

// ---------------------------------------------------------------------------
// Derived: pending requests
// ---------------------------------------------------------------------------

export interface PendingRequest {
  id: string
  kind: 'approval' | 'user-input'
  activity: OrchestrationThreadActivity
}

/**
 * Returns all pending (unresolved) approval and user-input requests for the
 * current active turn.
 */
export function selectPendingRequests(thread: OrchestrationThread | null): PendingRequest[] {
  if (!thread) return []
  const activeTurnId = thread.session?.activeTurnId ?? thread.activeTurn?.turnId
  const requests: PendingRequest[] = []
  for (const activity of thread.activities) {
    if (activity.resolved === true) continue
    if (activity.kind === 'approval.requested') {
      if (activeTurnId && activity.turnId && activity.turnId !== activeTurnId) continue
      requests.push({ id: activity.id, kind: 'approval', activity })
    } else if (activity.kind === 'user-input.requested') {
      if (activeTurnId && activity.turnId && activity.turnId !== activeTurnId) continue
      requests.push({ id: activity.id, kind: 'user-input', activity })
    }
  }
  return requests
}

// ---------------------------------------------------------------------------
// Derived: latest proposed plan
// ---------------------------------------------------------------------------

export function selectLatestProposedPlan(
  thread: OrchestrationThread | null
): OrchestrationProposedPlan | null {
  if (!thread || thread.proposedPlans.length === 0) return null
  const activeTurnId = thread.session?.activeTurnId ?? thread.activeTurn?.turnId
  if (activeTurnId) {
    const forTurn = [...thread.proposedPlans]
      .reverse()
      .find((p) => p.turnId === activeTurnId)
    if (forTurn) return forTurn
  }
  return thread.proposedPlans[thread.proposedPlans.length - 1] ?? null
}

// ---------------------------------------------------------------------------
// Derived: visible todo lists
// ---------------------------------------------------------------------------

/**
 * Returns todo lists that should be visible to the user: non-empty lists from
 * the current or most recent completed turn.
 */
export function selectVisibleTodoLists(
  thread: OrchestrationThread | null
): OrchestrationTodoList[] {
  if (!thread) return []
  return (thread.todoLists ?? []).filter((list) => list.items.length > 0)
}

// ---------------------------------------------------------------------------
// Derived: checkpoint by assistant message id
// ---------------------------------------------------------------------------

export function selectCheckpointByMessageId(
  thread: OrchestrationThread | null
): Map<string, OrchestrationCheckpointSummary> {
  const map = new Map<string, OrchestrationCheckpointSummary>()
  if (!thread) return map
  for (const checkpoint of thread.checkpoints) {
    if (checkpoint.assistantMessageId) {
      map.set(checkpoint.assistantMessageId, checkpoint)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Derived: session is in progress
// ---------------------------------------------------------------------------

export function selectIsSessionRunning(thread: OrchestrationThread | null): boolean {
  const status = thread?.session?.status
  return status === 'running' || status === 'starting'
}

export function selectHasActiveTurn(thread: OrchestrationThread | null): boolean {
  return Boolean(thread?.activeTurn)
}

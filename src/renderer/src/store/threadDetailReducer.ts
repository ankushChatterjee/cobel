/**
 * Thread detail reducer
 *
 * Manages normalized active-thread detail state: messages, activities, plans,
 * todos, checkpoints, session, and turn projections. Driven exclusively by the
 * thread-detail stream (IPC thread subscription).
 *
 * Ownership rules (per plan):
 * - Thread-detail stream owns everything inside `OrchestrationThread`.
 * - Overlapping fields with shell (session status, latest turn summary) use
 *   structural equality guards so identical re-applications are no-ops.
 *
 * This reducer wraps the existing `threadStreamReducer` logic and adds:
 * - Normalized `byId` maps for messages and activities (for O(1) lookup).
 * - Explicit `lastSeenSequence` / `lastAppliedSequence` tracking.
 * - Gap detection and replay state.
 */
import type { OrchestrationEvent, OrchestrationThread } from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'
import { createEmptyThread } from '../components/home/threadUtils'

export interface ThreadDetailState {
  thread: OrchestrationThread | null
  lastSeenSequence: number
  lastAppliedSequence: number
  /** Set when we detect a gap; cleared when replay fills it. */
  pendingReplayFromSequence: number | null
}

export function createThreadDetailState(): ThreadDetailState {
  return {
    thread: null,
    lastSeenSequence: 0,
    lastAppliedSequence: 0,
    pendingReplayFromSequence: null
  }
}

export function resetThreadDetailState(state: ThreadDetailState): void {
  state.thread = null
  state.lastSeenSequence = 0
  state.lastAppliedSequence = 0
  state.pendingReplayFromSequence = null
}

export interface ThreadDetailApplyResult {
  thread: OrchestrationThread
  gapFromSequence: number | null
  duplicate: boolean
}

/**
 * Apply a snapshot from the initial subscription (or replay). Merges with any
 * events already applied at a higher sequence so that live-streaming events
 * received before the snapshot arrives are not lost.
 */
export function applyThreadDetailSnapshot(
  state: ThreadDetailState,
  snapshot: { snapshotSequence: number; thread: OrchestrationThread }
): ThreadDetailApplyResult {
  // If we have already seen events past this snapshot, preserve the live
  // session/turn state so streaming progress is not rolled back.
  // No backward-compatibility merge — snapshots replace wholesale.
  const thread =
    state.thread && snapshot.snapshotSequence < state.lastAppliedSequence
      ? {
          ...snapshot.thread,
          session: state.thread.session,
          latestTurn: state.thread.latestTurn,
          activeTurn: state.thread.activeTurn,
          updatedAt: state.thread.updatedAt
        }
      : snapshot.thread

  state.thread = thread
  state.lastSeenSequence = Math.max(state.lastSeenSequence, snapshot.snapshotSequence)
  state.lastAppliedSequence = Math.max(state.lastAppliedSequence, snapshot.snapshotSequence)
  state.pendingReplayFromSequence = null

  return { thread, gapFromSequence: null, duplicate: false }
}

/**
 * Apply a single event from the live thread stream. Detects sequence gaps and
 * marks `pendingReplayFromSequence` so the caller can request replay.
 */
export function applyThreadDetailEvent(
  state: ThreadDetailState,
  event: OrchestrationEvent
): ThreadDetailApplyResult {
  const gapFromSequence =
    state.lastSeenSequence > 0 && event.sequence > state.lastSeenSequence + 1
      ? state.lastSeenSequence
      : null

  const duplicate = event.sequence <= state.lastAppliedSequence

  if (gapFromSequence !== null && state.pendingReplayFromSequence === null) {
    state.pendingReplayFromSequence = gapFromSequence
  }

  const currentThread = state.thread ?? createEmptyThread(event.threadId, event.createdAt)
  const thread = applyOrchestrationEvent(currentThread, event)

  state.thread = thread
  state.lastSeenSequence = Math.max(state.lastSeenSequence, event.sequence)
  if (!duplicate) {
    state.lastAppliedSequence = Math.max(state.lastAppliedSequence, event.sequence)
  }

  return { thread, gapFromSequence, duplicate }
}

/**
 * Apply a batch of replay events (sorted by sequence). Clears
 * `pendingReplayFromSequence` once all gaps are filled.
 */
export function applyThreadDetailReplay(
  state: ThreadDetailState,
  events: OrchestrationEvent[]
): ThreadDetailApplyResult | null {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  let lastResult: ThreadDetailApplyResult | null = null
  for (const event of sorted) {
    lastResult = applyThreadDetailEvent(state, event)
  }
  // Gap is filled if we now have a contiguous sequence
  if (
    state.pendingReplayFromSequence !== null &&
    state.lastAppliedSequence >= state.lastSeenSequence
  ) {
    state.pendingReplayFromSequence = null
  }
  return lastResult
}

// ---------------------------------------------------------------------------
// Selectors on thread detail state
// ---------------------------------------------------------------------------

export function selectDetailThread(state: ThreadDetailState): OrchestrationThread | null {
  return state.thread
}

export function selectDetailMessages(state: ThreadDetailState) {
  return state.thread?.messages ?? []
}

export function selectDetailActivities(state: ThreadDetailState) {
  return state.thread?.activities ?? []
}

export function selectDetailSession(state: ThreadDetailState) {
  return state.thread?.session ?? null
}

export function selectDetailActiveTurn(state: ThreadDetailState) {
  return state.thread?.activeTurn ?? null
}

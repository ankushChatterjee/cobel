import type { OrchestrationEvent, OrchestrationThread } from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'
import { createEmptyThread } from '../components/home/threadUtils'
import { coalesceOrchestrationEvents } from '../store/eventCoalescing'

export interface ThreadStreamState {
  thread: OrchestrationThread | null
  lastSeenSequence: number
  lastAppliedSequence: number
}

export interface ThreadStreamApplyResult {
  thread: OrchestrationThread
  gapFromSequence: number | null
  duplicate: boolean
}

export function createThreadStreamState(): ThreadStreamState {
  return {
    thread: null,
    lastSeenSequence: 0,
    lastAppliedSequence: 0
  }
}

export function resetThreadStreamState(state: ThreadStreamState): void {
  state.thread = null
  state.lastSeenSequence = 0
  state.lastAppliedSequence = 0
}

export function applyThreadStreamSnapshot(
  state: ThreadStreamState,
  snapshot: { snapshotSequence: number; thread: OrchestrationThread }
): ThreadStreamApplyResult {
  if (state.thread && snapshot.snapshotSequence < state.lastAppliedSequence) {
    return { thread: state.thread, gapFromSequence: null, duplicate: true }
  }

  const thread = snapshot.thread

  state.thread = thread
  state.lastSeenSequence = Math.max(state.lastSeenSequence, snapshot.snapshotSequence)
  state.lastAppliedSequence = Math.max(state.lastAppliedSequence, snapshot.snapshotSequence)
  return { thread, gapFromSequence: null, duplicate: false }
}

export function applyThreadStreamEvent(
  state: ThreadStreamState,
  event: OrchestrationEvent
): ThreadStreamApplyResult {
  const gapFromSequence =
    state.lastSeenSequence > 0 && event.sequence > state.lastSeenSequence + 1
      ? state.lastSeenSequence
      : null
  const duplicate = event.sequence <= state.lastAppliedSequence
  const currentThread = state.thread ?? createEmptyThread(event.threadId, event.createdAt)
  if (duplicate) {
    state.lastSeenSequence = Math.max(state.lastSeenSequence, event.sequence)
    return { thread: currentThread, gapFromSequence: null, duplicate }
  }
  const thread = applyOrchestrationEvent(currentThread, event)
  state.thread = thread
  state.lastSeenSequence = Math.max(state.lastSeenSequence, event.sequence)
  state.lastAppliedSequence = Math.max(state.lastAppliedSequence, event.sequence)
  return { thread, gapFromSequence, duplicate }
}

/**
 * Apply a batch of events, coalescing adjacent high-frequency events first.
 * Returns the result of the last applied event, or null if the batch is empty.
 */
export function applyThreadStreamEventBatch(
  state: ThreadStreamState,
  events: OrchestrationEvent[]
): ThreadStreamApplyResult | null {
  if (events.length === 0) return null
  const coalesced = coalesceOrchestrationEvents(events)
  let lastResult: ThreadStreamApplyResult | null = null
  for (const event of coalesced) {
    lastResult = applyThreadStreamEvent(state, event)
  }
  return lastResult
}

export function markReplayApplied(
  state: ThreadStreamState,
  events: OrchestrationEvent[]
): ThreadStreamApplyResult | null {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence)
  return applyThreadStreamEventBatch(state, sorted)
}

/**
 * Thread derivation
 *
 * Materializes fat view models from normalized thread state with stable
 * references — inspired by dpcode/t3code `threadDerivation.ts`.
 *
 * The key principle: the primary write-surface is the normalized
 * `OrchestrationThread` stored in `ThreadDetailState`. Fat derived objects
 * (transcript items, tool groups, etc.) are computed here through selectors
 * and should be memoized by callers (e.g. `useMemo`) so that React only
 * re-renders when data actually changes.
 *
 * This module does not contain React hooks — it is pure derivation logic so
 * it can be tested without a DOM.
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity
} from '../../../shared/agent'

// Re-export the transcript builder from threadUtils so callers can import from
// one place. When threadUtils derivation logic is fully migrated here, this
// re-export can be replaced with the direct implementation.
export {
  buildTranscriptItems,
  buildCheckpointByAssistantMessageId,
  findLatestProposedPlan,
  visibleTodoListsForThread,
  selectTailIndicator,
  labelForTranscriptTailIndicator,
  transcriptTailShowsSpinner,
  selectTranscriptTailRowVisible,
  isOrchestrationModelTurnInProgress
} from '../components/home/threadUtils'

// ---------------------------------------------------------------------------
// Derived message view
// ---------------------------------------------------------------------------

/**
 * Returns assistant messages sorted by creation time, with streaming messages
 * last so they appear at the tail.
 */
export function deriveAssistantMessages(thread: OrchestrationThread): OrchestrationMessage[] {
  return thread.messages
    .filter((m) => m.role === 'assistant')
    .sort((a, b) => {
      if (a.streaming && !b.streaming) return 1
      if (!a.streaming && b.streaming) return -1
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    })
}

// ---------------------------------------------------------------------------
// Derived activity view
// ---------------------------------------------------------------------------

export interface ActivityGroup {
  turnId: string | null
  activities: OrchestrationThreadActivity[]
}

/**
 * Groups activities by turn id, preserving order. Activities without a turnId
 * are placed in a group with `turnId: null`.
 */
export function deriveActivityGroups(thread: OrchestrationThread): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  let current: ActivityGroup | null = null
  for (const activity of thread.activities) {
    const tid = activity.turnId ?? null
    if (!current || current.turnId !== tid) {
      current = { turnId: tid, activities: [] }
      groups.push(current)
    }
    current.activities.push(activity)
  }
  return groups
}

// ---------------------------------------------------------------------------
// Structural equality helpers for overlapping shell/detail fields
// ---------------------------------------------------------------------------

/**
 * Returns true if the session status portion that appears in the shell summary
 * has changed. Used to avoid churning shell state when session updates arrive
 * on the detail stream with identical shell-visible fields.
 */
export function shellRelevantSessionChanged(
  prev: OrchestrationThread | null,
  next: OrchestrationThread
): boolean {
  if (!prev) return true
  const ps = prev.session
  const ns = next.session
  if (!ps && !ns) return false
  if (!ps || !ns) return true
  return ps.status !== ns.status
}

/**
 * Returns true if the latest-turn portion that appears in the shell summary
 * has changed.
 */
export function shellRelevantLatestTurnChanged(
  prev: OrchestrationThread | null,
  next: OrchestrationThread
): boolean {
  if (!prev) return true
  const pl = prev.latestTurn
  const nl = next.latestTurn
  if (!pl && !nl) return false
  if (!pl || !nl) return true
  return pl.id !== nl.id || pl.status !== nl.status
}

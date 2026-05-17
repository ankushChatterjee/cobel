/**
 * Event coalescing
 *
 * Merges adjacent high-frequency orchestration events before they are applied
 * to the reducer, following dpcode/t3code `coalesceOrchestrationUiEvents`
 * semantics. This reduces the number of reducer calls and React re-renders
 * during streaming without losing any information.
 *
 * Coalescing rules:
 * 1. Adjacent `thread.message-upserted` events for the **same message id** are
 *    merged into a single event with the later sequence and updatedAt, and the
 *    text concatenated (streaming message segments).
 * 2. Adjacent `thread.active-turn-set` events with the **same phase and
 *    visibleIndicator** are deduplicated — only the last one is kept.
 * 3. All other event types are passed through unchanged.
 *
 * "Adjacent" means consecutive in the ordered batch with no other event type
 * in between (for rule 1) or separated only by other active-turn-set events
 * for the same thread (for rule 2).
 */
import type { OrchestrationEvent } from '../../../shared/agent'

/**
 * Coalesce a batch of `OrchestrationEvent`s. Returns a new (possibly shorter)
 * array. The output preserves ordering: all events for a given thread appear
 * in their original relative order.
 */
export function coalesceOrchestrationEvents(
  events: OrchestrationEvent[]
): OrchestrationEvent[] {
  if (events.length <= 1) return events

  const result: OrchestrationEvent[] = []

  for (const event of events) {
    const prev = result[result.length - 1]

    // Rule 1: coalesce adjacent message upserts for the same message id
    if (
      event.type === 'thread.message-upserted' &&
      prev?.type === 'thread.message-upserted' &&
      prev.threadId === event.threadId &&
      prev.message.id === event.message.id &&
      prev.message.role === 'assistant' &&
      prev.message.streaming === true &&
      event.message.streaming === true
    ) {
      result[result.length - 1] = {
        ...event,
        message: {
          ...event.message,
          // Keep the original creation time; take the latest updatedAt and sequence
          createdAt: prev.message.createdAt,
          text: event.message.text // message text already includes full content (not delta)
        }
      }
      continue
    }

    // Rule 2: deduplicate adjacent active-turn-set events with no phase change
    if (
      event.type === 'thread.active-turn-set' &&
      prev?.type === 'thread.active-turn-set' &&
      prev.threadId === event.threadId &&
      activeTurnSurfaceEqual(prev.activeTurn, event.activeTurn)
    ) {
      // Replace the previous with the later sequence (last one wins)
      result[result.length - 1] = event
      continue
    }

    result.push(event)
  }

  return result
}

function activeTurnSurfaceEqual(
  a: import('../../../shared/agent').ActiveTurnProjection | null,
  b: import('../../../shared/agent').ActiveTurnProjection | null
): boolean {
  if (a === null && b === null) return true
  if (!a || !b) return false
  return (
    a.turnId === b.turnId &&
    a.phase === b.phase &&
    a.visibleIndicator === b.visibleIndicator &&
    a.activeItemIds.length === b.activeItemIds.length &&
    a.activeItemIds.every((id, i) => id === b.activeItemIds[i])
  )
}

/**
 * Split a batch of events into "urgent" (should be applied immediately for
 * perceived responsiveness) and "deferrable" (can be batched with a small
 * trailing throttle).
 *
 * Urgent events:
 * - First visible assistant text (streaming = true + non-empty text)
 * - Approval/user-input requests
 * - Session state errors
 * - Turn completions
 */
export function classifyEventUrgency(event: OrchestrationEvent): 'urgent' | 'deferrable' {
  switch (event.type) {
    case 'thread.session-set':
      if (
        event.session?.status === 'error' ||
        event.session?.status === 'stopped' ||
        event.session?.status === 'running'
      ) {
        return 'urgent'
      }
      return 'deferrable'

    case 'thread.latest-turn-set':
      if (
        event.latestTurn?.status === 'completed' ||
        event.latestTurn?.status === 'failed' ||
        event.latestTurn?.status === 'interrupted'
      ) {
        return 'urgent'
      }
      return 'deferrable'

    case 'thread.activity-upserted':
      if (
        event.activity.kind === 'approval.requested' ||
        event.activity.kind === 'user-input.requested'
      ) {
        return 'urgent'
      }
      return 'deferrable'

    case 'thread.message-upserted':
      // First assistant message chunk is urgent for perceived responsiveness
      if (event.message.role === 'assistant' && event.message.streaming) {
        return 'urgent'
      }
      return 'deferrable'

    case 'thread.snapshot.changed':
      return 'urgent'

    default:
      return 'deferrable'
  }
}

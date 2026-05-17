/**
 * Orchestration event effects
 *
 * Derives non-reducer side effects from a batch of `OrchestrationEvent`s.
 * These are effects that should happen once per batch after the reducer has
 * been applied, rather than being scattered through individual event handlers.
 *
 * Examples:
 * - Clear the composer draft when a turn completes.
 * - Trigger workspace diff refresh when file edits are applied.
 * - Invalidate provider status when a session error occurs.
 * - Remove the active-thread selection when a thread is deleted.
 *
 * The effects are returned as a plain data object so they can be tested
 * without side effects in unit tests, and applied by the caller (typically
 * `HomePage`) in a single `useEffect` block.
 */
import type { OrchestrationEvent } from '../../../shared/agent'

export interface BatchEventEffects {
  /** Thread id whose composer draft should be cleared (turn completed). */
  clearComposerDraftForThreadId: string | null
  /** True if workspace diff should be refreshed (file edits applied). */
  refreshWorkspaceDiff: boolean
  /** Thread ids whose detail subscriptions should be evicted (thread deleted). */
  evictThreadDetailIds: string[]
  /** True if provider status should be invalidated (session error). */
  invalidateProviderStatus: boolean
}

export function createEmptyBatchEffects(): BatchEventEffects {
  return {
    clearComposerDraftForThreadId: null,
    refreshWorkspaceDiff: false,
    evictThreadDetailIds: [],
    invalidateProviderStatus: false
  }
}

/**
 * Derive batch effects from a list of `OrchestrationEvent`s received in a
 * single stream batch. The effects are accumulated — multiple events can
 * contribute to the same effect flag.
 */
export function deriveEventBatchEffects(
  events: OrchestrationEvent[],
  activeThreadId: string | null
): BatchEventEffects {
  const effects = createEmptyBatchEffects()

  for (const event of events) {
    switch (event.type) {
      case 'thread.session-set': {
        if (
          event.session?.status === 'error' ||
          event.session?.status === 'stopped'
        ) {
          effects.invalidateProviderStatus = true
        }
        break
      }

      case 'thread.activity-upserted': {
        // File edits applied → refresh workspace diff
        const payload = event.activity?.payload
        if (
          payload &&
          typeof payload === 'object' &&
          'fileEditChanges' in payload &&
          Array.isArray((payload as Record<string, unknown>)['fileEditChanges']) &&
          ((payload as Record<string, unknown>)['fileEditChanges'] as unknown[]).length > 0
        ) {
          effects.refreshWorkspaceDiff = true
        }
        break
      }

      case 'thread.latest-turn-set': {
        // Turn completed → clear composer draft for the active thread
        const turn = event.latestTurn
        if (
          turn &&
          (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') &&
          event.threadId === activeThreadId
        ) {
          effects.clearComposerDraftForThreadId = event.threadId
        }
        break
      }

      case 'thread.deleted': {
        effects.evictThreadDetailIds.push(event.threadId)
        break
      }

      default:
        break
    }
  }

  return effects
}

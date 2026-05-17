/**
 * useThreadStream
 *
 * Encapsulates the thread detail subscription logic extracted from `HomePage`.
 * Returns the current `OrchestrationThread` for the given thread id, handling:
 * - Initial snapshot application
 * - Live event application via `applyThreadStreamEventBatch`
 * - Gap detection and replay requests
 * - Pending user message merging
 *
 * This hook is a "connector": it subscribes to the IPC thread stream and
 * returns derived state for the component to render. No event-folding logic
 * should live in the component itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrchestrationMessage, OrchestrationThread } from '../../../shared/agent'
import {
  applyThreadStreamEvent,
  applyThreadStreamSnapshot,
  createThreadStreamState,
  markReplayApplied,
  resetThreadStreamState
} from '../routes/threadStreamReducer'
import { deriveEventBatchEffects, type BatchEventEffects } from '../store/orchestrationEventEffects'
import { mergePendingUserMessages } from '../components/home/threadUtils'

export interface UseThreadStreamResult {
  thread: OrchestrationThread | null
  pendingUserMessages: Map<string, OrchestrationMessage>
  /** Optimistically update the thread state (e.g. for pending user messages). */
  updateThread: (updater: (current: OrchestrationThread | null) => OrchestrationThread | null) => void
  /** Last applied event sequence — used for optimistic message sequencing. */
  lastAppliedSequence: number
}

/**
 * Subscribes to the thread stream for `activeThreadId`. Returns the latest
 * thread state, applying snapshots and events through the stream reducer.
 *
 * `onBatchEffects` is called after each batch of events with derived side
 * effects (workspace diff refresh, composer draft clear, etc.).
 */
export function useThreadStream(
  activeThreadId: string | null,
  onBatchEffects?: (effects: BatchEventEffects) => void
): UseThreadStreamResult {
  const [thread, setThread] = useState<OrchestrationThread | null>(null)
  const streamStateRef = useRef(createThreadStreamState())
  const pendingUserMessagesRef = useRef(new Map<string, OrchestrationMessage>())
  const onBatchEffectsRef = useRef(onBatchEffects)
  onBatchEffectsRef.current = onBatchEffects

  const updateThread = useCallback(
    (updater: (current: OrchestrationThread | null) => OrchestrationThread | null) => {
      setThread((current) => {
        const next = updater(current)
        if (next) streamStateRef.current.thread = next
        return next
      })
    },
    []
  )

  const commitThread = useCallback((nextThread: OrchestrationThread): void => {
    setThread(nextThread)
  }, [])

  useEffect(() => {
    if (!activeThreadId) {
      setThread(null)
      return undefined
    }

    resetThreadStreamState(streamStateRef.current)
    pendingUserMessagesRef.current.clear()
    let replayInFlight = false
    let disposed = false

    const requestReplay = (fromSequenceExclusive: number): void => {
      if (replayInFlight || disposed || !window.agentApi.replayThreadEvents) return
      replayInFlight = true
      void window.agentApi
        .replayThreadEvents({ threadId: activeThreadId, fromSequenceExclusive })
        .then((events) => {
          if (disposed || events.length === 0) return
          const result = markReplayApplied(streamStateRef.current, events)
          if (result) commitThread(result.thread)
        })
        .catch((error) => {
          console.error('[useThreadStream] Failed to replay thread events', error)
        })
        .finally(() => {
          replayInFlight = false
        })
    }

    const unsubscribe = window.agentApi.subscribeThread({ threadId: activeThreadId }, (item) => {
      if (item.kind === 'snapshot') {
        const mergedThread = mergePendingUserMessages(
          item.snapshot.thread,
          pendingUserMessagesRef.current
        )
        const result = applyThreadStreamSnapshot(streamStateRef.current, {
          ...item.snapshot,
          thread: mergedThread
        })
        commitThread(result.thread)
        return
      }

      const { event } = item
      // Clear optimistic user message when the server confirms it
      if (event.type === 'thread.message-upserted') {
        pendingUserMessagesRef.current.delete(event.message.id)
      }

      const result = applyThreadStreamEvent(streamStateRef.current, event)
      commitThread(result.thread)

      // Derive and surface batch effects
      if (onBatchEffectsRef.current) {
        const effects = deriveEventBatchEffects([event], activeThreadId)
        onBatchEffectsRef.current(effects)
      }

      if (result.gapFromSequence !== null) requestReplay(result.gapFromSequence)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [activeThreadId, commitThread])

  return {
    thread,
    pendingUserMessages: pendingUserMessagesRef.current,
    updateThread,
    lastAppliedSequence: streamStateRef.current.lastAppliedSequence
  }
}

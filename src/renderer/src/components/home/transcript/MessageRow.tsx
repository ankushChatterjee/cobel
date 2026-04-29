import { ChevronDown } from 'lucide-react'
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { OrchestrationCheckpointSummary, OrchestrationMessage, CheckpointFileChange, OrchestrationThreadActivity } from '../../../../../shared/agent'
import { readPayloadString } from '../activityUtils'
import { ChangedFilePills } from '../../diff/DiffReview'
import { MarkdownMessage } from '../MarkdownMessage'
import { formatTime, formatWorkDuration } from '../formatUtils'
import type { OnOpenDiff, OnPreviewDiff } from '../types'

function combinedReasoningText(activities: OrchestrationThreadActivity[]): string {
  const parts: string[] = []
  for (const a of activities) {
    const t = readPayloadString(a.payload, 'reasoningText')
    if (t && t.trim().length > 0) {
      parts.push(t.trim())
    }
  }
  return parts.join('\n\n')
}

export const ThinkingRow = memo(function ThinkingRow({
  activities,
  activeTurnId,
  turnInProgress,
  latestTurnId
}: {
  activities: OrchestrationThreadActivity[]
  activeTurnId?: string | null
  turnInProgress?: boolean
  latestTurnId?: string | null
}): React.JSX.Element | null {
  if (activities.length === 0) {
    return null
  }
  const belongsToActiveTurn =
    turnInProgress === true &&
    activeTurnId != null &&
    activities.some((activity) => activity.turnId === activeTurnId)
  const belongsToKnownCompletedTurn =
    turnInProgress !== true &&
    latestTurnId != null &&
    activities.some((activity) => activity.turnId === latestTurnId)
  const isComplete =
    belongsToKnownCompletedTurn ||
    (!belongsToActiveTurn && latestTurnId != null) ||
    activities.every(
      (activity) =>
        activity.resolved === true ||
        activity.kind === 'task.completed' ||
        readPayloadString(activity.payload, 'status') === 'completed'
    )
  const reasoningText = combinedReasoningText(activities)
  const hasReasoningBody = Boolean(reasoningText && reasoningText.trim().length > 0)
  const statusLabel = isComplete ? 'thought' : 'thinking…'
  const contentId = useId()
  const [reasoningExpanded, setReasoningExpanded] = useState(() => !isComplete)
  const reasoningBodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (isComplete) setReasoningExpanded(false)
  }, [isComplete])

  useLayoutEffect(() => {
    if (isComplete || !reasoningExpanded || !reasoningText) return
    const el = reasoningBodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [isComplete, reasoningExpanded, reasoningText])

  if (hasReasoningBody) {
    return (
      <article
        className={`thinking-row ${isComplete ? 'is-complete' : 'is-active'} has-reasoning`}
        aria-label="Model reasoning"
        aria-busy={!isComplete ? true : undefined}
      >
        <button
          type="button"
          className="transcript-reasoning-toggle"
          aria-expanded={reasoningExpanded}
          aria-controls={contentId}
          onClick={() => setReasoningExpanded((open) => !open)}
        >
          {!isComplete ? <span className="thinking-spinner" aria-hidden="true" /> : null}
          <span className="transcript-reasoning-toggle-label">Reasoning</span>
          <ChevronDown
            size={13}
            strokeWidth={1.85}
            className={`transcript-reasoning-chevron${reasoningExpanded ? ' is-open' : ''}`}
            aria-hidden
          />
        </button>
        <div
          id={contentId}
          className={`transcript-reasoning-shell${reasoningExpanded ? ' is-expanded' : ''}`}
        >
          <div className="transcript-reasoning-measure">
            <div ref={reasoningBodyRef} className="transcript-reasoning-body">
              {reasoningText}
            </div>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article
      className={`thinking-row ${isComplete ? 'is-complete' : 'is-active'}`}
      aria-label={isComplete ? 'Thought' : 'Thinking'}
    >
      <span className="thinking-row-status">
        {!isComplete && <span className="thinking-spinner" aria-hidden="true" />}
        <span>{statusLabel}</span>
      </span>
    </article>
  )
})

export const MessageRow = memo(function MessageRow({
  message,
  workDurationMs,
  checkpointSummary,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  message: OrchestrationMessage
  workDurationMs: number | null
  checkpointSummary: OrchestrationCheckpointSummary | null
  onPreviewDiff: OnPreviewDiff
  onOpenDiff: OnOpenDiff
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  const isAssistant = message.role === 'assistant'
  return (
    <article className={`message ${message.role} ${message.streaming ? 'streaming' : ''}`}>
      <div className="message-meta">
        {isAssistant ? (
          <>
            <span>worked for</span>
            <span>{formatWorkDuration(workDurationMs)}</span>
          </>
        ) : (
          <>
            <span>you</span>
            <span>{formatTime(message.createdAt)}</span>
          </>
        )}
      </div>
      {isAssistant ? (
        <>
          <MarkdownMessage text={message.text} isStreaming={message.streaming} />
          {checkpointSummary ? (
            <ChangedFilePills
              summary={checkpointSummary}
              onPreview={(file: CheckpointFileChange, rect: DOMRect) => onPreviewDiff(checkpointSummary, file, rect)}
              onOpenDiff={(filePath?: string) => onOpenDiff(checkpointSummary.turnId, filePath)}
              revertTurnCount={
                checkpointSummary.status === 'ready'
                  ? Math.max(0, checkpointSummary.checkpointTurnCount - 1)
                  : null
              }
              onRevert={onRevert}
            />
          ) : null}
        </>
      ) : (
        <p>{message.text}</p>
      )}
    </article>
  )
})

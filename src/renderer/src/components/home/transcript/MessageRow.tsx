import { memo } from 'react'
import type { OrchestrationCheckpointSummary, OrchestrationMessage, CheckpointFileChange, OrchestrationThreadActivity } from '../../../../../shared/agent'
import { ChangedFilePills } from '../../diff/DiffReview'
import { MarkdownMessage } from '../MarkdownMessage'
import { formatTime, formatWorkDuration } from '../formatUtils'
import type { OnOpenDiff, OnPreviewDiff } from '../types'

export const ThinkingRow = memo(function ThinkingRow({
  activity
}: {
  activity: OrchestrationThreadActivity
}): React.JSX.Element {
  const isComplete = activity.resolved === true
  return (
    <article
      className={`thinking-row ${isComplete ? 'is-complete' : 'is-active'}`}
      aria-label={isComplete ? 'Thought' : 'Thinking'}
    >
      {!isComplete && <span className="thinking-spinner" aria-hidden="true" />}
      <span>{isComplete ? 'thought' : 'thinking…'}</span>
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

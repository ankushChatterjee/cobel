import { ChevronDown } from 'lucide-react'
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  ChatAttachment,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  CheckpointFileChange,
  OrchestrationThreadActivity
} from '../../../../../shared/agent'
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

function attachmentCountLabel(count: number): string {
  return count === 1 ? '1 attachment' : `${count} attachments`
}

function isReasoningTerminal(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.resolved === true ||
    activity.kind === 'task.completed' ||
    readPayloadString(activity.payload, 'status') === 'completed'
  )
}

export const ThinkingRow = memo(function ThinkingRow({
  activities,
  turnInProgress = false
}: {
  activities: OrchestrationThreadActivity[]
  /** When false, reasoning rows are treated as finished (collapsed) for replay / idle UI. */
  turnInProgress?: boolean
}): React.JSX.Element | null {
  if (activities.length === 0) {
    return null
  }

  const allTerminal = activities.every(isReasoningTerminal)
  const isComplete = !turnInProgress || allTerminal

  const reasoningText = combinedReasoningText(activities)
  const hasReasoningBody = reasoningText.trim().length > 0
  // Item-only reasoning (e.g. Codex) often has no `reasoning_text` deltas — show a spinner since the stream carries no text.
  const showReasoningHeaderSpinner = !isComplete && !hasReasoningBody
  const contentId = useId()
  const reasoningBodyRef = useRef<HTMLDivElement | null>(null)
  const [userExpandedAfterComplete, setUserExpandedAfterComplete] = useState(false)

  useEffect(() => {
    if (isComplete) setUserExpandedAfterComplete(false)
  }, [isComplete])

  // Open while streaming; after streaming ends, stay collapsed until the user expands again.
  const expanded = !isComplete || userExpandedAfterComplete

  useLayoutEffect(() => {
    if (isComplete || !expanded) return
    const el = reasoningBodyRef.current
    if (!el || !reasoningText.trim()) return
    el.scrollTop = el.scrollHeight
  }, [isComplete, expanded, reasoningText])

  return (
    <article
      className={`thinking-row ${isComplete ? 'is-complete' : 'is-active'} has-reasoning`}
      aria-label="Model reasoning"
      aria-busy={!isComplete ? true : undefined}
    >
      <button
        type="button"
        className="transcript-reasoning-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => {
          if (isComplete) setUserExpandedAfterComplete((open) => !open)
        }}
      >
        {showReasoningHeaderSpinner ? (
          <span className="thinking-spinner" aria-hidden="true" />
        ) : null}
        <span className="transcript-reasoning-toggle-label">Reasoning</span>
        <ChevronDown
          size={13}
          strokeWidth={1.85}
          className={`transcript-reasoning-chevron${expanded ? ' is-open' : ''}`}
          aria-hidden
        />
      </button>
      <div
        id={contentId}
        className={`transcript-reasoning-shell${expanded ? ' is-expanded' : ''}`}
      >
        <div className="transcript-reasoning-measure">
          <div ref={reasoningBodyRef} className="transcript-reasoning-body">
            {reasoningText}
          </div>
        </div>
      </div>
    </article>
  )
})

export const MessageRow = memo(function MessageRow({
  message,
  workDurationMs,
  checkpointSummary,
  onOpenPlan,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  message: OrchestrationMessage
  workDurationMs: number | null
  checkpointSummary: OrchestrationCheckpointSummary | null
  onOpenPlan: (planId: string) => void
  onPreviewDiff: OnPreviewDiff
  onOpenDiff: OnOpenDiff
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  const isAssistant = message.role === 'assistant'
  const userAttachmentCount = !isAssistant ? (message.attachments?.length ?? 0) : 0
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
          {message.text.trim().length > 0 ? (
            <MarkdownMessage text={message.text} isStreaming={message.streaming} />
          ) : null}
          <MessageAttachments attachments={message.attachments} onOpenPlan={onOpenPlan} />
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
        <div className="message-user-bubble">
          {userAttachmentCount > 0 ? (
            <div className="message-user-attachments" aria-label={attachmentCountLabel(userAttachmentCount)}>
              <span className="message-user-attachment-dot" aria-hidden="true" />
              <span>{attachmentCountLabel(userAttachmentCount)}</span>
            </div>
          ) : null}
          <p>{message.text}</p>
        </div>
      )}
    </article>
  )
})

const MessageAttachments = memo(function MessageAttachments({
  attachments,
  onOpenPlan
}: {
  attachments: ChatAttachment[] | undefined
  onOpenPlan: (planId: string) => void
}): React.JSX.Element | null {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => {
        if (attachment.type === 'image') {
          return (
            <img
              key={attachment.url}
              className="message-image-attachment"
              src={attachment.url}
              alt=""
            />
          )
        }
        return (
          <button
            key={attachment.planId}
            type="button"
            className={`message-plan-attachment ${attachment.status === 'streaming' ? 'is-updating' : ''}`}
            onClick={() => onOpenPlan(attachment.planId)}
          >
            <span className="message-plan-attachment-label">Plan</span>
            <strong>{attachment.title}</strong>
            <span className="message-plan-attachment-meta">
              {attachment.status === 'streaming' ? (
                <>
                  <span className="thinking-spinner" aria-hidden="true" />
                  <span>Updating…</span>
                </>
              ) : (
                'Open in sidebar'
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
})

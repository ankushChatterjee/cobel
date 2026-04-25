import { memo, useMemo } from 'react'
import type { OrchestrationCheckpointSummary } from '../../../../../shared/agent'
import { groupTranscriptItems } from '../threadUtils'
import type { ApprovalDecision, OnAnswer, OnApprove, OnOpenDiff, OnPreviewDiff, TranscriptItem } from '../types'
import { ToolGroup } from './ToolGroup'
import { ToolLine } from './ToolLine'
import { TranscriptRow } from './TranscriptRow'

export const TranscriptList = memo(function TranscriptList({
  items,
  showPendingThinking,
  expandedToolIds,
  submittingApprovals,
  checkpointByAssistantMessageId,
  onToggleTool,
  onApprove,
  onAnswer,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  items: TranscriptItem[]
  showPendingThinking: boolean
  expandedToolIds: Set<string>
  submittingApprovals: Map<string, ApprovalDecision>
  checkpointByAssistantMessageId: Map<string, OrchestrationCheckpointSummary>
  onToggleTool: (activityId: string) => void
  onApprove: OnApprove
  onAnswer: OnAnswer
  onPreviewDiff: OnPreviewDiff
  onOpenDiff: OnOpenDiff
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  const groups = useMemo(() => groupTranscriptItems(items), [items])
  return (
    <div className="transcript" aria-label="Conversation transcript">
      {groups.map((group) => {
        if (group.kind === 'non-tool') {
          return (
            <TranscriptRow
              key={group.item.id}
              item={group.item}
              submittingApprovals={submittingApprovals}
              checkpointByAssistantMessageId={checkpointByAssistantMessageId}
              onApprove={onApprove}
              onAnswer={onAnswer}
              onPreviewDiff={onPreviewDiff}
              onOpenDiff={onOpenDiff}
              onRevert={onRevert}
            />
          )
        }
        const { id, activities } = group
        if (activities.length === 1) {
          const single = activities[0]
          return (
            <ToolLine
              key={single.id}
              activity={single.activity}
              expanded={expandedToolIds.has(single.activity.id)}
              onToggle={() => onToggleTool(single.activity.id)}
            />
          )
        }
        return (
          <ToolGroup
            key={id}
            activities={activities}
            expandedToolIds={expandedToolIds}
            onToggleTool={onToggleTool}
          />
        )
      })}
      {showPendingThinking && (
        <article className="thinking-row is-active" aria-label="Thinking">
          <span className="thinking-spinner" aria-hidden="true" />
          <span>thinking…</span>
        </article>
      )}
    </div>
  )
})

import { memo } from 'react'
import type { OrchestrationCheckpointSummary } from '../../../../../shared/agent'
import { isPendingPrompt, isRuntimeError, isThinkingActivity } from '../activityUtils'
import type { ApprovalDecision, OnAnswer, OnApprove, OnOpenDiff, OnPreviewDiff, TranscriptItem } from '../types'
import { ActivityRow } from './ActivityRow'
import { MessageRow, ThinkingRow } from './MessageRow'
import { PendingPrompt } from './PendingPrompt'
import { SessionErrorBanner } from './SessionErrorBanner'

export const TranscriptRow = memo(function TranscriptRow({
  item,
  activeTurnId,
  turnInProgress,
  latestTurnId,
  submittingApprovals,
  checkpointByAssistantMessageId,
  onApprove,
  onAnswer,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  item: TranscriptItem
  activeTurnId: string | null
  turnInProgress: boolean
  latestTurnId: string | null
  submittingApprovals: Map<string, ApprovalDecision>
  checkpointByAssistantMessageId: Map<string, OrchestrationCheckpointSummary>
  onApprove: OnApprove
  onAnswer: OnAnswer
  onPreviewDiff: OnPreviewDiff
  onOpenDiff: OnOpenDiff
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element | null {
  if (item.kind === 'message') {
    return (
      <MessageRow
        message={item.message}
        workDurationMs={item.workDurationMs}
        checkpointSummary={checkpointByAssistantMessageId.get(item.message.id) ?? null}
        onPreviewDiff={onPreviewDiff}
        onOpenDiff={onOpenDiff}
        onRevert={onRevert}
      />
    )
  }

  const { activity } = item
  if (isPendingPrompt(activity)) {
    return (
      <PendingPrompt
        activity={activity}
        submittingDecision={submittingApprovals.get(activity.id) ?? null}
        onApprove={onApprove}
        onAnswer={onAnswer}
      />
    )
  }
  if (activity.kind === 'approval.resolved') {
    return null
  }
  if (isThinkingActivity(activity)) {
    return (
      <ThinkingRow
        activities={[activity]}
        activeTurnId={activeTurnId}
        turnInProgress={turnInProgress}
        latestTurnId={latestTurnId}
      />
    )
  }
  if (isRuntimeError(activity)) {
    return <SessionErrorBanner message={activity.summary} />
  }
  return <ActivityRow activity={activity} />
})

import { memo } from 'react'
import type { OrchestrationCheckpointSummary } from '../../../../../shared/agent'
import { isRuntimeError, isThinkingActivity } from '../activityUtils'
import type {
  OnOpenDiff,
  OnOpenPlan,
  OnPreviewDiff,
  TranscriptItem
} from '../types'
import { ActivityRow } from './ActivityRow'
import { MessageRow, ThinkingRow } from './MessageRow'
import { SessionErrorBanner } from './SessionErrorBanner'

export const TranscriptRow = memo(function TranscriptRow({
  item,
  turnInProgress,
  checkpointByAssistantMessageId,
  onOpenPlan,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  item: TranscriptItem
  turnInProgress: boolean
  checkpointByAssistantMessageId: Map<string, OrchestrationCheckpointSummary>
  onOpenPlan: OnOpenPlan
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
        onOpenPlan={onOpenPlan}
        onPreviewDiff={onPreviewDiff}
        onOpenDiff={onOpenDiff}
        onRevert={onRevert}
      />
    )
  }

  const { activity } = item
  if (activity.kind === 'approval.resolved') {
    return null
  }
  if (isThinkingActivity(activity)) {
    return <ThinkingRow activities={[activity]} turnInProgress={turnInProgress} />
  }
  if (isRuntimeError(activity)) {
    return <SessionErrorBanner message={activity.summary} />
  }
  return <ActivityRow activity={activity} />
})

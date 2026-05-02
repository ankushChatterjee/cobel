import { memo, useMemo } from 'react'
import type { OrchestrationCheckpointSummary, ProviderId } from '../../../../../shared/agent'
import { groupTranscriptItems } from '../threadUtils'
import type {
  OnOpenDiff,
  OnOpenPlan,
  OnPreviewDiff,
  TranscriptItem
} from '../types'
import { ThinkingRow } from './MessageRow'
import { ToolGroup } from './ToolGroup'
import { ToolLine } from './ToolLine'
import { TranscriptRow } from './TranscriptRow'

export const TranscriptList = memo(function TranscriptList({
  items,
  showPendingThinking,
  turnInProgress,
  activeTurnId,
  latestTurnId,
  providerName,
  expandedToolIds,
  checkpointByAssistantMessageId,
  onOpenPlan,
  onToggleTool,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  items: TranscriptItem[]
  showPendingThinking: boolean
  turnInProgress: boolean
  activeTurnId: string | null
  latestTurnId: string | null
  providerName: ProviderId | null
  expandedToolIds: Set<string>
  checkpointByAssistantMessageId: Map<string, OrchestrationCheckpointSummary>
  onOpenPlan: OnOpenPlan
  onToggleTool: (activityId: string) => void
  onPreviewDiff: OnPreviewDiff
  onOpenDiff: OnOpenDiff
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  const groups = useMemo(() => groupTranscriptItems(items, providerName), [items, providerName])
  return (
    <div className="transcript" aria-label="Conversation transcript">
      {groups.map((group, index) => {
        const isLatestGroup = index === groups.length - 1
        if (group.kind === 'non-tool') {
          return (
            <TranscriptRow
              key={group.item.id}
              item={group.item}
              activeTurnId={activeTurnId}
              turnInProgress={turnInProgress}
              latestTurnId={latestTurnId}
              checkpointByAssistantMessageId={checkpointByAssistantMessageId}
              onOpenPlan={onOpenPlan}
              onPreviewDiff={onPreviewDiff}
              onOpenDiff={onOpenDiff}
              onRevert={onRevert}
            />
          )
        }
        if (group.kind === 'reasoning-run') {
          return (
            <ThinkingRow
              key={group.id}
              activities={group.activities.map((item) => item.activity)}
              activeTurnId={activeTurnId}
              turnInProgress={turnInProgress}
              latestTurnId={latestTurnId}
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
            turnInProgress={turnInProgress}
            isLatestGroup={isLatestGroup}
            expandedToolIds={expandedToolIds}
            onToggleTool={onToggleTool}
          />
        )
      })}
      {showPendingThinking && (
        <article className="thinking-row is-active" aria-label="Exploring">
          <span className="thinking-spinner" aria-hidden="true" />
          <span>Exploring</span>
        </article>
      )}
    </div>
  )
})

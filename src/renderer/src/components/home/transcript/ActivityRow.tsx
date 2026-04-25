import { memo } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { OrchestrationThreadActivity } from '../../../../../shared/agent'
import { labelForActivity } from '../activityUtils'

export const ActivityRow = memo(function ActivityRow({
  activity
}: {
  activity: OrchestrationThreadActivity
}): React.JSX.Element {
  if (activity.kind === 'runtime.warning') {
    return (
      <article className="activity-row warning" aria-label="Warning">
        <span className="activity-row-icon" aria-hidden="true">
          <TriangleAlert size={11} strokeWidth={2.1} />
        </span>
        <p className="activity-row-warning-message">{activity.summary}</p>
      </article>
    )
  }

  return (
    <article className={`activity-row ${activity.tone}`}>
      <span>{labelForActivity(activity)}</span>
      <code>{activity.summary}</code>
    </article>
  )
})

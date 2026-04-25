import { memo } from 'react'
import type { OrchestrationThreadActivity } from '../../../../../shared/agent'
import { EmbeddedDiffView } from '../../diff/DiffReview'
import {
  extractFileChangeDiff,
  labelForApproval,
  readQuestions,
  resolvedApprovalLabel
} from '../activityUtils'
import type { ApprovalDecision, OnAnswer, OnApprove } from '../types'

export const ApprovalActions = memo(function ApprovalActions({
  activity,
  submittingDecision,
  onApprove
}: {
  activity: OrchestrationThreadActivity
  submittingDecision: ApprovalDecision | null
  onApprove: OnApprove
}): React.JSX.Element {
  const disabled = submittingDecision !== null
  return (
    <div className="prompt-actions approval-actions">
      <button
        type="button"
        className="approval-action accept"
        disabled={disabled}
        onClick={() => void onApprove(activity, 'accept')}
      >
        {submittingDecision === 'accept' ? <span className="button-spinner" /> : null}
        approve
      </button>
      <button
        type="button"
        className="approval-action decline"
        disabled={disabled}
        onClick={() => void onApprove(activity, 'decline')}
      >
        {submittingDecision === 'decline' ? <span className="button-spinner" /> : null}
        decline
      </button>
    </div>
  )
})

export const ApprovalResolutionLine = memo(function ApprovalResolutionLine({
  activity
}: {
  activity: OrchestrationThreadActivity
}): React.JSX.Element {
  return (
    <article className="approval-resolution-line" aria-label={resolvedApprovalLabel(activity)}>
      <span>{resolvedApprovalLabel(activity)}</span>
    </article>
  )
})

export const PendingPrompt = memo(function PendingPrompt({
  activity,
  submittingDecision,
  onApprove,
  onAnswer
}: {
  activity: OrchestrationThreadActivity
  submittingDecision: ApprovalDecision | null
  onApprove: OnApprove
  onAnswer: OnAnswer
}): React.JSX.Element {
  const questions = readQuestions(activity)
  const fileChange = extractFileChangeDiff(activity.payload)
  const isApproval = activity.kind.includes('approval')
  const isResolved = activity.kind === 'approval.resolved' || activity.resolved === true
  const requestLabel = labelForApproval(activity)

  if (isApproval && fileChange) {
    return (
      <EmbeddedDiffView
        diff={fileChange.diff}
        title={fileChange.title}
        compactTitle
        status={<span>{isResolved ? resolvedApprovalLabel(activity) : requestLabel}</span>}
        actions={
          !isResolved ? (
            <ApprovalActions
              activity={activity}
              submittingDecision={submittingDecision}
              onApprove={onApprove}
            />
          ) : null
        }
      />
    )
  }

  if (isApproval) {
    return (
      <div className={`pending-prompt approval-prompt ${isResolved ? 'resolved' : ''}`}>
        <span>{isResolved ? resolvedApprovalLabel(activity) : requestLabel}</span>
        <p>{activity.summary}</p>
        {!isResolved ? (
          <ApprovalActions
            activity={activity}
            submittingDecision={submittingDecision}
            onApprove={onApprove}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="pending-prompt input-prompt">
      <span>input</span>
      <p>{activity.summary}</p>
      <div className="prompt-actions">
        {(questions[0]?.options ?? []).slice(0, 3).map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => void onAnswer(activity, { [questions[0].id]: option.label })}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
})

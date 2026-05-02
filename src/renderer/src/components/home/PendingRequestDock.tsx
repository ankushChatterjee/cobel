import { CornerDownLeft } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { EmbeddedDiffView } from '../diff/DiffReview'
import type { ApprovalDecision, OnAnswer, OnApprove, PendingRequestViewModel } from './types'

const APPROVAL_ACTIONS: Array<{
  decision: ApprovalDecision
  label: string
  shortcut: string
  className: string
}> = [
  { decision: 'accept', label: 'Approve', shortcut: 'A', className: 'is-primary' },
  {
    decision: 'acceptForSession',
    label: 'Allow for session',
    shortcut: 'S',
    className: 'is-secondary'
  },
  { decision: 'decline', label: 'Decline', shortcut: 'D', className: 'is-danger' }
]

export const PendingRequestDock = memo(function PendingRequestDock({
  request,
  queueIndex,
  queueCount,
  submittingDecision,
  submittingInput,
  autoFocus,
  onApprove,
  onAnswer,
  onDismissFocus
}: {
  request: PendingRequestViewModel
  queueIndex: number
  queueCount: number
  submittingDecision: ApprovalDecision | null
  submittingInput: boolean
  autoFocus: boolean
  onApprove: OnApprove
  onAnswer: OnAnswer
  onDismissFocus: () => void
}): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const rootRef = useRef<HTMLElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const approvalActionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0)
  const [focusedApprovalActionIndex, setFocusedApprovalActionIndex] = useState(0)
  const question = request.questions[0] ?? null
  const selectedOption = question?.options[selectedOptionIndex] ?? null
  const queueLabel = queueCount > 1 ? `${queueIndex + 1} of ${queueCount}` : null
  const disabled = request.kind === 'approval' ? submittingDecision !== null : submittingInput

  const title = useMemo(() => {
    if (request.kind === 'input' && question) {
      return question.question
    }
    return request.summary
  }, [question, request.kind, request.summary])

  const secondaryLine = useMemo(() => {
    if (request.kind === 'input') {
      const summary = request.summary.trim()
      return summary && summary !== title ? summary : null
    }
    return request.requestLabel !== request.summary
      ? `${request.requestTypeLabel} · ${request.summary}`
      : request.requestTypeLabel
  }, [request.kind, request.requestLabel, request.requestTypeLabel, request.summary, title])

  useEffect(() => {
    setSelectedOptionIndex(0)
    setFocusedApprovalActionIndex(0)
  }, [request.activity.id])

  useEffect(() => {
    if (!autoFocus) return
    const frame = window.requestAnimationFrame(() => {
      if (request.kind === 'input' && question?.options.length) {
        optionRefs.current[0]?.focus()
        return
      }
      if (request.kind === 'approval') {
        approvalActionRefs.current[0]?.focus()
        return
      }
      rootRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [autoFocus, question?.options.length, request.activity.id, request.kind])

  const submitQuestion = (optionIndex = selectedOptionIndex): void => {
    const option = question?.options[optionIndex]
    if (!question || !option || disabled) return
    setSelectedOptionIndex(optionIndex)
    void onAnswer(request.activity, { [question.id]: option.label })
  }

  const submitApproval = (decision: ApprovalDecision): void => {
    if (disabled) return
    void onApprove(request.activity, decision)
  }

  const moveQuestionSelection = (direction: 1 | -1): void => {
    if (!question || question.options.length === 0) return
    const nextIndex =
      (selectedOptionIndex + direction + question.options.length) % question.options.length
    setSelectedOptionIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }

  const moveApprovalActionFocus = (direction: 1 | -1): void => {
    const nextIndex =
      (focusedApprovalActionIndex + direction + APPROVAL_ACTIONS.length) % APPROVAL_ACTIONS.length
    setFocusedApprovalActionIndex(nextIndex)
    approvalActionRefs.current[nextIndex]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismissFocus()
      return
    }

    if (request.kind === 'input') {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveQuestionSelection(1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveQuestionSelection(-1)
        return
      }
      if (/^[1-9]$/u.test(event.key)) {
        const nextIndex = Number(event.key) - 1
        if (!question || nextIndex >= question.options.length) return
        event.preventDefault()
        setSelectedOptionIndex(nextIndex)
        optionRefs.current[nextIndex]?.focus()
        return
      }
      if (event.key === 'Enter') {
        const target = event.target as HTMLElement | null
        if (target?.closest('button[data-dismiss-focus="true"]')) return
        event.preventDefault()
        submitQuestion()
      }
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveApprovalActionFocus(1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveApprovalActionFocus(-1)
      return
    }
    if (event.key === 'Tab') {
      const target = event.target as HTMLElement | null
      if (target?.closest('.pending-request-approval-actions')) {
        event.preventDefault()
        moveApprovalActionFocus(event.shiftKey ? -1 : 1)
      }
      return
    }
    if (event.key === 'Enter') {
      const target = event.target as HTMLElement | null
      if (target?.closest('button[data-dismiss-focus="true"]')) return
      event.preventDefault()
      submitApproval(APPROVAL_ACTIONS[focusedApprovalActionIndex]?.decision ?? 'accept')
      return
    }
    if (event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setFocusedApprovalActionIndex(0)
      submitApproval('accept')
      return
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      setFocusedApprovalActionIndex(1)
      submitApproval('acceptForSession')
      return
    }
    if (event.key.toLowerCase() === 'd') {
      event.preventDefault()
      setFocusedApprovalActionIndex(2)
      submitApproval('decline')
    }
  }

  return (
    <section
      ref={rootRef}
      className="pending-request-dock"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="pending-request-head">
        {question?.header ? (
          <p className="pending-request-header">
            {question.header}
            {queueLabel ? <span className="pending-request-queue-label">{queueLabel}</span> : null}
          </p>
        ) : queueLabel ? (
          <p className="pending-request-header">{queueLabel}</p>
        ) : null}
        <h2 id={titleId}>{title}</h2>
        {secondaryLine ? (
          <p id={descriptionId} className="pending-request-summary">
            {secondaryLine}
          </p>
        ) : null}
      </div>

      {request.fileChange ? (
        <div className="pending-request-diff-shell">
          <EmbeddedDiffView diff={request.fileChange.diff} title={request.fileChange.title} compactTitle />
        </div>
      ) : null}

      {request.kind === 'input' && question ? (
        <div className="pending-request-option-list" role="listbox" aria-label={question.question}>
          {question.options.map((option, index) => {
            const active = index === selectedOptionIndex
            return (
              <button
                key={`${question.id}:${option.label}:${index}`}
                ref={(node) => {
                  optionRefs.current[index] = node
                }}
                type="button"
                role="option"
                aria-selected={active}
                className={`pending-request-option${active ? ' is-active' : ''}`}
                disabled={disabled}
                onClick={() => submitQuestion(index)}
                onFocus={() => setSelectedOptionIndex(index)}
              >
                <span className="pending-request-option-index">{index + 1}.</span>
                <span className="pending-request-option-copy">
                  <span className="pending-request-option-label">{option.label}</span>
                  {option.description ? (
                    <span className="pending-request-option-description">{option.description}</span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="pending-request-footer">
        <button
          type="button"
          className="pending-request-dismiss"
          data-dismiss-focus="true"
          onClick={onDismissFocus}
        >
          Dismiss
          <kbd>Esc</kbd>
        </button>

        {request.kind === 'input' ? (
          <button
            type="button"
            className="pending-request-submit"
            aria-label="Submit"
            title="Submit (Enter)"
            disabled={!selectedOption || disabled}
            onClick={() => submitQuestion()}
          >
            {submittingInput ? <span className="button-spinner" /> : null}
            {!submittingInput ? <CornerDownLeft size={14} strokeWidth={2} aria-hidden="true" /> : null}
          </button>
        ) : (
          <div className="pending-request-approval-actions" role="group" aria-label="Approval actions">
            {APPROVAL_ACTIONS.map((action, index) => {
              const isBusy = submittingDecision === action.decision
              const isFocused = index === focusedApprovalActionIndex
              return (
                <button
                  key={action.decision}
                  ref={(node) => {
                    approvalActionRefs.current[index] = node
                  }}
                  type="button"
                  className={`pending-request-approval-action ${action.className}${isFocused ? ' is-focused' : ''}`}
                  disabled={disabled}
                  onClick={() => submitApproval(action.decision)}
                  onFocus={() => setFocusedApprovalActionIndex(index)}
                >
                  {isBusy ? <span className="button-spinner" /> : null}
                  <span>{action.label}</span>
                  <kbd>{action.shortcut}</kbd>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
})

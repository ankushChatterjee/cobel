import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { GitCommitHorizontal, RotateCcw, TriangleAlert } from 'lucide-react'

export function RevertWarningDialog({
  turnCount,
  workspacePath,
  onCancel,
  onConfirm
}: {
  turnCount: number | null
  workspacePath: string | null
  onCancel: () => void
  onConfirm: (turnCount: number) => void
}): React.JSX.Element | null {
  useEffect(() => {
    if (turnCount === null) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, turnCount])

  if (turnCount === null) return null

  return (
    <div className="revert-warning-layer" role="presentation">
      <button
        type="button"
        className="revert-warning-scrim"
        aria-label="Cancel revert"
        onClick={onCancel}
      />
      <section
        className="revert-warning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="revert-warning-title"
        aria-describedby="revert-warning-description"
      >
        <div className="revert-warning-icon" aria-hidden="true">
          <TriangleAlert size={15} strokeWidth={2} />
        </div>
        <div className="revert-warning-copy">
          <p className="revert-warning-kicker">Checkpoint {turnCount}</p>
          <h2 id="revert-warning-title">Restore files to this snapshot?</h2>
          <p id="revert-warning-description">
            This only changes files in the worktree. The chat history stays intact, but the restore
            can overwrite or remove changes made by another thread, by you, or by tools since this
            checkpoint.
          </p>
          {workspacePath ? <code>{workspacePath}</code> : null}
        </div>
        <div className="revert-warning-actions">
          <button type="button" className="revert-warning-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="revert-warning-primary"
            onClick={() => onConfirm(turnCount)}
          >
            <RotateCcw size={13} strokeWidth={2} />
            Restore files
          </button>
        </div>
      </section>
    </div>
  )
}

export function CommitMessageDialog({
  open,
  workspacePath,
  error,
  submitting,
  onCancel,
  onConfirm
}: {
  open: boolean
  workspacePath: string | null
  error: string | null
  submitting: boolean
  onCancel: () => void
  onConfirm: (message: string) => void
}): React.JSX.Element | null {
  const [message, setMessage] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const trimmedMessage = message.trim()

  useEffect(() => {
    if (!open) {
      setMessage('')
      return
    }
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20)
    return () => window.clearTimeout(focusTimer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, open, submitting])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      if (!trimmedMessage || submitting) return
      onConfirm(trimmedMessage)
    },
    [onConfirm, submitting, trimmedMessage]
  )

  if (!open) return null

  return (
    <div className="commit-dialog-layer" role="presentation">
      <button
        type="button"
        className="commit-dialog-scrim"
        aria-label="Cancel commit"
        onClick={onCancel}
        disabled={submitting}
      />
      <form
        className="commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={handleSubmit}
      >
        <div className="commit-dialog-icon" aria-hidden="true">
          <GitCommitHorizontal size={15} strokeWidth={2} />
        </div>
        <div className="commit-dialog-copy">
          <p className="commit-dialog-kicker">Commit all changes</p>
          <h2 id={titleId}>Commit review diff?</h2>
          <p id={descriptionId}>
            This stages the current workspace changes and creates a Git commit.
          </p>
          {workspacePath ? <code>{workspacePath}</code> : null}
        </div>
        <label className="commit-message-field">
          <span>Message</span>
          <input
            ref={inputRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe the change"
            disabled={submitting}
          />
        </label>
        {error ? <p className="commit-dialog-error">{error}</p> : null}
        <div className="commit-dialog-actions">
          <button
            type="button"
            className="commit-dialog-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="commit-dialog-primary"
            disabled={!trimmedMessage || submitting}
          >
            <GitCommitHorizontal size={13} strokeWidth={2} />
            {submitting ? 'Committing...' : 'Commit'}
          </button>
        </div>
      </form>
    </div>
  )
}

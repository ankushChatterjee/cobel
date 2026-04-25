import { memo } from 'react'
import { errorMessageForDisplay } from '../formatUtils'

function renderTextWithLinks(text: string): React.ReactNode {
  const urlRegex = /https?:\/\/[^\s)]+/g
  const parts: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(
      <a
        key={match.index}
        href={match[0]}
        target="_blank"
        rel="noreferrer"
        className="session-error-link"
      >
        {match[0]}
      </a>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

export const SessionErrorBanner = memo(function SessionErrorBanner({
  message
}: {
  message: string
}): React.JSX.Element {
  const displayMessage = errorMessageForDisplay(message)
  return (
    <div className="session-error-banner" role="alert" aria-live="assertive">
      <span className="session-error-icon" aria-hidden="true">⚠</span>
      <p className="session-error-message">{renderTextWithLinks(displayMessage)}</p>
    </div>
  )
})

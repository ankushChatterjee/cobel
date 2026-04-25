import { memo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { OrchestrationThreadActivity } from '../../../../../shared/agent'
import { EmbeddedDiffView } from '../../diff/DiffReview'
import {
  extractFileChangeDiff,
  readBestItemData,
  readPayloadRecord,
  readPayloadString,
  statusFromActivity,
  statusLabel,
  statusToneForTool,
  verbForActivity
} from '../activityUtils'
import { formatDuration } from '../formatUtils'

export const ToolLine = memo(function ToolLine({
  activity,
  expanded,
  onToggle
}: {
  activity: OrchestrationThreadActivity
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const payload = activity.payload ?? {}
  const data = readPayloadRecord(payload, 'data')
  const itemPayload = readBestItemData(data)
  const output =
    readPayloadString(payload, 'output') ?? readPayloadString(itemPayload, 'aggregatedOutput')
  const detail = readPayloadString(payload, 'detail') ?? readPayloadString(itemPayload, 'cwd')
  const title = readPayloadString(payload, 'title') ?? activity.summary
  const status = statusFromActivity(activity)
  const statusTone = statusToneForTool(status)
  const exitCode = itemPayload['exitCode']
  const durationMs = itemPayload['durationMs']
  const verb = verbForActivity(activity)
  const hasDetails = Boolean(detail ?? output)
  const isRunning = statusTone === 'is-running'
  const fileChange = extractFileChangeDiff(payload)

  if (readPayloadString(payload, 'itemType') === 'file_change' && fileChange) {
    return (
      <article
        className={`tool-line embedded-tool-line ${statusTone}`}
        data-item-type="file_change"
      >
        <EmbeddedDiffView
          diff={fileChange.diff}
          title={fileChange.title}
          compactTitle
          status={<span>{statusLabel(status)}</span>}
        />
      </article>
    )
  }

  return (
    <article
      className={`tool-line ${statusTone}`}
      data-item-type={readPayloadString(payload, 'itemType')}
    >
      <button
        type="button"
        className="tool-line-summary"
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={hasDetails ? onToggle : undefined}
        style={hasDetails ? undefined : { cursor: 'default' }}
      >
        <span className="tool-line-chevron" aria-hidden="true">
          {isRunning ? (
            <span className="tool-line-spinner" />
          ) : hasDetails ? (
            expanded ? (
              <ChevronDown size={10} strokeWidth={2} />
            ) : (
              <ChevronRight size={10} strokeWidth={2} />
            )
          ) : null}
        </span>
        <span className="tool-line-verb">{verb}</span>
        <span className="tool-line-target">{title}</span>
        <span className="tool-line-meta">{statusLabel(status)}</span>
        {typeof exitCode === 'number' && exitCode !== 0 ? (
          <span className="tool-line-meta">exit {exitCode}</span>
        ) : null}
        {typeof durationMs === 'number' ? (
          <span className="tool-line-meta">{formatDuration(durationMs)}</span>
        ) : null}
      </button>
      {expanded && hasDetails ? (
        <div className="tool-details">
          {detail ? <p className="tool-cwd">{detail}</p> : null}
          {output ? <pre className="tool-output">{output}</pre> : null}
          {!detail && !output ? <pre className="tool-output">{formatPayload(payload)}</pre> : null}
        </div>
      ) : null}
    </article>
  )
})

function formatPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload.data ?? payload, null, 2)
  } catch {
    return String(payload)
  }
}

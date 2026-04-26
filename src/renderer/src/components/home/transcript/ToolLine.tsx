import { memo } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import type { OrchestrationThreadActivity } from '../../../../../shared/agent'
import { readCanonicalFileReadPreview } from '../../../../../shared/fileReadPreview'
import { EmbeddedDiffView } from '../../diff/DiffReview'
import {
  extractFileChangeDiff,
  readBestItemData,
  readPayloadRecord,
  readPayloadString,
  categorizeToolActivity,
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
  const searchBarUi = categorizeToolActivity(activity) === 'search'
  const hasDetails = Boolean(detail ?? output)
  const isRunning = statusTone === 'is-running'
  const fileChange = extractFileChangeDiff(payload)
  const fileReadPreview = readCanonicalFileReadPreview(payload)

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

  if (fileReadPreview) {
    const hasExpandableBody = fileReadPreview.content.trim().length > 0
    return (
      <article
        className={`tool-line file-read-tool-line ${statusTone}`}
        data-item-type="file_read_preview"
      >
        <button
          type="button"
          className="tool-line-summary"
          aria-expanded={hasExpandableBody ? expanded : undefined}
          onClick={hasExpandableBody ? onToggle : undefined}
          style={hasExpandableBody ? undefined : { cursor: 'default' }}
        >
          <span className="tool-line-chevron" aria-hidden="true">
            {isRunning ? (
              <span className="tool-line-spinner" />
            ) : hasExpandableBody ? (
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
          {fileReadPreview.truncated ? (
            <span className="tool-line-meta" title="Preview may be partial while loading">
              truncated preview
            </span>
          ) : null}
        </button>
        <div className="file-read-preview-path" title={fileReadPreview.path}>
          {fileReadPreview.path}
        </div>
        {expanded && hasExpandableBody ? (
          <div className="tool-details file-read-preview-body">
            {fileReadPreview.resourceType ? (
              <p className="file-read-preview-type">{fileReadPreview.resourceType}</p>
            ) : null}
            <pre className="tool-output file-read-preview-content">{fileReadPreview.content}</pre>
          </div>
        ) : null}
      </article>
    )
  }

  const queryLabel = title.trim() || '…'

  return (
    <article
      className={`tool-line ${searchBarUi ? 'tool-line-search' : ''} ${statusTone}`}
      data-item-type={readPayloadString(payload, 'itemType')}
    >
      <button
        type="button"
        className="tool-line-summary"
        aria-expanded={hasDetails ? expanded : undefined}
        aria-label={searchBarUi ? `Search: ${queryLabel}` : undefined}
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
        {searchBarUi ? (
          <span className="tool-search-inline">
            <Search className="tool-search-icon" size={11} strokeWidth={2} aria-hidden />
            <span className="tool-search-query">{queryLabel}</span>
          </span>
        ) : (
          <>
            <span className="tool-line-verb">{verb}</span>
            <span className="tool-line-target">{title}</span>
          </>
        )}
        {searchBarUi ? (
          statusTone === 'is-error' ? (
            <span className="tool-line-meta">{statusLabel(status)}</span>
          ) : null
        ) : (
          <>
            <span className="tool-line-meta">{statusLabel(status)}</span>
            {typeof exitCode === 'number' && exitCode !== 0 ? (
              <span className="tool-line-meta">exit {exitCode}</span>
            ) : null}
            {typeof durationMs === 'number' ? (
              <span className="tool-line-meta">{formatDuration(durationMs)}</span>
            ) : null}
          </>
        )}
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

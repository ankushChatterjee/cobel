import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { statusFromActivity, statusToneForTool, summarizeToolRun } from '../activityUtils'
import type { ActivityTranscriptItem } from '../types'
import { ToolLine } from './ToolLine'

export const ToolGroup = memo(function ToolGroup({
  activities,
  expandedToolIds,
  onToggleTool
}: {
  activities: ActivityTranscriptItem[]
  expandedToolIds: Set<string>
  onToggleTool: (activityId: string) => void
}): React.JSX.Element {
  const activityList = activities.map((a) => a.activity)
  const summary = summarizeToolRun(activityList)
  const allComplete = activityList.every(
    (a) => statusToneForTool(statusFromActivity(a)) === 'is-complete'
  )
  const anyRunning = activityList.some(
    (a) => statusToneForTool(statusFromActivity(a)) === 'is-running'
  )
  const anyError = activityList.some((a) => statusToneForTool(statusFromActivity(a)) === 'is-error')
  const groupTone = anyError
    ? 'is-error'
    : anyRunning
      ? 'is-running'
      : allComplete
        ? 'is-complete'
        : ''

  // Start open while streaming; auto-collapse when the run finishes.
  // User can re-open after collapse.
  const [open, setOpen] = useState(() => anyRunning)
  const userToggledRef = useRef(false)
  const prevRunningRef = useRef(anyRunning)

  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = anyRunning
    if (anyRunning && !wasRunning) {
      setOpen(true)
      userToggledRef.current = false
    } else if (!anyRunning && wasRunning && !userToggledRef.current) {
      setOpen(false)
    }
  }, [anyRunning])

  function handleToggle(): void {
    userToggledRef.current = true
    setOpen((v) => !v)
  }

  return (
    <div className={`tool-group ${groupTone}`}>
      <button
        type="button"
        className="tool-group-summary"
        aria-expanded={open}
        onClick={handleToggle}
      >
        <span className="tool-line-chevron" aria-hidden="true">
          {anyRunning ? (
            <span className="tool-line-spinner" />
          ) : open ? (
            <ChevronDown size={10} strokeWidth={2} />
          ) : (
            <ChevronRight size={10} strokeWidth={2} />
          )}
        </span>
        <span className="tool-group-label">{summary}</span>
      </button>
      {open ? (
        <div className="tool-group-body">
          {activities.map((item) => (
            <ToolLine
              key={item.id}
              activity={item.activity}
              expanded={expandedToolIds.has(item.activity.id)}
              onToggle={() => onToggleTool(item.activity.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

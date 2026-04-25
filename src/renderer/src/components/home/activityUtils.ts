import type { OrchestrationThreadActivity } from '../../../../shared/agent'

export function isPendingPrompt(activity: OrchestrationThreadActivity): boolean {
  return (
    (activity.kind === 'approval.requested' || activity.kind === 'user-input.requested') &&
    activity.resolved !== true
  )
}

export function isToolActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind.startsWith('tool.')
}

export function isRuntimeError(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === 'runtime.error'
}

export function isThinkingActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.tone === 'thinking'
}

export function isHiddenActivity(activity: OrchestrationThreadActivity): boolean {
  return isThinkingActivity(activity) && activity.resolved === true
}

export function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

export function readPayloadRecord(
  payload: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> {
  const value = payload?.[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readBestItemData(data: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['item', 'normalized']) {
    const candidate = data[key]
    if (typeof candidate === 'object' && candidate !== null && Object.keys(candidate).length > 0) {
      return candidate as Record<string, unknown>
    }
  }
  return data
}

export function findFileUpdateChanges(input: unknown): Array<Record<string, unknown>> {
  const seen = new WeakSet<object>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]

  while (queue.length > 0) {
    const { value, depth } = queue.shift() as { value: unknown; depth: number }
    if (!value || typeof value !== 'object') continue
    if (seen.has(value)) continue
    seen.add(value)

    const record = value as Record<string, unknown>
    const changes = record['changes']
    if (
      Array.isArray(changes) &&
      changes.some(
        (change) =>
          Boolean(change) &&
          typeof change === 'object' &&
          typeof (change as Record<string, unknown>).diff === 'string'
      )
    ) {
      return changes.filter(
        (change): change is Record<string, unknown> => Boolean(change) && typeof change === 'object'
      )
    }

    if (depth >= 5) continue
    for (const key of ['args', 'item', 'toolCall', 'tool_call', 'call', 'fileChange', 'data']) {
      if (key in record) queue.push({ value: record[key], depth: depth + 1 })
    }
  }

  return []
}

export function extractFileChangeDiff(
  payload: Record<string, unknown> | undefined
): { diff: string; title: string } | null {
  const changes = findFileUpdateChanges(payload)
  const diffs = changes
    .map((change) => (typeof change.diff === 'string' ? change.diff.trimEnd() : ''))
    .filter(Boolean)
  if (diffs.length === 0) return null
  const paths = changes
    .map((change) => (typeof change.path === 'string' ? change.path : null))
    .filter((path): path is string => Boolean(path))
  const firstPath = paths[0] ?? 'file changes'
  return {
    diff: diffs.join('\n'),
    title: paths.length > 1 ? `${firstPath} +${paths.length - 1}` : firstPath
  }
}

export function readQuestions(activity: OrchestrationThreadActivity): Array<{
  id: string
  options?: Array<{ label: string }>
}> {
  const questions = activity.payload?.questions
  return Array.isArray(questions)
    ? questions
        .map((question) =>
          typeof question === 'object' && question !== null
            ? (question as { id: string; options?: Array<{ label: string }> })
            : null
        )
        .filter((question): question is { id: string; options?: Array<{ label: string }> } =>
          Boolean(question)
        )
    : []
}

export function requestIdFromActivity(activity: OrchestrationThreadActivity): string {
  return activity.id.replace(/^approval:/u, '').replace(/^user-input:/u, '')
}

export function labelForActivity(activity: OrchestrationThreadActivity): string {
  if (activity.kind === 'runtime.warning') return 'warning'
  if (activity.kind === 'runtime.error') return 'error'
  if (activity.kind.includes('approval')) return 'approval'
  if (activity.kind.includes('user-input')) return 'input'
  const itemType = readPayloadString(activity.payload, 'itemType')
  switch (itemType) {
    case 'command_execution':
      return 'terminal'
    case 'file_change':
      return 'edit'
    case 'reasoning':
      return 'thinking'
    case 'web_search':
      return 'search'
    case 'mcp_tool_call':
      return 'mcp'
    case 'dynamic_tool_call':
      return 'tool'
    case 'collab_agent_tool_call':
      return 'agent'
    case 'image_view':
      return 'image'
    case 'review_entered':
    case 'review_exited':
      return 'review'
    case 'context_compaction':
      return 'compact'
    case 'plan':
      return 'plan'
    default:
      break
  }
  if (activity.summary.toLowerCase().includes('terminal')) return 'terminal'
  if (activity.summary.toLowerCase().includes('edit')) return 'edit'
  return 'tool'
}

export function statusFromActivity(activity: OrchestrationThreadActivity): string {
  const payloadStatus = readPayloadString(activity.payload, 'status')
  if (activity.kind === 'tool.completed' || activity.kind === 'task.completed') {
    if (payloadStatus === 'failed' || payloadStatus === 'declined') return payloadStatus
    return 'completed'
  }
  if (
    payloadStatus === 'completed' ||
    payloadStatus === 'success' ||
    payloadStatus === 'failed' ||
    payloadStatus === 'declined' ||
    payloadStatus === 'inProgress'
  ) {
    return payloadStatus
  }
  if (activity.resolved === true) {
    if (isToolActivity(activity) || isThinkingActivity(activity)) return 'completed'
    return 'resolved'
  }

  switch (activity.kind) {
    case 'tool.started':
    case 'task.started':
      return 'running'
    case 'tool.updated':
    case 'task.progress':
      return 'running'
    case 'runtime.error':
      return 'error'
    case 'approval.requested':
    case 'user-input.requested':
      return 'waiting'
    case 'approval.resolved':
    case 'user-input.resolved':
      return 'resolved'
    default:
      return 'info'
  }
}

export function statusToneForTool(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'completed' || normalized === 'success' || normalized === 'resolved')
    return 'is-complete'
  if (normalized === 'failed' || normalized === 'error' || normalized === 'declined')
    return 'is-error'
  if (normalized === 'waiting') return 'is-waiting'
  return 'is-running'
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'inProgress':
      return 'running'
    case 'resolved':
      return 'done'
    default:
      return status
  }
}

export function categorizeToolActivity(activity: OrchestrationThreadActivity): string {
  const label = labelForActivity(activity)
  if (label === 'terminal' || label === 'mcp') return label
  if (label === 'edit') return 'edit'
  if (label === 'search') return 'search'
  if (label === 'web') return 'web'
  if (label === 'image') return 'image'
  if (label === 'review') return 'review'
  if (label === 'compact') return 'compact'
  if (label === 'plan') return 'plan'
  if (label === 'agent') return 'agent'
  const payload = activity.payload ?? {}
  const title = (readPayloadString(payload, 'title') ?? activity.summary).toLowerCase()
  if (title.startsWith('read') || title.startsWith('glob') || label === 'tool') {
    if (title.startsWith('read') || title.startsWith('glob')) return 'read'
  }
  if (title.startsWith('search') || title.startsWith('grep') || title.includes('search'))
    return 'search'
  return label === 'tool' ? 'tool' : label
}

export function verbForActivity(activity: OrchestrationThreadActivity): string {
  const payload = activity.payload ?? {}
  const title = readPayloadString(payload, 'title') ?? activity.summary
  const label = labelForActivity(activity)
  if (label === 'edit') return 'Edited'
  if (label === 'terminal') return 'Ran'
  if (label === 'search') return 'Searched for'
  if (label === 'web') return 'Searched web for'
  if (label === 'mcp') return 'Called'
  if (label === 'image') return 'Viewed'
  if (label === 'agent') return 'Spawned agent'
  if (label === 'review') return 'Review'
  if (label === 'compact') return 'Compacted'
  if (label === 'plan') return 'Planned'
  const titleLower = title.toLowerCase()
  if (titleLower.startsWith('read')) return 'Read'
  if (titleLower.startsWith('glob')) return 'Listed'
  if (titleLower.startsWith('search') || titleLower.startsWith('grep')) return 'Searched for'
  const first = label.charAt(0).toUpperCase() + label.slice(1)
  return first
}

export function summarizeToolRun(activities: OrchestrationThreadActivity[]): string {
  const categoryCounts = new Map<string, number>()
  const seenOrder: string[] = []
  for (const activity of activities) {
    const cat = categorizeToolActivity(activity)
    if (!categoryCounts.has(cat)) {
      categoryCounts.set(cat, 0)
      seenOrder.push(cat)
    }
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const cat of seenOrder) {
    const n = categoryCounts.get(cat) ?? 0
    if (cat === 'read') parts.push(`Explored ${n} ${n === 1 ? 'file' : 'files'}`)
    else if (cat === 'search') parts.push(`${n} ${n === 1 ? 'search' : 'searches'}`)
    else if (cat === 'terminal') parts.push(`Ran ${n} ${n === 1 ? 'command' : 'commands'}`)
    else if (cat === 'edit') parts.push(`Edited ${n} ${n === 1 ? 'file' : 'files'}`)
    else if (cat === 'web') parts.push(`${n} web ${n === 1 ? 'search' : 'searches'}`)
    else if (cat === 'mcp') parts.push(`${n} MCP ${n === 1 ? 'call' : 'calls'}`)
    else if (cat === 'image') parts.push(`Viewed ${n} ${n === 1 ? 'image' : 'images'}`)
    else if (cat === 'agent') parts.push(`${n} ${n === 1 ? 'agent' : 'agents'}`)
    else parts.push(`${n} tool ${n === 1 ? 'call' : 'calls'}`)
  }
  return parts.join(', ')
}

export function labelForApproval(activity: OrchestrationThreadActivity): string {
  const requestType = readPayloadString(activity.payload, 'requestType')
  if (requestType === 'file_change_approval' || extractFileChangeDiff(activity.payload))
    return 'edit approval'
  if (requestType === 'command_execution_approval') return 'approval'
  if (requestType === 'file_read_approval') return 'read approval'
  return 'approval'
}

export function resolvedApprovalLabel(activity: OrchestrationThreadActivity): string {
  const decision = readPayloadString(activity.payload, 'decision')
  if (decision === 'decline' || decision === 'cancel') return 'declined'
  if (decision === 'accept' || decision === 'acceptForSession') return 'approved'
  return 'resolved'
}

import type { OrchestrationThreadActivity } from '../../../../shared/agent'
import {
  discoverLegacyCodexFileEditChanges,
  fileEditChangesToPreview,
  readCanonicalFileEditChanges
} from '../../../../shared/fileEditChanges'
import { readCanonicalFileReadPreview } from '../../../../shared/fileReadPreview'
import type { PendingQuestion, PendingRequestViewModel } from './types'

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

export function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

function hasReasoningTranscriptText(activity: OrchestrationThreadActivity): boolean {
  if (readPayloadString(activity.payload, 'itemType') !== 'reasoning') return false
  const text = readPayloadString(activity.payload, 'reasoningText')
  return Boolean(text && text.trim().length > 0)
}

export function isHiddenActivity(activity: OrchestrationThreadActivity): boolean {
  if (!isThinkingActivity(activity) || activity.resolved !== true) return false
  if (hasReasoningTranscriptText(activity)) return false
  return true
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

export function extractFileChangeDiff(
  payload: Record<string, unknown> | undefined
): { diff: string; title: string } | null {
  if (!payload) return null
  const canonical = readCanonicalFileEditChanges(payload)
  if (canonical.length > 0) return fileEditChangesToPreview(canonical)
  const legacy = discoverLegacyCodexFileEditChanges(payload)
  if (legacy.length > 0) return fileEditChangesToPreview(legacy)
  return null
}

export function readQuestions(activity: OrchestrationThreadActivity): PendingQuestion[] {
  const questions = activity.payload?.questions
  if (!Array.isArray(questions)) return []
  const normalized: PendingQuestion[] = []
  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) continue
    const question = entry as PendingQuestion
    if (typeof question.id !== 'string' || typeof question.question !== 'string') continue
    normalized.push({
      id: question.id,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      options: Array.isArray(question.options) ? question.options : []
    })
  }
  return normalized
}

export function requestIdFromActivity(activity: OrchestrationThreadActivity): string {
  return activity.id.replace(/^approval:/u, '').replace(/^user-input:/u, '')
}

export function labelForActivity(activity: OrchestrationThreadActivity): string {
  if (activity.kind === 'runtime.warning') return 'warning'
  if (activity.kind === 'runtime.error') return 'error'
  if (activity.kind.includes('approval')) return 'approval'
  if (activity.kind.includes('user-input')) return 'input'
  if (readCanonicalFileReadPreview(activity.payload)) return 'read'
  const itemType = readPayloadString(activity.payload, 'itemType')
  switch (itemType) {
    case 'command_execution':
      return 'terminal'
    case 'file_change':
      return 'edit'
    case 'reasoning':
      return 'thinking'
    case 'web_search':
    case 'code_search':
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
  if (readCanonicalFileReadPreview(activity.payload)) return 'read'
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
  if (readCanonicalFileReadPreview(payload)) return 'Read'
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

export function pendingRequestTypeLabel(requestType: string, kind: 'approval' | 'input'): string {
  if (kind === 'input') return 'Question'
  switch (requestType) {
    case 'file_change_approval':
    case 'apply_patch_approval':
      return 'Edit approval'
    case 'command_execution_approval':
    case 'exec_command_approval':
      return 'Command approval'
    case 'file_read_approval':
      return 'Read approval'
    default:
      return 'Approval'
  }
}

export function normalizePendingRequest(
  activity: OrchestrationThreadActivity
): PendingRequestViewModel | null {
  if (!isPendingPrompt(activity)) return null
  const requestType = readPayloadString(activity.payload, 'requestType') ?? 'unknown'
  const kind = activity.kind === 'approval.requested' ? 'approval' : 'input'
  return {
    activity,
    kind,
    requestType,
    requestLabel: kind === 'approval' ? labelForApproval(activity) : 'input',
    requestTypeLabel: pendingRequestTypeLabel(requestType, kind),
    summary: activity.summary,
    fileChange: kind === 'approval' ? extractFileChangeDiff(activity.payload) : null,
    questions: readQuestions(activity)
  }
}

export function compareActivityOrder(
  left: Pick<OrchestrationThreadActivity, 'sequence' | 'createdAt' | 'id'>,
  right: Pick<OrchestrationThreadActivity, 'sequence' | 'createdAt' | 'id'>
): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  const leftTime = new Date(left.createdAt).getTime()
  const rightTime = new Date(right.createdAt).getTime()
  if (leftTime !== rightTime) return leftTime - rightTime
  return left.id.localeCompare(right.id)
}

export function listPendingRequests(
  activities: OrchestrationThreadActivity[],
  activeTurnId: string | null
): PendingRequestViewModel[] {
  return activities
    .map(normalizePendingRequest)
    .filter((request): request is PendingRequestViewModel => Boolean(request))
    .sort((left, right) => {
      const leftActive = left.activity.turnId !== null && left.activity.turnId === activeTurnId
      const rightActive = right.activity.turnId !== null && right.activity.turnId === activeTurnId
      if (leftActive !== rightActive) return leftActive ? -1 : 1
      return compareActivityOrder(left.activity, right.activity)
    })
}

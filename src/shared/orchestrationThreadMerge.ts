import type { OrchestrationThread, OrchestrationThreadActivity } from './agent'

const TERMINAL_STATUSES = new Set(['completed', 'success', 'failed', 'declined', 'cancelled', 'interrupted'])
const NON_TERMINAL_STATUSES = new Set(['inProgress', 'running', 'pending', 'started'])

export function mergeThreadSnapshot(
  current: OrchestrationThread | null | undefined,
  incoming: OrchestrationThread
): OrchestrationThread {
  if (!current || current.id !== incoming.id) {
    return {
      ...incoming,
      activities: mergeActivities([], incoming.activities)
    }
  }

  return {
    ...incoming,
    messages: mergeById(current.messages, incoming.messages),
    activities: mergeActivities(current.activities, incoming.activities),
    proposedPlans: mergeById(current.proposedPlans, incoming.proposedPlans),
    todoLists: mergeById(current.todoLists ?? [], incoming.todoLists ?? []),
    checkpoints: mergeById(current.checkpoints, incoming.checkpoints)
  }
}

export function mergeActivities(
  currentActivities: OrchestrationThreadActivity[],
  incomingActivities: OrchestrationThreadActivity[]
): OrchestrationThreadActivity[] {
  const merged: OrchestrationThreadActivity[] = []
  const indexById = new Map<string, number>()

  for (const activity of currentActivities) {
    if (indexById.has(activity.id)) {
      const index = indexById.get(activity.id)!
      merged[index] = mergeThreadActivity(merged[index]!, activity)
      continue
    }
    indexById.set(activity.id, merged.length)
    merged.push(activity)
  }

  for (const activity of incomingActivities) {
    const index = indexById.get(activity.id)
    if (index === undefined) {
      indexById.set(activity.id, merged.length)
      merged.push(activity)
      continue
    }
    merged[index] = mergeThreadActivity(merged[index]!, activity)
  }

  return merged
}

export function mergeThreadActivity(
  existing: OrchestrationThreadActivity | undefined,
  incoming: OrchestrationThreadActivity
): OrchestrationThreadActivity {
  if (!existing) return incoming

  const existingTerminal = isTerminalActivity(existing)
  const incomingTerminal = isTerminalActivity(incoming)
  const existingScore = activityDetailScore(existing)
  const incomingScore = activityDetailScore(incoming)

  let winner: OrchestrationThreadActivity
  let payloadBase: Record<string, unknown>

  if (existingTerminal && !incomingTerminal && isNonTerminalActivity(incoming)) {
    winner = existing
    payloadBase = { ...incoming.payload, ...existing.payload }
  } else if (!existingTerminal && incomingTerminal) {
    winner = incoming
    payloadBase = { ...existing.payload, ...incoming.payload }
  } else if (incomingScore < existingScore) {
    winner = existing
    payloadBase = { ...incoming.payload, ...existing.payload }
  } else {
    winner = incoming
    payloadBase = { ...existing.payload, ...incoming.payload }
  }

  return {
    ...winner,
    payload: Object.keys(payloadBase).length > 0 ? payloadBase : winner.payload,
    createdAt: existing.createdAt,
    sequence: existing.sequence ?? incoming.sequence
  }
}

export function isTerminalActivity(activity: Pick<OrchestrationThreadActivity, 'kind' | 'payload'>): boolean {
  if (activity.kind === 'tool.completed' || activity.kind === 'task.completed') return true
  const status = readPayloadString(activity.payload, 'status')
  return status !== null && TERMINAL_STATUSES.has(status)
}

export function activityDetailScore(activity: Pick<OrchestrationThreadActivity, 'summary' | 'payload'>): number {
  const payload = activity.payload ?? {}
  let score = activity.summary ? 1 : 0
  for (const key of [
    'itemType',
    'title',
    'detail',
    'command',
    'output',
    'fileEditChanges',
    'fileReadPreview',
    'commandActions',
    'data'
  ]) {
    score += payloadDetailScore(payload[key])
  }
  return score
}

function isNonTerminalActivity(activity: Pick<OrchestrationThreadActivity, 'kind' | 'payload'>): boolean {
  if (activity.kind === 'tool.started' || activity.kind === 'tool.updated') return true
  if (activity.kind === 'task.started' || activity.kind === 'task.progress') return true
  const status = readPayloadString(activity.payload, 'status')
  return status !== null && NON_TERMINAL_STATUSES.has(status)
}

function payloadDetailScore(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  if (Array.isArray(value)) return value.length > 0 ? 3 : 0
  if (typeof value === 'object') return Object.keys(value).length > 0 ? 3 : 0
  return 1
}

function mergeById<T extends { id: string }>(currentItems: T[], incomingItems: T[]): T[] {
  const merged = [...currentItems]
  const indexById = new Map(merged.map((item, index) => [item.id, index] as const))
  for (const item of incomingItems) {
    const index = indexById.get(item.id)
    if (index === undefined) {
      indexById.set(item.id, merged.length)
      merged.push(item)
    } else {
      merged[index] = item
    }
  }
  return merged
}

function readPayloadString(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' ? value : null
}

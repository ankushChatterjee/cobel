import type {
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationShellSnapshot,
  OrchestrationThread
} from '../../../../shared/agent'
import { DEFAULT_THREAD_TITLE } from '../../../../shared/threadTitle'
import {
  isHiddenActivity,
  isPendingPrompt,
  isRuntimeError,
  isThinkingActivity,
  isToolActivity,
  statusFromActivity
} from './activityUtils'
import { legacyWorkspaceKey } from './storage'
import type { ActivityTranscriptItem, MessageTranscriptItem, TranscriptItem, TranscriptRenderGroup } from './types'

export function createId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

export function projectIdForPath(path: string): string {
  return (
    path
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/(^-|-$)/gu, '') || 'project'
  )
}

export function canAutoReplaceOptimisticTitle(title: string): boolean {
  return title === DEFAULT_THREAD_TITLE
}

export function createEmptyThread(
  threadId: string,
  createdAt: string,
  overrides: { title?: string; cwd?: string } = {}
): OrchestrationThread {
  return {
    id: threadId,
    title: overrides.title ?? DEFAULT_THREAD_TITLE,
    cwd: overrides.cwd,
    branch: 'main',
    messages: [],
    activities: [],
    proposedPlans: [],
    session: null,
    latestTurn: null,
    checkpoints: [],
    createdAt,
    updatedAt: createdAt,
    archivedAt: null
  }
}

export function mergePendingUserMessages(
  thread: OrchestrationThread,
  pendingMessages: Map<string, OrchestrationMessage>
): OrchestrationThread {
  if (pendingMessages.size === 0) return thread
  return {
    ...thread,
    messages: Array.from(pendingMessages.values()).reduce(
      (messages, message) => upsertById(messages, message),
      thread.messages
    )
  }
}

export function upsertOptimisticUserMessage({
  thread,
  threadId,
  cwd,
  title,
  message
}: {
  thread: OrchestrationThread | null
  threadId: string
  cwd: string
  title: string
  message: OrchestrationMessage
}): OrchestrationThread {
  const now = message.createdAt
  const current =
    thread ??
    createEmptyThread(threadId, now, {
      title,
      cwd
    })
  return {
    ...current,
    title: canAutoReplaceOptimisticTitle(current.title) ? title : current.title,
    cwd: current.cwd ?? cwd,
    messages: upsertById(current.messages, message),
    updatedAt: now
  }
}

export function workDurationForMessage(message: OrchestrationMessage): number | null {
  if (message.role !== 'assistant') return null
  return durationBetween(message.createdAt, message.updatedAt)
}

export function durationBetween(start: string, end: string): number | null {
  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return Math.max(0, endMs - startMs)
}

export function timestampForSort(value: string): number {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function buildTranscriptItems(thread: OrchestrationThread | null): TranscriptItem[] {
  if (!thread) return []
  return [
    ...thread.messages.map((message): MessageTranscriptItem => ({
      id: `message:${message.id}`,
      kind: 'message',
      sequence: message.sequence ?? Number.MAX_SAFE_INTEGER,
      createdAt: message.createdAt,
      workDurationMs: workDurationForMessage(message),
      message
    })),
    ...thread.activities
      .filter((activity) => !isHiddenActivity(activity))
      .map((activity): ActivityTranscriptItem => ({
        id: `activity:${activity.id}`,
        kind: 'activity',
        sequence: activity.sequence ?? Number.MAX_SAFE_INTEGER,
        createdAt: activity.createdAt,
        activity
      }))
  ].sort((left, right) => {
    const leftCreatedAt = timestampForSort(left.createdAt)
    const rightCreatedAt = timestampForSort(right.createdAt)
    if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt
    return left.sequence - right.sequence
  })
}

export function groupTranscriptItems(items: TranscriptItem[]): TranscriptRenderGroup[] {
  const groups: TranscriptRenderGroup[] = []
  let toolRun: ActivityTranscriptItem[] = []
  let reasoningRun: ActivityTranscriptItem[] = []

  function flushToolRun(): void {
    if (toolRun.length === 0) return
    groups.push({
      kind: 'tool-run',
      id: `run:${toolRun[0].id}:${toolRun[toolRun.length - 1].id}`,
      activities: toolRun
    })
    toolRun = []
  }

  function flushReasoningRun(): void {
    if (reasoningRun.length === 0) return
    if (reasoningRun.length === 1) {
      groups.push({ kind: 'non-tool', item: reasoningRun[0] })
    } else {
      groups.push({
        kind: 'reasoning-run',
        id: `reasoning:${reasoningRun[0].id}:${reasoningRun[reasoningRun.length - 1].id}`,
        activities: reasoningRun
      })
    }
    reasoningRun = []
  }

  for (const item of items) {
    if (item.kind === 'activity' && isToolActivity(item.activity)) {
      flushReasoningRun()
      toolRun.push(item)
      continue
    }
    if (item.kind === 'activity' && isThinkingActivity(item.activity)) {
      flushToolRun()
      reasoningRun.push(item)
      continue
    }
    flushToolRun()
    flushReasoningRun()
    groups.push({ kind: 'non-tool', item })
  }
  flushToolRun()
  flushReasoningRun()
  return groups
}

export function buildCheckpointByAssistantMessageId(
  checkpoints: OrchestrationCheckpointSummary[]
): Map<string, OrchestrationCheckpointSummary> {
  const map = new Map<string, OrchestrationCheckpointSummary>()
  for (const checkpoint of checkpoints) {
    if (checkpoint.assistantMessageId) map.set(checkpoint.assistantMessageId, checkpoint)
  }
  return map
}

/** Transcript, assistant output, or terminal session state — visible progress beyond an empty run. */
export function threadHasTranscriptVisibleProgress(thread: OrchestrationThread): boolean {
  const sessionStatus = thread.session?.status
  if (sessionStatus === 'ready' || sessionStatus === 'stopped' || sessionStatus === 'interrupted') {
    return true
  }
  if (sessionStatus === 'error') {
    return true
  }
  if (thread.messages.some((m) => m.role === 'assistant')) {
    return true
  }
  if (thread.activities.some((a) => !isHiddenActivity(a))) {
    return true
  }
  if (thread.proposedPlans.length > 0) {
    return true
  }
  return false
}

/**
 * In-flight tool/task work already shows a line-level spinner; skip the duplicate transcript tail spinner.
 */
export function threadHasInFlightWorkIndicator(thread: OrchestrationThread | null): boolean {
  if (!thread) return false
  for (const activity of thread.activities) {
    if (activity.resolved === true) continue
    if (activity.kind.startsWith('tool.') || activity.kind.startsWith('task.')) {
      const s = statusFromActivity(activity)
      if (s === 'running' || s === 'inProgress') {
        return true
      }
    }
  }
  return false
}

/**
 * When the model is still processing but there is no thinking row, assistant stream, or tool run yet,
 * keep a tail "thinking…" row so the thread never looks stalled.
 */
export function shouldShowTranscriptEndThinkingRow(
  thread: OrchestrationThread | null,
  input: {
    isPendingTurnStart: boolean
    isSessionActive: boolean
    hasActiveThinkingActivity: boolean
  }
): boolean {
  if (input.hasActiveThinkingActivity) return false
  if (thread) {
    if (thread.activities.some(isPendingPrompt)) return false
    if (thread.messages.some((m) => m.role === 'assistant' && m.streaming)) {
      return false
    }
    if (threadHasInFlightWorkIndicator(thread)) {
      return false
    }
  }
  return input.isPendingTurnStart || input.isSessionActive
}

export function eventClearsPendingTurnWait(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case 'thread.message-upserted':
      return event.message.role === 'assistant'
    case 'thread.activity-upserted':
      return !isHiddenActivity(event.activity)
    case 'thread.proposed-plan-upserted':
      return true
    case 'thread.latest-turn-set':
      return event.latestTurn !== null && event.latestTurn.status !== 'running'
    case 'thread.session-set': {
      if (event.session === null) {
        return true
      }
      const s = event.session.status
      return (
        s === 'ready' || s === 'stopped' || s === 'interrupted' || s === 'error' || s === 'idle'
      )
    }
    case 'thread.snapshot.changed':
      return threadHasTranscriptVisibleProgress(event.thread)
    case 'thread.turn-diff-completed':
    case 'thread.reverted':
      return true
    case 'thread.created':
    case 'thread.renamed':
    case 'thread.archived':
    case 'thread.deleted':
      return false
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export function threadSnapshotHasAssistantResponse(thread: OrchestrationThread): boolean {
  return threadHasTranscriptVisibleProgress(thread)
}

export function eventHasAssistantResponse(event: OrchestrationEvent): boolean {
  return eventClearsPendingTurnWait(event)
}

export function readSessionErrorForDisplay(thread: OrchestrationThread | null): string | null {
  const message = thread?.session?.status === 'error' ? (thread.session.lastError ?? null) : null
  if (!message) return null
  const normalizedMessage = normalizeErrorMessage(message)
  const hasMatchingRuntimeError =
    thread?.activities.some(
      (activity) =>
        isRuntimeError(activity) && normalizeErrorMessage(activity.summary) === normalizedMessage
    ) ?? false
  return hasMatchingRuntimeError ? null : message
}

function normalizeErrorMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ')
}

export function findLatestProposedPlan(
  plans: OrchestrationProposedPlan[],
  latestTurnId: string | null
): OrchestrationProposedPlan | null {
  if (plans.length === 0) return null
  const matchingTurnPlan =
    (latestTurnId ? [...plans].reverse().find((plan) => plan.turnId === latestTurnId) : undefined) ??
    null
  return matchingTurnPlan ?? plans[plans.length - 1] ?? null
}

export function derivePlanTitle(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const heading = lines.find((line) => /^#{1,6}\s+/u.test(line))
  const title = heading ? heading.replace(/^#{1,6}\s+/u, '') : lines[0]
  return title?.trim() || 'Plan'
}

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`
}

export function runLegacyMigration(loadedShell: OrchestrationShellSnapshot): void {
  const raw = localStorage.getItem(legacyWorkspaceKey)
  if (!raw) return
  if (loadedShell.projects.length > 0) {
    localStorage.removeItem(legacyWorkspaceKey)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    localStorage.removeItem(legacyWorkspaceKey)
    return
  }
  const legacy = parsed as {
    projects?: Array<{
      id: string
      name: string
      path: string
      chats?: Array<{ id: string; label: string; createdAt: string }>
    }>
    activeProjectId?: string
    activeChatId?: string
  }
  if (!Array.isArray(legacy.projects)) {
    localStorage.removeItem(legacyWorkspaceKey)
    return
  }
  const migrateAsync = async (): Promise<void> => {
    const createdAt = new Date().toISOString()
    for (const project of legacy.projects ?? []) {
      if (typeof project.id !== 'string' || typeof project.path !== 'string') continue
      await window.agentApi.dispatchCommand({
        type: 'project.create',
        commandId: `cmd:${createId()}`,
        projectId: project.id,
        name: project.name ?? project.path,
        path: project.path,
        createdAt
      })
      for (const chat of project.chats ?? []) {
        if (typeof chat.id !== 'string') continue
        await window.agentApi.dispatchCommand({
          type: 'thread.create',
          commandId: `cmd:${createId()}`,
          threadId: chat.id,
          projectId: project.id,
          title: chat.label ?? DEFAULT_THREAD_TITLE,
          cwd: project.path,
          createdAt: chat.createdAt ?? createdAt
        })
      }
    }
  }
  void migrateAsync().finally(() => {
    localStorage.removeItem(legacyWorkspaceKey)
  })
}

import type {
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationTodoList,
  OrchestrationShellSnapshot,
  ProviderId,
  ThreadShellSummary,
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
    todoLists: [],
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

export function compareThreadsByUpdatedAtDesc(
  left: ThreadShellSummary,
  right: ThreadShellSummary
): number {
  const updatedAtDiff = timestampForSort(right.updatedAt) - timestampForSort(left.updatedAt)
  if (updatedAtDiff !== 0) return updatedAtDiff

  const createdAtDiff = timestampForSort(right.createdAt) - timestampForSort(left.createdAt)
  if (createdAtDiff !== 0) return createdAtDiff

  return left.id.localeCompare(right.id)
}

export function threadsForProject(
  shell: OrchestrationShellSnapshot,
  projectId: string
): ThreadShellSummary[] {
  return shell.threads
    .filter((thread) => thread.projectId === projectId && !thread.archivedAt)
    .sort(compareThreadsByUpdatedAtDesc)
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

function isEmptyAssistantMessage(item: TranscriptItem): boolean {
  return item.kind === 'message' && item.message.role === 'assistant' && item.message.text.trim() === ''
}

export function groupTranscriptItems(
  items: TranscriptItem[],
  providerName: ProviderId | null | undefined = null
): TranscriptRenderGroup[] {
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
    if (providerName === 'opencode' && reasoningRun.length > 0 && isEmptyAssistantMessage(item)) {
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
  const todoLists = thread.todoLists ?? []
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
  if (todoLists.some((todoList) => todoList.items.length > 0)) {
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

function currentInFlightTurnId(thread: OrchestrationThread | null): string | null {
  if (!thread) return null
  return (
    thread.session?.activeTurnId ??
    (thread.latestTurn?.status === 'running' ? thread.latestTurn.id : null)
  )
}

/**
 * A model turn is still in flight (waiting for the next model chunk, tool, or end of turn).
 * - Session can be `ready` with `activeTurnId` set between sub-steps.
 * - Do not short-circuit on `latestTurn.status === 'completed'`: the aggregate can still describe
 *   the *previous* turn for a short window after the user sends while the new turn is starting;
 *   check session first, then `latestTurn`, then `activeTurnId`.
 * - A finished turn (terminal `latestTurn` and no `activeTurnId` and not running) yields false.
 */
export function isOrchestrationModelTurnInProgress(thread: OrchestrationThread | null): boolean {
  if (!thread) return false
  const s = thread.session?.status
  if (s === 'starting' || s === 'running') return true
  const turnSt = thread.latestTurn?.status
  if (turnSt === 'running') return true
  if (thread.session?.activeTurnId) return true
  return false
}

/**
 * After merging a server snapshot, clear the optimistic "pending turn" flag only when the snapshot
 * reflects real model/orchestration progress — not merely `session: ready`, which would fire on every
 * snapshot and hide the thinking row before the model responds.
 */
export function snapshotMergeClearsPendingTurnStart(thread: OrchestrationThread): boolean {
  const todoLists = thread.todoLists ?? []
  if (thread.proposedPlans.length > 0) return true
  if (todoLists.some((todoList) => todoList.items.length > 0)) return true
  if (
    thread.session?.status === 'stopped' ||
    thread.session?.status === 'interrupted' ||
    thread.session?.status === 'error' ||
    thread.session?.status === 'idle'
  ) {
    return true
  }
  const activeTurnId =
    thread.session?.activeTurnId ?? (thread.latestTurn?.status === 'running' ? thread.latestTurn.id : null)
  if (
    activeTurnId &&
    thread.activities.some((activity) => !isHiddenActivity(activity) && activity.turnId === activeTurnId)
  ) {
    return true
  }
  // Do not clear on historical activities alone — any prior tool row would make this true forever
  // on every snapshot. New work clears via this helper when turn/session/assistant show progress
  // or through incremental `thread.activity-upserted` + `eventClearsPendingTurnWait`.
  const last = thread.messages[thread.messages.length - 1]
  if (last?.role === 'assistant') return true
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
    hasActiveThinkingActivity: boolean
  }
): boolean {
  if (input.hasActiveThinkingActivity) return false
  if (thread) {
    const activeTurnId = currentInFlightTurnId(thread)
    if (thread.activities.some(isPendingPrompt)) return false
    if (
      thread.messages.some(
        (message) =>
          activeTurnId !== null &&
          message.role === 'assistant' &&
          message.streaming &&
          message.turnId === activeTurnId
      )
    ) {
      return false
    }
    if (threadHasInFlightWorkIndicator(thread)) {
      return false
    }
  }
  return input.isPendingTurnStart || isOrchestrationModelTurnInProgress(thread)
}

export function eventClearsPendingTurnWait(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case 'thread.message-upserted':
      return event.message.role === 'assistant'
    case 'thread.activity-upserted':
      return !isHiddenActivity(event.activity)
    case 'thread.proposed-plan-upserted':
    case 'thread.todo-list-upserted':
      return true
    case 'thread.latest-turn-set':
      return event.latestTurn !== null && event.latestTurn.status !== 'running'
    case 'thread.session-set': {
      if (event.session === null) {
        return true
      }
      const s = event.session.status
      // Rely on `thread.latest-turn-set` (or assistant message, etc.) to end a turn. Session
      // can stay `ready` (or be re-broadcast as `ready`) while we are still waiting for the
      // first model token after a send, which would spuriously clear the optimistic wait flag.
      if (s === 'ready') {
        return false
      }
      return s === 'stopped' || s === 'interrupted' || s === 'error' || s === 'idle'
    }
    case 'thread.snapshot.changed':
      return snapshotMergeClearsPendingTurnStart(event.thread)
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

/** Same rules as after a full snapshot merge: model/orchestration has actually started. */
export function threadSnapshotHasAssistantResponse(thread: OrchestrationThread): boolean {
  return snapshotMergeClearsPendingTurnStart(thread)
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

export function findLatestTodoList(
  todoLists: OrchestrationTodoList[],
  latestTurnId: string | null
): OrchestrationTodoList | null {
  if (todoLists.length === 0) return null
  const byTurn =
    (latestTurnId
      ? [...todoLists].reverse().find((todoList) => todoList.turnId === latestTurnId)
      : undefined) ?? null
  return byTurn ?? todoLists[todoLists.length - 1] ?? null
}

export function visibleTodoListsForThread(thread: OrchestrationThread | null): OrchestrationTodoList[] {
  if (!thread) return []
  const todoLists = thread.todoLists ?? []
  const latestTodoList = findLatestTodoList(todoLists, thread.latestTurn?.id ?? null)
  if (!latestTodoList) return []
  return todoLists.filter((todoList) => todoList.turnId === latestTodoList.turnId)
}

export function todoProgressForLists(
  todoLists: OrchestrationTodoList[]
): { completed: number; total: number } {
  let completed = 0
  let total = 0
  for (const todoList of todoLists) {
    for (const item of todoList.items) {
      total += 1
      if (item.status === 'completed') completed += 1
    }
  }
  return { completed, total }
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

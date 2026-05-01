import type { OrchestrationEvent, OrchestrationThread } from './agent'

export function applyOrchestrationEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent
): OrchestrationThread {
  if (event.threadId !== thread.id) return thread

  switch (event.type) {
    case 'thread.snapshot.changed':
      return event.thread
    case 'thread.session-set':
      return { ...thread, session: event.session, updatedAt: event.createdAt }
    case 'thread.message-upserted':
      return {
        ...thread,
        messages: upsertById(thread.messages, event.message),
        updatedAt: event.createdAt
      }
    case 'thread.activity-upserted':
      return {
        ...thread,
        activities: upsertById(thread.activities, event.activity),
        updatedAt: event.createdAt
      }
    case 'thread.proposed-plan-upserted':
      return {
        ...thread,
        proposedPlans: upsertById(thread.proposedPlans, event.proposedPlan),
        updatedAt: event.createdAt
      }
    case 'thread.todo-list-upserted':
      return {
        ...thread,
        todoLists: upsertById(thread.todoLists ?? [], event.todoList),
        updatedAt: event.createdAt
      }
    case 'thread.latest-turn-set':
      return { ...thread, latestTurn: event.latestTurn, updatedAt: event.createdAt }
    case 'thread.turn-diff-completed':
      return {
        ...thread,
        checkpoints: upsertCheckpoint(thread.checkpoints, event.checkpoint),
        updatedAt: event.createdAt
      }
    case 'thread.reverted':
      return {
        ...thread,
        messages: thread.messages.filter(
          (message) =>
            !message.turnId ||
            retainedTurnIds(thread.checkpoints, event.turnCount).has(message.turnId)
        ),
        activities: thread.activities.filter(
          (activity) =>
            !activity.turnId ||
            retainedTurnIds(thread.checkpoints, event.turnCount).has(activity.turnId)
        ),
        proposedPlans: thread.proposedPlans.filter((plan) =>
          retainedTurnIds(thread.checkpoints, event.turnCount).has(plan.turnId)
        ),
        todoLists: (thread.todoLists ?? []).filter((todoList) =>
          retainedTurnIds(thread.checkpoints, event.turnCount).has(todoList.turnId)
        ),
        checkpoints: thread.checkpoints.filter(
          (checkpoint) => checkpoint.checkpointTurnCount <= event.turnCount
        ),
        latestTurn: latestRetainedTurn(thread.checkpoints, event.turnCount),
        session: thread.session
          ? { ...thread.session, activeTurnId: null, status: 'ready' }
          : thread.session,
        updatedAt: event.createdAt
      }
    case 'thread.created':
      return {
        ...thread,
        title: event.title,
        cwd: event.cwd,
        branch: event.branch ?? 'main',
        updatedAt: event.createdAt
      }
    case 'thread.renamed':
      return { ...thread, title: event.title, updatedAt: event.createdAt }
    case 'thread.archived':
      return { ...thread, archivedAt: event.createdAt, updatedAt: event.createdAt }
    case 'thread.deleted':
      return thread
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

function upsertCheckpoint<
  T extends { id: string; turnId: string; status: string; checkpointTurnCount: number }
>(items: T[], item: T): T[] {
  const existing = items.find((candidate) => candidate.turnId === item.turnId)
  if (existing && existing.status !== 'missing' && item.status === 'missing') return items
  return [...upsertById(items, item)].sort(
    (left, right) => left.checkpointTurnCount - right.checkpointTurnCount
  )
}

function retainedTurnIds(
  checkpoints: Array<{ turnId: string; checkpointTurnCount: number }>,
  turnCount: number
): Set<string> {
  return new Set(
    checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount <= turnCount)
      .map((checkpoint) => checkpoint.turnId)
  )
}

function latestRetainedTurn(
  checkpoints: Array<{
    turnId: string
    status: string
    checkpointTurnCount: number
    completedAt: string
  }>,
  turnCount: number
) {
  const latest = checkpoints
    .filter((checkpoint) => checkpoint.checkpointTurnCount <= turnCount)
    .sort((left, right) => right.checkpointTurnCount - left.checkpointTurnCount)[0]
  if (!latest) return null
  return {
    id: latest.turnId,
    status: latest.status === 'error' ? ('failed' as const) : ('completed' as const),
    startedAt: latest.completedAt,
    completedAt: latest.completedAt
  }
}

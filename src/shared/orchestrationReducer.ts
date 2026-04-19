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
    case 'thread.latest-turn-set':
      return { ...thread, latestTurn: event.latestTurn, updatedAt: event.createdAt }
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

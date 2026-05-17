import type { OrchestrationEvent } from '../../../shared/agent'
import type { OrchestrationEventStore, StoredOrchestrationEvent } from '../persistence/OrchestrationEventStore'

export class OrchestrationEventReplay {
  constructor(private readonly eventStore: OrchestrationEventStore | null) {}

  replayThreadEvents(input: {
    threadId: string
    fromSequenceExclusive: number
  }): OrchestrationEvent[] {
    if (!this.eventStore) return []
    return this.eventStore
      .readAfter(input.fromSequenceExclusive)
      .filter((event) => event.aggregateKind === 'thread' && event.streamId === input.threadId)
      .map(storedEventToOrchestrationEvent)
      .filter((event): event is OrchestrationEvent => event !== null)
      .sort((left, right) => left.sequence - right.sequence)
  }
}

function storedEventToOrchestrationEvent(event: StoredOrchestrationEvent): OrchestrationEvent | null {
  if (event.sequence === undefined || event.aggregateKind !== 'thread') return null
  const payload = asRecord(event.payload)
  const base = {
    sequence: event.sequence,
    threadId: event.streamId,
    createdAt: event.occurredAt,
    eventId: event.eventId,
    streamVersion: event.streamVersion,
    commandId: event.commandId,
    actorKind: event.actorKind
  }

  switch (event.eventType) {
    case 'thread.snapshot.changed':
      return isRecord(payload.thread) ? { ...base, type: event.eventType, thread: payload.thread as never } : null
    case 'thread.session-set':
      return { ...base, type: event.eventType, session: (payload.session ?? null) as never }
    case 'thread.message-upserted':
      return isRecord(payload.message) ? { ...base, type: event.eventType, message: payload.message as never } : null
    case 'thread.activity-upserted':
      return isRecord(payload.activity)
        ? { ...base, type: event.eventType, activity: payload.activity as never }
        : null
    case 'thread.proposed-plan-upserted':
      return isRecord(payload.proposedPlan)
        ? { ...base, type: event.eventType, proposedPlan: payload.proposedPlan as never }
        : null
    case 'thread.todo-list-upserted':
      return isRecord(payload.todoList)
        ? { ...base, type: event.eventType, todoList: payload.todoList as never }
        : null
    case 'thread.todo-lists-cleared':
      return typeof payload.turnId === 'string' ? { ...base, type: event.eventType, turnId: payload.turnId } : null
    case 'thread.latest-turn-set':
      return { ...base, type: event.eventType, latestTurn: (payload.latestTurn ?? null) as never }
    case 'thread.active-turn-set':
      return { ...base, type: event.eventType, activeTurn: (payload.activeTurn ?? null) as never }
    case 'thread.turn-diff-completed':
      return isRecord(payload.checkpoint)
        ? { ...base, type: event.eventType, checkpoint: payload.checkpoint as never }
        : null
    case 'thread.reverted':
      return typeof payload.turnCount === 'number' && typeof payload.revertedAt === 'string'
        ? { ...base, type: event.eventType, turnCount: payload.turnCount, revertedAt: payload.revertedAt }
        : null
    case 'thread.created':
      return typeof payload.title === 'string'
        ? {
            ...base,
            type: event.eventType,
            title: payload.title,
            projectId: typeof payload.projectId === 'string' ? payload.projectId : '',
            cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
            branch: typeof payload.branch === 'string' ? payload.branch : undefined
          }
        : null
    case 'thread.renamed':
      return typeof payload.title === 'string' ? { ...base, type: event.eventType, title: payload.title } : null
    case 'thread.archived':
    case 'thread.deleted':
      return { ...base, type: event.eventType }
    default:
      return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

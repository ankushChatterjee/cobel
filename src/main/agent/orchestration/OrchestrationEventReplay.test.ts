import { beforeEach, describe, expect, it } from 'vitest'
import type { StoredOrchestrationEvent } from '../persistence/OrchestrationEventStore'
import { OrchestrationEventReplay } from './OrchestrationEventReplay'

let events: StoredOrchestrationEvent[]
let replay: OrchestrationEventReplay

beforeEach(() => {
  events = []
  replay = new OrchestrationEventReplay({
    readAfter: (sequence: number) => events.filter((event) => (event.sequence ?? 0) > sequence)
  } as never)
})

describe('OrchestrationEventReplay', () => {
  it('returns sorted thread events after the requested sequence', () => {
    events.push({
      sequence: 1,
      eventId: 'e1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.message-upserted',
      occurredAt: '2026-05-14T00:00:00.000Z',
      actorKind: 'system',
      payload: { message: message('m1') }
    })
    events.push({
      sequence: 2,
      eventId: 'e2',
      aggregateKind: 'thread',
      streamId: 'thread-2',
      streamVersion: 1,
      eventType: 'thread.message-upserted',
      occurredAt: '2026-05-14T00:00:01.000Z',
      actorKind: 'system',
      payload: { message: message('other') }
    })
    events.push({
      sequence: 3,
      eventId: 'e3',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 2,
      eventType: 'thread.activity-upserted',
      occurredAt: '2026-05-14T00:00:02.000Z',
      actorKind: 'system',
      payload: { activity: activity('tool:edit') }
    })

    const replayed = replay.replayThreadEvents({ threadId: 'thread-1', fromSequenceExclusive: 1 })
    expect(replayed.map((event) => event.sequence)).toEqual([3])
    expect(replayed[0]).toMatchObject({
      type: 'thread.activity-upserted',
      threadId: 'thread-1'
    })
  })
})

function message(id: string) {
  return {
    id,
    role: 'assistant',
    text: 'hello',
    turnId: null,
    streaming: false,
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z'
  }
}

function activity(id: string) {
  return {
    id,
    kind: 'tool.updated',
    tone: 'tool',
    summary: 'Edit',
    payload: { itemType: 'file_change', status: 'inProgress' },
    turnId: 'turn-1',
    createdAt: '2026-05-14T00:00:00.000Z'
  }
}

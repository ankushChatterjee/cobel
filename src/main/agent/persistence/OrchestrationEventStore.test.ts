import { describe, it, expect, beforeEach } from 'vitest'
import { openInMemoryDatabase } from './Sqlite'
import { OrchestrationEventStore } from './OrchestrationEventStore'
import type { Database } from './Sqlite'

let db: Database
let store: OrchestrationEventStore

beforeEach(() => {
  db = openInMemoryDatabase()
  store = new OrchestrationEventStore(db)
})

describe('OrchestrationEventStore', () => {
  it('starts with stream version 0 for unknown streams', () => {
    expect(store.getStreamVersion('thread', 'nonexistent')).toBe(0)
  })

  it('appends an event and returns a sequence number', () => {
    const seq = store.append({
      eventId: 'e1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.message-upserted',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: { message: { id: 'msg-1' } }
    })
    expect(seq).toBe(1)
  })

  it('increments stream version after append', () => {
    store.append({
      eventId: 'e1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.message-upserted',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: {}
    })
    expect(store.getStreamVersion('thread', 'thread-1')).toBe(1)
  })

  it('readAfter returns events appended after given sequence', () => {
    store.append({
      eventId: 'e1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: {}
    })
    store.append({
      eventId: 'e2',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 2,
      eventType: 'thread.message-upserted',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: {}
    })
    const events = store.readAfter(1)
    expect(events).toHaveLength(1)
    expect(events[0]!.eventId).toBe('e2')
  })

  it('appendBatch appends all events atomically', () => {
    const seqs = store.appendBatch([
      {
        eventId: 'b1',
        aggregateKind: 'project',
        streamId: 'proj-1',
        streamVersion: 1,
        eventType: 'project.created',
        occurredAt: new Date().toISOString(),
        actorKind: 'system',
        payload: {}
      },
      {
        eventId: 'b2',
        aggregateKind: 'thread',
        streamId: 'thread-1',
        streamVersion: 1,
        eventType: 'thread.created',
        occurredAt: new Date().toISOString(),
        actorKind: 'system',
        payload: {}
      }
    ])
    expect(seqs).toHaveLength(2)
    expect(store.readAfter(0)).toHaveLength(2)
  })

  it('rejects duplicate event_id', () => {
    store.append({
      eventId: 'dup',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: {}
    })
    expect(() =>
      store.append({
        eventId: 'dup',
        aggregateKind: 'thread',
        streamId: 'thread-1',
        streamVersion: 2,
        eventType: 'thread.created',
        occurredAt: new Date().toISOString(),
        actorKind: 'system',
        payload: {}
      })
    ).toThrow()
  })

  it('rejects duplicate stream version', () => {
    store.append({
      eventId: 'sv1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: {}
    })
    expect(() =>
      store.append({
        eventId: 'sv2',
        aggregateKind: 'thread',
        streamId: 'thread-1',
        streamVersion: 1,
        eventType: 'thread.renamed',
        occurredAt: new Date().toISOString(),
        actorKind: 'system',
        payload: {}
      })
    ).toThrow()
  })

  it('stores and retrieves command receipts', () => {
    store.append({
      eventId: 'r1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      payload: {}
    })
    store.writeCommandReceipt('cmd-1', 1)
    const receipt = store.getCommandReceipt('cmd-1')
    expect(receipt).not.toBeNull()
    expect(receipt!.acceptedSequence).toBe(1)
  })

  it('returns null for unknown command receipt', () => {
    expect(store.getCommandReceipt('unknown')).toBeNull()
  })
})

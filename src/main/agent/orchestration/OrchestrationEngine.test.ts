import { describe, expect, it } from 'vitest'
import { openInMemoryDatabase } from '../persistence/Sqlite'
import { OrchestrationEventStore } from '../persistence/OrchestrationEventStore'
import { ProjectionPipeline } from '../persistence/ProjectionPipeline'
import { SnapshotQuery } from '../persistence/SnapshotQuery'
import { OrchestrationEventReplay } from './OrchestrationEventReplay'
import { OrchestrationEngine } from './OrchestrationEngine'

const now = '2026-05-17T00:00:00.000Z'

describe('OrchestrationEngine committed event stream', () => {
  it('emits the same sequence that replay returns from persistence', () => {
    const { engine, replay } = createDbBackedEngine()
    const received: number[] = []
    engine.subscribeThread('thread-1', (item) => {
      if (item.kind === 'event') received.push(item.event.sequence)
    })

    engine.createThread({
      threadId: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      createdAt: now
    })

    const replayed = replay.replayThreadEvents({ threadId: 'thread-1', fromSequenceExclusive: 0 })
    expect(received).toEqual([replayed[0]?.sequence])
    expect(replayed[0]).toMatchObject({
      sequence: 1,
      eventId: expect.any(String),
      streamVersion: 1,
      type: 'thread.created'
    })
  })

  it('continues live sequences from existing persisted events after restart', () => {
    const db = openInMemoryDatabase()
    const first = createDbBackedEngine(db)
    first.engine.createThread({
      threadId: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      createdAt: now
    })

    const second = createDbBackedEngine(db)
    const received: number[] = []
    second.engine.subscribeThread('thread-1', (item) => {
      if (item.kind === 'event') received.push(item.event.sequence)
    })
    second.engine.renameThread({
      threadId: 'thread-1',
      title: 'Renamed',
      commandId: 'cmd-rename',
      createdAt: '2026-05-17T00:00:01.000Z'
    })

    expect(received).toEqual([2])
    expect(second.replay.replayThreadEvents({ threadId: 'thread-1', fromSequenceExclusive: 1 }))
      .toEqual([expect.objectContaining({ sequence: 2, type: 'thread.renamed' })])
  })

  it('uses persisted command receipts to deduplicate commands', () => {
    const { engine, eventStore } = createDbBackedEngine()
    const command = {
      type: 'provider.session.update' as const,
      commandId: 'cmd-session',
      threadId: 'thread-1',
      status: 'running' as const,
      providerName: 'codex' as const,
      runtimeMode: 'auto-accept-edits' as const,
      interactionMode: 'default' as const,
      activeTurnId: null,
      activePlanId: null,
      lastError: null,
      createdAt: now
    }

    expect(engine.dispatch(command)).toHaveLength(1)
    expect(engine.dispatch(command)).toHaveLength(0)
    expect(eventStore.readAfter(0).filter((event) => event.streamId === 'thread-1')).toHaveLength(1)
    expect(eventStore.getCommandReceipt('cmd-session')).toEqual(
      expect.objectContaining({ acceptedSequence: 1 })
    )
  })

  it('subscribers receive the snapshot plus only events newer than that snapshot', () => {
    const { engine } = createDbBackedEngine()
    engine.createThread({
      threadId: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      createdAt: now
    })

    const received: Array<{ kind: string; sequence: number }> = []
    engine.subscribeThread('thread-1', (item) => {
      if (item.kind === 'snapshot') {
        received.push({ kind: 'snapshot', sequence: item.snapshot.snapshotSequence })
        return
      }
      received.push({ kind: 'event', sequence: item.event.sequence })
    })
    engine.renameThread({
      threadId: 'thread-1',
      title: 'Renamed',
      commandId: 'cmd-rename',
      createdAt: '2026-05-17T00:00:01.000Z'
    })

    expect(received).toEqual([
      { kind: 'snapshot', sequence: 1 },
      { kind: 'event', sequence: 2 }
    ])
  })
})

function createDbBackedEngine(db = openInMemoryDatabase()): {
  engine: OrchestrationEngine
  eventStore: OrchestrationEventStore
  replay: OrchestrationEventReplay
} {
  const eventStore = new OrchestrationEventStore(db)
  const projections = new ProjectionPipeline(db, eventStore)
  projections.bootstrap()
  const snapshots = new SnapshotQuery(db)
  const engine = new OrchestrationEngine({ eventStore, projections, snapshots })
  return { engine, eventStore, replay: new OrchestrationEventReplay(eventStore) }
}

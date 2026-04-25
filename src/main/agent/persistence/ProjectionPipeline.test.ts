import { describe, it, expect, beforeEach } from 'vitest'
import { openInMemoryDatabase } from './Sqlite'
import { OrchestrationEventStore } from './OrchestrationEventStore'
import { ProjectionPipeline } from './ProjectionPipeline'
import { SnapshotQuery } from './SnapshotQuery'
import type { Database } from './Sqlite'

let db: Database
let eventStore: OrchestrationEventStore
let projections: ProjectionPipeline
let snapshots: SnapshotQuery

function now(): string {
  return new Date().toISOString()
}

beforeEach(() => {
  db = openInMemoryDatabase()
  eventStore = new OrchestrationEventStore(db)
  projections = new ProjectionPipeline(db, eventStore)
  snapshots = new SnapshotQuery(db)
})

describe('ProjectionPipeline', () => {
  it('projects project.created into projection_projects', () => {
    const n = now()
    const seq = eventStore.append({
      eventId: 'p1',
      aggregateKind: 'project',
      streamId: 'proj-1',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-1', name: 'My Project', path: '/home/user/proj' }
    })
    projections.apply({ sequence: seq, eventId: 'p1', aggregateKind: 'project', streamId: 'proj-1', streamVersion: 1, eventType: 'project.created', occurredAt: n, actorKind: 'system', payload: { projectId: 'proj-1', name: 'My Project', path: '/home/user/proj' } })
    const shell = snapshots.getShellSnapshot()
    expect(shell.projects).toHaveLength(1)
    expect(shell.projects[0]!.name).toBe('My Project')
    expect(shell.projects[0]!.path).toBe('/home/user/proj')
  })

  it('projects thread.created and thread.message-upserted', () => {
    const n = now()
    // project first
    const ps = eventStore.append({ eventId: 'p1', aggregateKind: 'project', streamId: 'proj-1', streamVersion: 1, eventType: 'project.created', occurredAt: n, actorKind: 'system', payload: { projectId: 'proj-1', name: 'P', path: '/p' } })
    projections.apply({ sequence: ps, eventId: 'p1', aggregateKind: 'project', streamId: 'proj-1', streamVersion: 1, eventType: 'project.created', occurredAt: n, actorKind: 'system', payload: { projectId: 'proj-1', name: 'P', path: '/p' } })

    const ts = eventStore.append({ eventId: 't1', aggregateKind: 'thread', streamId: 'thread-1', streamVersion: 1, eventType: 'thread.created', occurredAt: n, actorKind: 'system', payload: { threadId: 'thread-1', projectId: 'proj-1', title: 'My chat' } })
    projections.apply({ sequence: ts, eventId: 't1', aggregateKind: 'thread', streamId: 'thread-1', streamVersion: 1, eventType: 'thread.created', occurredAt: n, actorKind: 'system', payload: { threadId: 'thread-1', projectId: 'proj-1', title: 'My chat' } })

    const ms = eventStore.append({ eventId: 'm1', aggregateKind: 'thread', streamId: 'thread-1', streamVersion: 2, eventType: 'thread.message-upserted', occurredAt: n, actorKind: 'system', payload: { message: { id: 'msg-1', role: 'user', text: 'Hello', turnId: null, streaming: false, createdAt: n, updatedAt: n } } })
    projections.apply({ sequence: ms, eventId: 'm1', aggregateKind: 'thread', streamId: 'thread-1', streamVersion: 2, eventType: 'thread.message-upserted', occurredAt: n, actorKind: 'system', payload: { message: { id: 'msg-1', role: 'user', text: 'Hello', turnId: null, streaming: false, createdAt: n, updatedAt: n } } })

    const detail = snapshots.getThreadDetail('thread-1')
    expect(detail).not.toBeNull()
    expect(detail!.title).toBe('My chat')
    expect(detail!.messages).toHaveLength(1)
    expect(detail!.messages[0]!.text).toBe('Hello')
  })

  it('bootstrap() replays missed events from event store', () => {
    const n = now()
    // Write events directly to the event store (simulating a crash before projection ran)
    eventStore.append({ eventId: 'p2', aggregateKind: 'project', streamId: 'proj-2', streamVersion: 1, eventType: 'project.created', occurredAt: n, actorKind: 'system', payload: { projectId: 'proj-2', name: 'Recovered', path: '/r' } })
    eventStore.append({ eventId: 't2', aggregateKind: 'thread', streamId: 'thread-2', streamVersion: 1, eventType: 'thread.created', occurredAt: n, actorKind: 'system', payload: { threadId: 'thread-2', projectId: 'proj-2', title: 'Recovered thread' } })

    // Create a fresh pipeline (projection_state cursor at 0) and bootstrap
    const freshProjections = new ProjectionPipeline(db, eventStore)
    freshProjections.bootstrap()

    const shell = snapshots.getShellSnapshot()
    expect(shell.projects.some((p) => p.id === 'proj-2')).toBe(true)
    const threads = shell.threads.filter((t) => t.id === 'thread-2')
    expect(threads).toHaveLength(1)
  })

  it('bootstrap() is idempotent when projection_state cursor is current', () => {
    const n = now()
    const ps = eventStore.append({ eventId: 'p3', aggregateKind: 'project', streamId: 'proj-3', streamVersion: 1, eventType: 'project.created', occurredAt: n, actorKind: 'system', payload: { projectId: 'proj-3', name: 'Idempotent', path: '/i' } })
    projections.apply({ sequence: ps, eventId: 'p3', aggregateKind: 'project', streamId: 'proj-3', streamVersion: 1, eventType: 'project.created', occurredAt: n, actorKind: 'system', payload: { projectId: 'proj-3', name: 'Idempotent', path: '/i' } })

    // Run bootstrap again — should not duplicate
    projections.bootstrap()
    const shell = snapshots.getShellSnapshot()
    expect(shell.projects.filter((p) => p.id === 'proj-3')).toHaveLength(1)
  })

  it('projects thread.session-set into projection_thread_sessions', () => {
    const n = now()
    const ts = eventStore.append({ eventId: 'tc1', aggregateKind: 'thread', streamId: 'thread-s', streamVersion: 1, eventType: 'thread.created', occurredAt: n, actorKind: 'system', payload: { threadId: 'thread-s', projectId: 'proj-1', title: 'Session test' } })
    projections.apply({ sequence: ts, eventId: 'tc1', aggregateKind: 'thread', streamId: 'thread-s', streamVersion: 1, eventType: 'thread.created', occurredAt: n, actorKind: 'system', payload: { threadId: 'thread-s', projectId: 'proj-1', title: 'Session test' } })

    const ss = eventStore.append({ eventId: 'ss1', aggregateKind: 'thread', streamId: 'thread-s', streamVersion: 2, eventType: 'thread.session-set', occurredAt: n, actorKind: 'system', payload: { session: { status: 'ready', providerName: 'codex', runtimeMode: 'auto-accept-edits', interactionMode: 'default', effort: 'high', activeTurnId: null, lastError: null } } })
    projections.apply({ sequence: ss, eventId: 'ss1', aggregateKind: 'thread', streamId: 'thread-s', streamVersion: 2, eventType: 'thread.session-set', occurredAt: n, actorKind: 'system', payload: { session: { status: 'ready', providerName: 'codex', runtimeMode: 'auto-accept-edits', interactionMode: 'default', effort: 'high', activeTurnId: null, lastError: null } } })

    const detail = snapshots.getThreadDetail('thread-s')
    expect(detail?.session?.status).toBe('ready')
    expect(detail?.session?.providerName).toBe('codex')
    expect(detail?.session?.interactionMode).toBe('default')
    expect(detail?.session?.effort).toBe('high')
  })
})

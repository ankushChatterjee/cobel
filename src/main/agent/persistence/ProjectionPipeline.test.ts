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
    projections.apply({
      sequence: seq,
      eventId: 'p1',
      aggregateKind: 'project',
      streamId: 'proj-1',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-1', name: 'My Project', path: '/home/user/proj' }
    })
    const shell = snapshots.getShellSnapshot()
    expect(shell.projects).toHaveLength(1)
    expect(shell.projects[0]!.name).toBe('My Project')
    expect(shell.projects[0]!.path).toBe('/home/user/proj')
  })

  it('projects thread.created and thread.message-upserted', () => {
    const n = now()
    // project first
    const ps = eventStore.append({
      eventId: 'p1',
      aggregateKind: 'project',
      streamId: 'proj-1',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-1', name: 'P', path: '/p' }
    })
    projections.apply({
      sequence: ps,
      eventId: 'p1',
      aggregateKind: 'project',
      streamId: 'proj-1',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-1', name: 'P', path: '/p' }
    })

    const ts = eventStore.append({
      eventId: 't1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-1', projectId: 'proj-1', title: 'My chat' }
    })
    projections.apply({
      sequence: ts,
      eventId: 't1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-1', projectId: 'proj-1', title: 'My chat' }
    })

    const ms = eventStore.append({
      eventId: 'm1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 2,
      eventType: 'thread.message-upserted',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        message: {
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          turnId: null,
          streaming: false,
          createdAt: n,
          updatedAt: n
        }
      }
    })
    projections.apply({
      sequence: ms,
      eventId: 'm1',
      aggregateKind: 'thread',
      streamId: 'thread-1',
      streamVersion: 2,
      eventType: 'thread.message-upserted',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        message: {
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          turnId: null,
          streaming: false,
          createdAt: n,
          updatedAt: n
        }
      }
    })

    const detail = snapshots.getThreadDetail('thread-1')
    expect(detail).not.toBeNull()
    expect(detail!.title).toBe('My chat')
    expect(detail!.messages).toHaveLength(1)
    expect(detail!.messages[0]!.text).toBe('Hello')
  })

  it('bootstrap() replays missed events from event store', () => {
    const n = now()
    // Write events directly to the event store (simulating a crash before projection ran)
    eventStore.append({
      eventId: 'p2',
      aggregateKind: 'project',
      streamId: 'proj-2',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-2', name: 'Recovered', path: '/r' }
    })
    eventStore.append({
      eventId: 't2',
      aggregateKind: 'thread',
      streamId: 'thread-2',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-2', projectId: 'proj-2', title: 'Recovered thread' }
    })

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
    const ps = eventStore.append({
      eventId: 'p3',
      aggregateKind: 'project',
      streamId: 'proj-3',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-3', name: 'Idempotent', path: '/i' }
    })
    projections.apply({
      sequence: ps,
      eventId: 'p3',
      aggregateKind: 'project',
      streamId: 'proj-3',
      streamVersion: 1,
      eventType: 'project.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { projectId: 'proj-3', name: 'Idempotent', path: '/i' }
    })

    // Run bootstrap again — should not duplicate
    projections.bootstrap()
    const shell = snapshots.getShellSnapshot()
    expect(shell.projects.filter((p) => p.id === 'proj-3')).toHaveLength(1)
  })

  it('projects thread.session-set into projection_thread_sessions', () => {
    const n = now()
    const ts = eventStore.append({
      eventId: 'tc1',
      aggregateKind: 'thread',
      streamId: 'thread-s',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-s', projectId: 'proj-1', title: 'Session test' }
    })
    projections.apply({
      sequence: ts,
      eventId: 'tc1',
      aggregateKind: 'thread',
      streamId: 'thread-s',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-s', projectId: 'proj-1', title: 'Session test' }
    })

    const ss = eventStore.append({
      eventId: 'ss1',
      aggregateKind: 'thread',
      streamId: 'thread-s',
      streamVersion: 2,
      eventType: 'thread.session-set',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        session: {
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          model: 'gpt-5.4',
          effort: 'high',
          activeTurnId: null,
          lastError: null
        }
      }
    })
    projections.apply({
      sequence: ss,
      eventId: 'ss1',
      aggregateKind: 'thread',
      streamId: 'thread-s',
      streamVersion: 2,
      eventType: 'thread.session-set',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        session: {
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          model: 'gpt-5.4',
          effort: 'high',
          activeTurnId: null,
          lastError: null
        }
      }
    })

    const detail = snapshots.getThreadDetail('thread-s')
    expect(detail?.session?.status).toBe('ready')
    expect(detail?.session?.providerName).toBe('codex')
    expect(detail?.session?.interactionMode).toBe('default')
    expect(detail?.session?.model).toBe('gpt-5.4')
    expect(detail?.session?.effort).toBe('high')
  })

  it('deletes persisted sessions when thread.session-set carries null', () => {
    const n = now()
    const ts = eventStore.append({
      eventId: 'null-session-thread',
      aggregateKind: 'thread',
      streamId: 'thread-null-session',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-null-session', projectId: 'proj-1', title: 'Null session test' }
    })
    projections.apply({
      sequence: ts,
      eventId: 'null-session-thread',
      aggregateKind: 'thread',
      streamId: 'thread-null-session',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-null-session', projectId: 'proj-1', title: 'Null session test' }
    })

    const ss = eventStore.append({
      eventId: 'null-session-set',
      aggregateKind: 'thread',
      streamId: 'thread-null-session',
      streamVersion: 2,
      eventType: 'thread.session-set',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        session: {
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: null,
          activePlanId: null,
          lastError: null
        }
      }
    })
    projections.apply({
      sequence: ss,
      eventId: 'null-session-set',
      aggregateKind: 'thread',
      streamId: 'thread-null-session',
      streamVersion: 2,
      eventType: 'thread.session-set',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        session: {
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: null,
          activePlanId: null,
          lastError: null
        }
      }
    })

    expect(snapshots.getThreadDetail('thread-null-session')?.session?.status).toBe('ready')

    const clearedAt = now()
    const clearSeq = eventStore.append({
      eventId: 'null-session-clear',
      aggregateKind: 'thread',
      streamId: 'thread-null-session',
      streamVersion: 3,
      eventType: 'thread.session-set',
      occurredAt: clearedAt,
      actorKind: 'system',
      payload: { session: null }
    })
    projections.apply({
      sequence: clearSeq,
      eventId: 'null-session-clear',
      aggregateKind: 'thread',
      streamId: 'thread-null-session',
      streamVersion: 3,
      eventType: 'thread.session-set',
      occurredAt: clearedAt,
      actorKind: 'system',
      payload: { session: null }
    })

    const detail = snapshots.getThreadDetail('thread-null-session')
    expect(detail?.session).toBeNull()
    expect(detail?.updatedAt).toBe(clearedAt)
  })

  it('persists and reloads thread todo lists', () => {
    const n = now()
    const ts = eventStore.append({
      eventId: 'todo-thread',
      aggregateKind: 'thread',
      streamId: 'thread-todo',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-todo', projectId: 'proj-1', title: 'Todo test' }
    })
    projections.apply({
      sequence: ts,
      eventId: 'todo-thread',
      aggregateKind: 'thread',
      streamId: 'thread-todo',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-todo', projectId: 'proj-1', title: 'Todo test' }
    })

    const ls = eventStore.append({
      eventId: 'todo-list-1',
      aggregateKind: 'thread',
      streamId: 'thread-todo',
      streamVersion: 2,
      eventType: 'thread.todo-list-upserted',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        todoList: {
          id: 'todo:thread-todo:turn:turn-1:todo',
          turnId: 'turn-1',
          source: 'todo',
          title: 'Todos',
          items: [{ id: 'todo-1', text: 'Persist checklist data', status: 'completed', order: 0 }],
          createdAt: n,
          updatedAt: n
        }
      }
    })
    projections.apply({
      sequence: ls,
      eventId: 'todo-list-1',
      aggregateKind: 'thread',
      streamId: 'thread-todo',
      streamVersion: 2,
      eventType: 'thread.todo-list-upserted',
      occurredAt: n,
      actorKind: 'system',
      payload: {
        todoList: {
          id: 'todo:thread-todo:turn:turn-1:todo',
          turnId: 'turn-1',
          source: 'todo',
          title: 'Todos',
          items: [{ id: 'todo-1', text: 'Persist checklist data', status: 'completed', order: 0 }],
          createdAt: n,
          updatedAt: n
        }
      }
    })

    const detail = snapshots.getThreadDetail('thread-todo')
    expect(detail?.todoLists).toEqual([
      expect.objectContaining({
        source: 'todo',
        title: 'Todos',
        items: [expect.objectContaining({ text: 'Persist checklist data', status: 'completed' })]
      })
    ])

    const clearedAt = now()
    const clearSeq = eventStore.append({
      eventId: 'todo-list-clear-1',
      aggregateKind: 'thread',
      streamId: 'thread-todo',
      streamVersion: 3,
      eventType: 'thread.todo-lists-cleared',
      occurredAt: clearedAt,
      actorKind: 'system',
      payload: { turnId: 'turn-1' }
    })
    projections.apply({
      sequence: clearSeq,
      eventId: 'todo-list-clear-1',
      aggregateKind: 'thread',
      streamId: 'thread-todo',
      streamVersion: 3,
      eventType: 'thread.todo-lists-cleared',
      occurredAt: clearedAt,
      actorKind: 'system',
      payload: { turnId: 'turn-1' }
    })

    expect(snapshots.getThreadDetail('thread-todo')?.todoLists).toEqual([])
  })

  it('updates persisted proposed plans with the latest turn id and thread updated_at', () => {
    const createdAt = '2026-04-19T00:00:00.000Z'
    const updatedAt = '2026-04-19T00:00:05.000Z'
    const threadSeq = eventStore.append({
      eventId: 'thread-plan',
      aggregateKind: 'thread',
      streamId: 'thread-plan',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: createdAt,
      actorKind: 'system',
      payload: { threadId: 'thread-plan', projectId: 'proj-1', title: 'Plan thread' }
    })
    projections.apply({
      sequence: threadSeq,
      eventId: 'thread-plan',
      aggregateKind: 'thread',
      streamId: 'thread-plan',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: createdAt,
      actorKind: 'system',
      payload: { threadId: 'thread-plan', projectId: 'proj-1', title: 'Plan thread' }
    })

    const firstPlanSeq = eventStore.append({
      eventId: 'plan-1',
      aggregateKind: 'thread',
      streamId: 'thread-plan',
      streamVersion: 2,
      eventType: 'thread.proposed-plan-upserted',
      occurredAt: createdAt,
      actorKind: 'system',
      payload: {
        proposedPlan: {
          id: 'plan:thread-plan:turn:turn-1',
          turnId: 'turn-1',
          text: 'Original plan',
          status: 'proposed',
          createdAt,
          updatedAt: createdAt
        }
      }
    })
    projections.apply({
      sequence: firstPlanSeq,
      eventId: 'plan-1',
      aggregateKind: 'thread',
      streamId: 'thread-plan',
      streamVersion: 2,
      eventType: 'thread.proposed-plan-upserted',
      occurredAt: createdAt,
      actorKind: 'system',
      payload: {
        proposedPlan: {
          id: 'plan:thread-plan:turn:turn-1',
          turnId: 'turn-1',
          text: 'Original plan',
          status: 'proposed',
          createdAt,
          updatedAt: createdAt
        }
      }
    })

    const refinedPlanSeq = eventStore.append({
      eventId: 'plan-2',
      aggregateKind: 'thread',
      streamId: 'thread-plan',
      streamVersion: 3,
      eventType: 'thread.proposed-plan-upserted',
      occurredAt: updatedAt,
      actorKind: 'system',
      payload: {
        proposedPlan: {
          id: 'plan:thread-plan:turn:turn-1',
          turnId: 'turn-2',
          text: 'Refined plan',
          status: 'proposed',
          createdAt,
          updatedAt
        }
      }
    })
    projections.apply({
      sequence: refinedPlanSeq,
      eventId: 'plan-2',
      aggregateKind: 'thread',
      streamId: 'thread-plan',
      streamVersion: 3,
      eventType: 'thread.proposed-plan-upserted',
      occurredAt: updatedAt,
      actorKind: 'system',
      payload: {
        proposedPlan: {
          id: 'plan:thread-plan:turn:turn-1',
          turnId: 'turn-2',
          text: 'Refined plan',
          status: 'proposed',
          createdAt,
          updatedAt
        }
      }
    })

    const detail = snapshots.getThreadDetail('thread-plan')
    expect(detail?.proposedPlans).toEqual([
      expect.objectContaining({
        id: 'plan:thread-plan:turn:turn-1',
        turnId: 'turn-2',
        text: 'Refined plan',
        updatedAt
      })
    ])

    const shellThread = snapshots
      .getShellSnapshot()
      .threads.find((thread) => thread.id === 'thread-plan')
    expect(shellThread?.updatedAt).toBe(updatedAt)
  })

  it('persists thread.active-turn-set and snapshot reads back activeTurn', () => {
    const n = now()
    const ts = eventStore.append({
      eventId: 'at-thread',
      aggregateKind: 'thread',
      streamId: 'thread-active-turn',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-active-turn', projectId: 'proj-1', title: 'AT' }
    })
    projections.apply({
      sequence: ts,
      eventId: 'at-thread',
      aggregateKind: 'thread',
      streamId: 'thread-active-turn',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-active-turn', projectId: 'proj-1', title: 'AT' }
    })

    const activeTurn = {
      turnId: 'turn-x',
      phase: 'thinking' as const,
      activeItemIds: ['item-1'],
      visibleIndicator: 'thinking' as const,
      startedAt: n,
      updatedAt: n
    }
    const atSeq = eventStore.append({
      eventId: 'at-set',
      aggregateKind: 'thread',
      streamId: 'thread-active-turn',
      streamVersion: 2,
      eventType: 'thread.active-turn-set',
      occurredAt: n,
      actorKind: 'system',
      payload: { activeTurn }
    })
    projections.apply({
      sequence: atSeq,
      eventId: 'at-set',
      aggregateKind: 'thread',
      streamId: 'thread-active-turn',
      streamVersion: 2,
      eventType: 'thread.active-turn-set',
      occurredAt: n,
      actorKind: 'system',
      payload: { activeTurn }
    })

    expect(snapshots.getThreadDetail('thread-active-turn')?.activeTurn).toEqual(activeTurn)
  })

  it('thread.active-turn-set with null clears active_turn_json', () => {
    const n = now()
    const ts = eventStore.append({
      eventId: 'at2-thread',
      aggregateKind: 'thread',
      streamId: 'thread-active-null',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-active-null', projectId: 'proj-1', title: 'ATN' }
    })
    projections.apply({
      sequence: ts,
      eventId: 'at2-thread',
      aggregateKind: 'thread',
      streamId: 'thread-active-null',
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: n,
      actorKind: 'system',
      payload: { threadId: 'thread-active-null', projectId: 'proj-1', title: 'ATN' }
    })

    const activeTurn = {
      turnId: 't',
      phase: 'starting' as const,
      activeItemIds: [],
      visibleIndicator: 'exploring' as const,
      startedAt: n,
      updatedAt: n
    }
    const s2 = eventStore.append({
      eventId: 'at2-set',
      aggregateKind: 'thread',
      streamId: 'thread-active-null',
      streamVersion: 2,
      eventType: 'thread.active-turn-set',
      occurredAt: n,
      actorKind: 'system',
      payload: { activeTurn }
    })
    projections.apply({
      sequence: s2,
      eventId: 'at2-set',
      aggregateKind: 'thread',
      streamId: 'thread-active-null',
      streamVersion: 2,
      eventType: 'thread.active-turn-set',
      occurredAt: n,
      actorKind: 'system',
      payload: { activeTurn }
    })

    const s3 = eventStore.append({
      eventId: 'at2-clear',
      aggregateKind: 'thread',
      streamId: 'thread-active-null',
      streamVersion: 3,
      eventType: 'thread.active-turn-set',
      occurredAt: n,
      actorKind: 'system',
      payload: { activeTurn: null }
    })
    projections.apply({
      sequence: s3,
      eventId: 'at2-clear',
      aggregateKind: 'thread',
      streamId: 'thread-active-null',
      streamVersion: 3,
      eventType: 'thread.active-turn-set',
      occurredAt: n,
      actorKind: 'system',
      payload: { activeTurn: null }
    })

    expect(snapshots.getThreadDetail('thread-active-null')?.activeTurn).toBeNull()
  })

  it('replaces all persisted thread detail rows from thread.snapshot.changed', () => {
    const staleAt = '2026-04-19T00:00:00.000Z'
    const snapshotAt = '2026-04-19T00:01:00.000Z'
    const threadId = 'thread-snapshot-replace'
    const createSeq = eventStore.append({
      eventId: 'snapshot-thread',
      aggregateKind: 'thread',
      streamId: threadId,
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: staleAt,
      actorKind: 'system',
      payload: { threadId, projectId: 'proj-1', title: 'Stale title' }
    })
    projections.apply({
      sequence: createSeq,
      eventId: 'snapshot-thread',
      aggregateKind: 'thread',
      streamId: threadId,
      streamVersion: 1,
      eventType: 'thread.created',
      occurredAt: staleAt,
      actorKind: 'system',
      payload: { threadId, projectId: 'proj-1', title: 'Stale title' }
    })

    const staleEvents = [
      {
        eventId: 'snapshot-stale-message',
        eventType: 'thread.message-upserted',
        payload: {
          message: {
            id: 'message-stale',
            role: 'assistant',
            text: 'stale',
            turnId: 'turn-stale',
            streaming: false,
            createdAt: staleAt,
            updatedAt: staleAt
          }
        }
      },
      {
        eventId: 'snapshot-stale-activity',
        eventType: 'thread.activity-upserted',
        payload: {
          activity: {
            id: 'activity-stale',
            kind: 'tool.completed',
            tone: 'tool',
            summary: 'stale tool',
            turnId: 'turn-stale',
            resolved: true,
            createdAt: staleAt
          }
        }
      },
      {
        eventId: 'snapshot-stale-plan',
        eventType: 'thread.proposed-plan-upserted',
        payload: {
          proposedPlan: {
            id: 'plan-stale',
            turnId: 'turn-stale',
            text: 'stale plan',
            status: 'proposed',
            createdAt: staleAt,
            updatedAt: staleAt
          }
        }
      },
      {
        eventId: 'snapshot-stale-todo',
        eventType: 'thread.todo-list-upserted',
        payload: {
          todoList: {
            id: 'todo-stale',
            turnId: 'turn-stale',
            source: 'todo',
            items: [{ id: 'todo-stale-1', text: 'stale todo', status: 'pending', order: 0 }],
            createdAt: staleAt,
            updatedAt: staleAt
          }
        }
      },
      {
        eventId: 'snapshot-stale-session',
        eventType: 'thread.session-set',
        payload: {
          session: {
            status: 'running',
            providerName: 'codex',
            runtimeMode: 'auto-accept-edits',
            interactionMode: 'default',
            activeTurnId: 'turn-stale',
            activePlanId: null,
            lastError: null
          }
        }
      },
      {
        eventId: 'snapshot-stale-latest',
        eventType: 'thread.latest-turn-set',
        payload: {
          latestTurn: {
            id: 'turn-stale',
            status: 'running',
            startedAt: staleAt,
            completedAt: null
          }
        }
      },
      {
        eventId: 'snapshot-stale-active',
        eventType: 'thread.active-turn-set',
        payload: {
          activeTurn: {
            turnId: 'turn-stale',
            phase: 'tool_running',
            activeItemIds: ['tool-stale'],
            visibleIndicator: 'tool',
            startedAt: staleAt,
            updatedAt: staleAt
          }
        }
      },
      {
        eventId: 'snapshot-stale-checkpoint',
        eventType: 'thread.turn-diff-completed',
        payload: {
          checkpoint: {
            id: 'checkpoint-stale',
            turnId: 'turn-stale',
            checkpointTurnCount: 1,
            status: 'ready',
            files: [],
            completedAt: staleAt
          }
        }
      }
    ]
    staleEvents.forEach((event, index) => {
      const seq = eventStore.append({
        eventId: event.eventId,
        aggregateKind: 'thread',
        streamId: threadId,
        streamVersion: index + 2,
        eventType: event.eventType,
        occurredAt: staleAt,
        actorKind: 'system',
        payload: event.payload
      })
      projections.apply({
        sequence: seq,
        eventId: event.eventId,
        aggregateKind: 'thread',
        streamId: threadId,
        streamVersion: index + 2,
        eventType: event.eventType,
        occurredAt: staleAt,
        actorKind: 'system',
        payload: event.payload
      })
    })

    const replacementThread = {
      id: threadId,
      title: 'Replacement title',
      cwd: '/replacement',
      branch: 'feature/replacement',
      messages: [
        {
          id: 'message-new',
          role: 'assistant',
          text: 'new',
          turnId: 'turn-new',
          streaming: false,
          sequence: 50,
          createdAt: snapshotAt,
          updatedAt: snapshotAt
        }
      ],
      activities: [
        {
          id: 'activity-new',
          kind: 'task.completed',
          tone: 'thinking',
          summary: 'new thought',
          turnId: 'turn-new',
          resolved: true,
          createdAt: snapshotAt
        }
      ],
      proposedPlans: [
        {
          id: 'plan-new',
          turnId: 'turn-new',
          text: 'new plan',
          status: 'proposed',
          createdAt: snapshotAt,
          updatedAt: snapshotAt
        }
      ],
      todoLists: [
        {
          id: 'todo-new',
          turnId: 'turn-new',
          source: 'todo',
          items: [{ id: 'todo-new-1', text: 'new todo', status: 'completed', order: 0 }],
          createdAt: snapshotAt,
          updatedAt: snapshotAt
        }
      ],
      session: {
        threadId,
        status: 'ready',
        providerName: 'opencode',
        runtimeMode: 'approval-required',
        interactionMode: 'plan',
        model: 'anthropic/claude-sonnet-4',
        activeTurnId: null,
        activePlanId: 'plan-new',
        lastError: null,
        updatedAt: snapshotAt
      },
      latestTurn: {
        id: 'turn-new',
        status: 'completed',
        startedAt: snapshotAt,
        completedAt: snapshotAt
      },
      activeTurn: {
        turnId: 'turn-new',
        phase: 'completed',
        activeItemIds: [],
        visibleIndicator: 'none',
        startedAt: snapshotAt,
        updatedAt: snapshotAt
      },
      checkpoints: [
        {
          id: 'checkpoint-new',
          turnId: 'turn-new',
          assistantMessageId: 'message-new',
          checkpointTurnCount: 2,
          status: 'ready',
          files: [{ path: 'src/app.ts', kind: 'modified', additions: 1, deletions: 1 }],
          completedAt: snapshotAt
        }
      ],
      createdAt: staleAt,
      updatedAt: snapshotAt,
      archivedAt: null
    }
    const snapshotSeq = eventStore.append({
      eventId: 'snapshot-replacement',
      aggregateKind: 'thread',
      streamId: threadId,
      streamVersion: 10,
      eventType: 'thread.snapshot.changed',
      occurredAt: snapshotAt,
      actorKind: 'system',
      payload: { thread: replacementThread }
    })
    projections.apply({
      sequence: snapshotSeq,
      eventId: 'snapshot-replacement',
      aggregateKind: 'thread',
      streamId: threadId,
      streamVersion: 10,
      eventType: 'thread.snapshot.changed',
      occurredAt: snapshotAt,
      actorKind: 'system',
      payload: { thread: replacementThread }
    })

    const detail = snapshots.getThreadDetail(threadId)
    expect(detail).toEqual(
      expect.objectContaining({
        title: 'Replacement title',
        cwd: '/replacement',
        branch: 'feature/replacement',
        updatedAt: snapshotAt,
        session: expect.objectContaining({
          providerName: 'opencode',
          activePlanId: 'plan-new'
        }),
        latestTurn: expect.objectContaining({ id: 'turn-new' }),
        activeTurn: replacementThread.activeTurn
      })
    )
    expect(detail?.messages.map((message) => message.id)).toEqual(['message-new'])
    expect(detail?.activities.map((activity) => activity.id)).toEqual(['activity-new'])
    expect(detail?.proposedPlans.map((plan) => plan.id)).toEqual(['plan-new'])
    expect(detail?.todoLists.map((todoList) => todoList.id)).toEqual(['todo-new'])
    expect(detail?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(['checkpoint-new'])

    const shellThread = snapshots
      .getShellSnapshot()
      .threads.find((thread) => thread.id === threadId)
    expect(shellThread?.latestTurnId).toBe('turn-new')
  })
})

import { describe, expect, it } from 'vitest'
import type { OrchestrationEvent, OrchestrationThread, OrchestrationThreadActivity } from '../../../shared/agent'
import {
  applyThreadStreamEvent,
  applyThreadStreamEventBatch,
  applyThreadStreamSnapshot,
  createThreadStreamState,
  markReplayApplied
} from './threadStreamReducer'

const now = '2026-05-14T00:00:00.000Z'

function thread(providerName: 'codex' | 'opencode' = 'codex'): OrchestrationThread {
  return {
    id: 'thread-1',
    title: 'Thread',
    cwd: '/tmp/project',
    branch: 'main',
    messages: [],
    activities: [],
    proposedPlans: [],
    todoLists: [],
    session: {
      threadId: 'thread-1',
      status: 'running',
      providerName,
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      activeTurnId: 'turn-1',
      activePlanId: null,
      lastError: null,
      updatedAt: now
    },
    latestTurn: { id: 'turn-1', status: 'running', startedAt: now, completedAt: null },
    activeTurn: {
      turnId: 'turn-1',
      phase: 'tool_running',
      activeItemIds: ['tool:edit'],
      visibleIndicator: 'tool',
      startedAt: now,
      updatedAt: now
    },
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  }
}

function activity(status: 'inProgress' | 'completed'): OrchestrationThreadActivity {
  return {
    id: 'tool:edit',
    kind: status === 'completed' ? 'tool.completed' : 'tool.updated',
    tone: 'tool',
    summary: 'Edit file',
    payload: { itemType: 'file_change', status },
    turnId: 'turn-1',
    sequence: 10,
    createdAt: now
  }
}

function activityEvent(sequence: number, status: 'inProgress' | 'completed'): OrchestrationEvent {
  return {
    sequence,
    type: 'thread.activity-upserted',
    threadId: 'thread-1',
    activity: activity(status),
    createdAt: now
  }
}

function commandActivityEvent(
  sequence: number,
  providerName: 'codex' | 'opencode'
): OrchestrationEvent {
  return {
    sequence,
    type: 'thread.activity-upserted',
    threadId: 'thread-1',
    activity: {
      id: `tool:${providerName}:command-1`,
      kind: 'tool.started',
      tone: 'tool',
      summary: 'Run tests',
      payload: {
        itemType: 'command_execution',
        status: 'inProgress',
        title: '/bin/zsh -lc "bun test"'
      },
      turnId: 'turn-1',
      sequence,
      createdAt: now
    },
    createdAt: now
  }
}

function withoutNodeProcess<T>(callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')
  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    value: undefined
  })
  try {
    return callback()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'process', descriptor)
    else Reflect.deleteProperty(globalThis, 'process')
  }
}

describe('threadStreamReducer', () => {
  it('ignores a stale snapshot that arrives after live detail events', () => {
    const state = createThreadStreamState()
    const eventResult = applyThreadStreamEvent(state, activityEvent(1, 'inProgress'))
    expect(eventResult.thread.activities).toHaveLength(1)

    const snapshotResult = applyThreadStreamSnapshot(state, { snapshotSequence: 0, thread: thread() })
    expect(snapshotResult.thread.activities).toHaveLength(1)
    expect(snapshotResult.thread.activities[0]?.payload?.status).toBe('inProgress')
  })

  it('skips older out-of-order events after a higher event has applied', () => {
    const state = createThreadStreamState()
    applyThreadStreamSnapshot(state, { snapshotSequence: 9, thread: thread() })
    applyThreadStreamEvent(state, activityEvent(10, 'inProgress'))
    applyThreadStreamEvent(state, {
      sequence: 12,
      type: 'thread.active-turn-set',
      threadId: 'thread-1',
      activeTurn: thread().activeTurn,
      createdAt: now
    })

    const result = applyThreadStreamEvent(state, activityEvent(11, 'completed'))
    expect(result.duplicate).toBe(true)
    expect(result.thread.activities[0]).toMatchObject({
      kind: 'tool.updated',
      payload: expect.objectContaining({ status: 'inProgress' })
    })
  })

  it('reports sequence gaps without blocking the live event', () => {
    const state = createThreadStreamState()
    applyThreadStreamSnapshot(state, { snapshotSequence: 3, thread: thread() })
    const result = applyThreadStreamEvent(state, activityEvent(7, 'inProgress'))
    expect(result.gapFromSequence).toBe(3)
    expect(result.thread.activities).toHaveLength(1)
  })

  it('does not let a stale snapshot roll active turn state backward', () => {
    const state = createThreadStreamState()
    applyThreadStreamSnapshot(state, { snapshotSequence: 3, thread: thread() })
    applyThreadStreamEvent(state, {
      sequence: 4,
      type: 'thread.active-turn-set',
      threadId: 'thread-1',
      activeTurn: null,
      createdAt: now
    })

    const staleThread = thread()
    const result = applyThreadStreamSnapshot(state, { snapshotSequence: 3, thread: staleThread })
    expect(result.thread.activeTurn).toBeNull()
  })

  it('applyThreadStreamEventBatch coalesces and applies events', () => {
    const state = createThreadStreamState()
    applyThreadStreamSnapshot(state, { snapshotSequence: 0, thread: thread() })

    const batchResult = applyThreadStreamEventBatch(state, [
      activityEvent(1, 'inProgress'),
      activityEvent(2, 'completed')
    ])

    expect(batchResult).not.toBeNull()
    expect(batchResult!.thread.activities[0]?.payload?.status).toBe('completed')
    expect(state.lastAppliedSequence).toBe(2)
  })

  it('applyThreadStreamEventBatch returns null for empty batch', () => {
    const state = createThreadStreamState()
    const result = applyThreadStreamEventBatch(state, [])
    expect(result).toBeNull()
  })

  it.each(['codex', 'opencode'] as const)(
    'applies %s command tool activities when the renderer has no Node process global',
    (providerName) => {
      const state = createThreadStreamState()
      applyThreadStreamSnapshot(state, { snapshotSequence: 0, thread: thread(providerName) })

      const result = withoutNodeProcess(() =>
        applyThreadStreamEvent(state, commandActivityEvent(1, providerName))
      )

      expect(result.thread.activities).toContainEqual(
        expect.objectContaining({
          id: `tool:${providerName}:command-1`,
          payload: expect.objectContaining({
            itemType: 'command_execution',
            status: 'inProgress',
            title: '/bin/zsh -lc "bun test"'
          })
        })
      )
    }
  )

  it('markReplayApplied sorts replay events and skips ones older than live state', () => {
    const state = createThreadStreamState()
    applyThreadStreamSnapshot(state, { snapshotSequence: 0, thread: thread() })
    // Apply out-of-order: seq 3 first, then replay delivers 1,2
    applyThreadStreamEvent(state, activityEvent(3, 'inProgress'))
    const result = markReplayApplied(state, [activityEvent(2, 'completed'), activityEvent(1, 'inProgress')])
    expect(result).not.toBeNull()
    expect(state.lastAppliedSequence).toBe(3)
    expect(result!.thread.activities[0]?.payload?.status).toBe('inProgress')
  })
})

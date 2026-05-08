import { describe, expect, it } from 'vitest'
import type { ActiveTurnProjection, OrchestrationThread } from './agent'
import { applyOrchestrationEvent } from './orchestrationReducer'

const t0 = '2020-01-01T00:00:00.000Z'

function emptyThread(id: string): OrchestrationThread {
  return {
    id,
    title: 't',
    branch: 'main',
    messages: [],
    activities: [],
    proposedPlans: [],
    todoLists: [],
    session: null,
    latestTurn: null,
    activeTurn: null,
    checkpoints: [],
    createdAt: t0,
    updatedAt: t0,
    archivedAt: null
  }
}

describe('applyOrchestrationEvent', () => {
  it('thread.active-turn-set sets activeTurn', () => {
    const thread = emptyThread('th1')
    const activeTurn: ActiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'queued',
      activeItemIds: [],
      visibleIndicator: 'exploring',
      startedAt: t0,
      updatedAt: t0
    }
    const next = applyOrchestrationEvent(thread, {
      sequence: 1,
      type: 'thread.active-turn-set',
      threadId: 'th1',
      activeTurn,
      createdAt: t0
    })
    expect(next.activeTurn).toEqual(activeTurn)
    expect(next.updatedAt).toBe(t0)
  })

  it('thread.active-turn-set with null clears activeTurn', () => {
    const withTurn = {
      ...emptyThread('th1'),
      activeTurn: {
        turnId: 'x',
        phase: 'queued' as const,
        activeItemIds: [],
        visibleIndicator: 'exploring' as const,
        startedAt: t0,
        updatedAt: t0
      }
    }
    const next = applyOrchestrationEvent(withTurn, {
      sequence: 2,
      type: 'thread.active-turn-set',
      threadId: 'th1',
      activeTurn: null,
      createdAt: t0
    })
    expect(next.activeTurn).toBeNull()
  })

  it('thread.active-turn-set is a no-op for a different threadId', () => {
    const thread = emptyThread('th1')
    const next = applyOrchestrationEvent(thread, {
      sequence: 1,
      type: 'thread.active-turn-set',
      threadId: 'other',
      activeTurn: {
        turnId: 't',
        phase: 'queued',
        activeItemIds: [],
        visibleIndicator: 'exploring',
        startedAt: t0,
        updatedAt: t0
      },
      createdAt: t0
    })
    expect(next).toBe(thread)
  })

  it('thread.snapshot.changed overrides activeTurn from the snapshot', () => {
    const thread = emptyThread('th1')
    const snap: OrchestrationThread = {
      ...thread,
      activeTurn: {
        turnId: 'snap',
        phase: 'streaming',
        activeItemIds: ['a'],
        visibleIndicator: 'assistant_stream',
        startedAt: t0,
        updatedAt: t0
      }
    }
    const next = applyOrchestrationEvent(thread, {
      sequence: 9,
      type: 'thread.snapshot.changed',
      threadId: 'th1',
      thread: snap,
      createdAt: t0
    })
    expect(next.activeTurn?.turnId).toBe('snap')
  })

  it('does not let a stale running tool event overwrite a completed tool activity', () => {
    const thread = {
      ...emptyThread('th1'),
      activities: [
        {
          id: 'tool:call-1',
          kind: 'tool.completed' as const,
          tone: 'tool' as const,
          summary: 'package.json',
          payload: {
            itemType: 'dynamic_tool_call',
            status: 'completed',
            title: 'package.json'
          },
          turnId: 'turn-1',
          sequence: 1,
          createdAt: t0
        }
      ]
    }

    const next = applyOrchestrationEvent(thread, {
      sequence: 2,
      type: 'thread.activity-upserted',
      threadId: 'th1',
      activity: {
        id: 'tool:call-1',
        kind: 'tool.updated',
        tone: 'tool',
        summary: 'Read package.json',
        payload: {
          itemType: 'dynamic_tool_call',
          status: 'inProgress',
          title: 'Read package.json',
          detail: '/tmp/project/package.json'
        },
        turnId: 'turn-1',
        sequence: 2,
        createdAt: t0
      },
      createdAt: t0
    })

    expect(next.activities[0]).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        summary: 'package.json',
        payload: expect.objectContaining({
          status: 'completed',
          title: 'package.json',
          detail: '/tmp/project/package.json'
        })
      })
    )
  })
})

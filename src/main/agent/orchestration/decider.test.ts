import { describe, expect, it } from 'vitest'
import type { OrchestrationThread } from '../../../shared/agent'
import { decide } from './decider'

const t0 = '2026-01-01T00:00:00.000Z'
const t1 = '2026-01-01T00:00:01.000Z'

function emptyThread(id = 'thread-1'): OrchestrationThread {
  return {
    id,
    title: 'Thread',
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

describe('decide', () => {
  describe('provider.session.update', () => {
    it('emits thread.session-set when status changes', () => {
      const thread = emptyThread()
      const events = decide(
        {
          type: 'provider.session.update',
          commandId: 'cmd-1',
          threadId: 'thread-1',
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: null,
          activePlanId: null,
          lastError: null,
          createdAt: t0
        },
        thread
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('thread.session-set')
    })

    it('emits no events when session is structurally equal', () => {
      const thread: OrchestrationThread = {
        ...emptyThread(),
        session: {
          threadId: 'thread-1',
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: null,
          activePlanId: null,
          lastError: null,
          updatedAt: t0
        }
      }
      const events = decide(
        {
          type: 'provider.session.update',
          commandId: 'cmd-1',
          threadId: 'thread-1',
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: null,
          activePlanId: null,
          lastError: null,
          createdAt: t0
        },
        thread
      )
      expect(events).toHaveLength(0)
    })
  })

  describe('provider.turn.start', () => {
    it('emits active-turn-set + latest-turn-set + session-set', () => {
      const thread = emptyThread()
      const events = decide(
        {
          type: 'provider.turn.start',
          commandId: 'cmd-2',
          threadId: 'thread-1',
          turnId: 'turn-1',
          createdAt: t0
        },
        thread
      )
      const types = events.map((e) => e.type)
      expect(types).toContain('thread.active-turn-set')
      expect(types).toContain('thread.latest-turn-set')
      expect(types).toContain('thread.session-set')
    })

    it('active-turn has phase starting and indicator exploring', () => {
      const thread = emptyThread()
      const events = decide(
        {
          type: 'provider.turn.start',
          commandId: 'cmd-2',
          threadId: 'thread-1',
          turnId: 'turn-1',
          createdAt: t0
        },
        thread
      )
      const activeTurnEvent = events.find((e) => e.type === 'thread.active-turn-set')
      expect(activeTurnEvent?.type).toBe('thread.active-turn-set')
      if (activeTurnEvent?.type === 'thread.active-turn-set') {
        expect(activeTurnEvent.activeTurn?.phase).toBe('starting')
        expect(activeTurnEvent.activeTurn?.visibleIndicator).toBe('exploring')
      }
    })
  })

  describe('provider.turn.complete', () => {
    it('clears active-turn, sets latest-turn completed, updates session to ready', () => {
      const thread: OrchestrationThread = {
        ...emptyThread(),
        activeTurn: {
          turnId: 'turn-1',
          phase: 'streaming',
          activeItemIds: [],
          visibleIndicator: 'assistant_stream',
          startedAt: t0,
          updatedAt: t0
        },
        latestTurn: { id: 'turn-1', status: 'running', startedAt: t0, completedAt: null },
        session: {
          threadId: 'thread-1',
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: 'turn-1',
          activePlanId: null,
          lastError: null,
          updatedAt: t0
        }
      }

      const events = decide(
        {
          type: 'provider.turn.complete',
          commandId: 'cmd-3',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'completed',
          createdAt: t1
        },
        thread
      )

      const activeTurnEvent = events.find((e) => e.type === 'thread.active-turn-set')
      expect(activeTurnEvent?.type).toBe('thread.active-turn-set')
      if (activeTurnEvent?.type === 'thread.active-turn-set') {
        expect(activeTurnEvent.activeTurn).toBeNull()
      }

      const latestTurnEvent = events.find((e) => e.type === 'thread.latest-turn-set')
      expect(latestTurnEvent?.type).toBe('thread.latest-turn-set')
      if (latestTurnEvent?.type === 'thread.latest-turn-set') {
        expect(latestTurnEvent.latestTurn?.status).toBe('completed')
        expect(latestTurnEvent.latestTurn?.completedAt).toBe(t1)
      }

      const sessionEvent = events.find((e) => e.type === 'thread.session-set')
      expect(sessionEvent?.type).toBe('thread.session-set')
      if (sessionEvent?.type === 'thread.session-set') {
        expect(sessionEvent.session?.status).toBe('ready')
        expect(sessionEvent.session?.activeTurnId).toBeNull()
      }
    })

    it('finalizes streaming assistant messages on turn completion', () => {
      const thread: OrchestrationThread = {
        ...emptyThread(),
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            text: 'Hello',
            turnId: 'turn-1',
            streaming: true,
            createdAt: t0,
            updatedAt: t0
          }
        ]
      }

      const events = decide(
        {
          type: 'provider.turn.complete',
          commandId: 'cmd-4',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'completed',
          createdAt: t1
        },
        thread
      )

      const msgEvent = events.find(
        (e) => e.type === 'thread.message-upserted' && e.message?.id === 'msg-1'
      )
      expect(msgEvent?.type).toBe('thread.message-upserted')
      if (msgEvent?.type === 'thread.message-upserted') {
        expect(msgEvent.message.streaming).toBe(false)
      }
    })
  })

  describe('provider.message.upsert', () => {
    it('emits thread.message-upserted', () => {
      const thread = emptyThread()
      const events = decide(
        {
          type: 'provider.message.upsert',
          commandId: 'cmd-5',
          threadId: 'thread-1',
          message: {
            id: 'msg-1',
            role: 'assistant',
            text: 'Hi',
            turnId: 'turn-1',
            streaming: true,
            createdAt: t0,
            updatedAt: t0
          },
          createdAt: t0
        },
        thread
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('thread.message-upserted')
    })
  })

  describe('provider.todo-lists.clear', () => {
    it('emits thread.todo-lists-cleared', () => {
      const thread = emptyThread()
      const events = decide(
        {
          type: 'provider.todo-lists.clear',
          commandId: 'cmd-6',
          threadId: 'thread-1',
          turnId: 'turn-1',
          createdAt: t0
        },
        thread
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('thread.todo-lists-cleared')
    })
  })
})

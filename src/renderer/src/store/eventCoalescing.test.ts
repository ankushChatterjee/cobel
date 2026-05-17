import { describe, expect, it } from 'vitest'
import type { OrchestrationEvent } from '../../../shared/agent'
import { coalesceOrchestrationEvents } from './eventCoalescing'

const now = '2026-01-01T00:00:00.000Z'

function msgEvent(
  id: string,
  text: string,
  sequence: number,
  streaming = true
): Extract<OrchestrationEvent, { type: 'thread.message-upserted' }> {
  return {
    sequence,
    type: 'thread.message-upserted',
    threadId: 'thread-1',
    message: {
      id,
      role: 'assistant',
      text,
      turnId: 'turn-1',
      streaming,
      createdAt: now,
      updatedAt: now
    },
    createdAt: now
  }
}

function activeTurnEvent(
  phase: string,
  sequence: number
): Extract<OrchestrationEvent, { type: 'thread.active-turn-set' }> {
  return {
    sequence,
    type: 'thread.active-turn-set',
    threadId: 'thread-1',
    activeTurn: {
      turnId: 'turn-1',
      phase: phase as import('../../../shared/agent').TurnPhase,
      activeItemIds: [],
      visibleIndicator: 'assistant_stream',
      startedAt: now,
      updatedAt: now
    },
    createdAt: now
  }
}

describe('coalesceOrchestrationEvents', () => {
  it('returns the same array for a single event', () => {
    const events = [msgEvent('msg-1', 'Hello', 1)]
    expect(coalesceOrchestrationEvents(events)).toEqual(events)
  })

  it('does not coalesce streaming messages with different ids', () => {
    const events = [msgEvent('msg-1', 'Hello', 1), msgEvent('msg-2', ' world', 2)]
    const result = coalesceOrchestrationEvents(events)
    expect(result).toHaveLength(2)
  })

  it('keeps both events when a non-streaming message follows a streaming one', () => {
    const events = [msgEvent('msg-1', 'Hello', 1, true), msgEvent('msg-1', 'Hello', 2, false)]
    const result = coalesceOrchestrationEvents(events)
    expect(result).toHaveLength(2)
  })

  it('deduplicates adjacent active-turn-set events with same phase and indicator', () => {
    const events = [activeTurnEvent('streaming', 1), activeTurnEvent('streaming', 2)]
    const result = coalesceOrchestrationEvents(events)
    expect(result).toHaveLength(1)
    expect(result[0]?.sequence).toBe(2)
  })

  it('keeps active-turn-set events when phase changes', () => {
    const events = [activeTurnEvent('streaming', 1), activeTurnEvent('tool_running', 2)]
    const result = coalesceOrchestrationEvents(events)
    expect(result).toHaveLength(2)
  })

  it('preserves event order and keeps non-coalescing events intact', () => {
    const sessionEvent: OrchestrationEvent = {
      sequence: 3,
      type: 'thread.session-set',
      threadId: 'thread-1',
      session: {
        threadId: 'thread-1',
        status: 'running',
        providerName: 'codex',
        runtimeMode: 'auto-accept-edits',
        interactionMode: 'default',
        activeTurnId: 'turn-1',
        activePlanId: null,
        lastError: null,
        updatedAt: now
      },
      createdAt: now
    }
    const events: OrchestrationEvent[] = [
      activeTurnEvent('streaming', 1),
      activeTurnEvent('streaming', 2),
      sessionEvent
    ]
    const result = coalesceOrchestrationEvents(events)
    expect(result).toHaveLength(2)
    expect(result[0]?.type).toBe('thread.active-turn-set')
    expect(result[1]?.type).toBe('thread.session-set')
  })
})

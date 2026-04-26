import { describe, expect, it } from 'vitest'
import type { OrchestrationThread } from '../../../../shared/agent'
import {
  createEmptyThread,
  eventClearsPendingTurnWait,
  isOrchestrationModelTurnInProgress,
  shouldShowTranscriptEndThinkingRow,
  snapshotMergeClearsPendingTurnStart
} from './threadUtils'

const t0 = '2020-01-01T00:00:00.000Z'

describe('isOrchestrationModelTurnInProgress', () => {
  it('is false when the latest turn has finished', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'ready' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: null,
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-1',
        status: 'completed' as const,
        startedAt: t0,
        completedAt: t0
      }
    }
    expect(isOrchestrationModelTurnInProgress(thread)).toBe(false)
  })

  it('is true when session is ready but activeTurnId is still set (gap after tool, before next chunk)', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'ready' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: 'turn-1',
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-1',
        status: 'running' as const,
        startedAt: t0,
        completedAt: null
      }
    }
    expect(isOrchestrationModelTurnInProgress(thread)).toBe(true)
  })

  it('is true when only activeTurnId indicates an open turn (session ready, no latestTurn match)', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'ready' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: 'turn-1',
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: null
    }
    expect(isOrchestrationModelTurnInProgress(thread)).toBe(true)
  })

  it('is true when session is already running even if latestTurn aggregate is still a completed turn', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'running' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: 'turn-2',
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-1',
        status: 'completed' as const,
        startedAt: t0,
        completedAt: t0
      }
    }
    expect(isOrchestrationModelTurnInProgress(thread)).toBe(true)
  })
})

describe('shouldShowTranscriptEndThinkingRow', () => {
  it('shows tail when turn is in progress, tool finished, no in-flight work', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'ready' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: 'turn-1',
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-1',
        status: 'running' as const,
        startedAt: t0,
        completedAt: null
      }
    }
    const show = shouldShowTranscriptEndThinkingRow(thread, {
      isPendingTurnStart: false,
      hasActiveThinkingActivity: false
    })
    expect(show).toBe(true)
  })
})

describe('pending-turn snapshot & events', () => {
  it('snapshot does not clear pending only because the thread has historical tool activities', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'ready' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: null,
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-1',
        status: 'completed' as const,
        startedAt: t0,
        completedAt: t0
      },
      messages: [
        {
          id: 'm-user',
          role: 'user' as const,
          text: 'hi',
          turnId: null,
          streaming: false,
          sequence: 1,
          createdAt: t0,
          updatedAt: t0
        }
      ],
      activities: [
        {
          id: 'tool:1',
          kind: 'tool.completed' as const,
          tone: 'info' as const,
          summary: 'done',
          turnId: null,
          createdAt: t0,
          resolved: true
        }
      ],
      proposedPlans: []
    }
    expect(snapshotMergeClearsPendingTurnStart(thread as OrchestrationThread)).toBe(false)
  })

  it('session-set to ready does not clear pending wait (rely on latest-turn-set / message events)', () => {
    const evt = {
      type: 'thread.session-set' as const,
      sequence: 1,
      threadId: 'th',
      createdAt: t0,
      session: {
        threadId: 'th',
        status: 'ready' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: null,
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      }
    }
    expect(eventClearsPendingTurnWait(evt)).toBe(false)
  })
})

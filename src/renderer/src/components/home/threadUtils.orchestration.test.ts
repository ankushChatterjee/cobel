import { describe, expect, it } from 'vitest'
import type { OrchestrationThread } from '../../../../shared/agent'
import {
  createEmptyThread,
  eventClearsPendingTurnWait,
  groupTranscriptItems,
  isOrchestrationModelTurnInProgress,
  mergePendingUserMessages,
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

  it('is false when activeTurnId is stale for the same turn latestTurn already marked completed', () => {
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
        status: 'completed' as const,
        startedAt: t0,
        completedAt: t0
      }
    }
    expect(isOrchestrationModelTurnInProgress(thread)).toBe(false)
  })
})

describe('shouldShowTranscriptEndThinkingRow', () => {
  it('shows tail when turn is running with no visible transcript payloads', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'running' as const,
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

  it('shows tail when a historical assistant message is incorrectly still marked streaming', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'running' as const,
        providerName: 'opencode' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: 'turn-2',
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-2',
        status: 'running' as const,
        startedAt: t0,
        completedAt: null
      },
      messages: [
        {
          id: 'assistant:turn-1',
          role: 'assistant' as const,
          text: 'earlier reply',
          turnId: 'turn-1',
          streaming: true,
          sequence: 1,
          createdAt: t0,
          updatedAt: t0
        }
      ]
    }
    const show = shouldShowTranscriptEndThinkingRow(thread, {
      isPendingTurnStart: true,
      hasActiveThinkingActivity: false
    })
    expect(show).toBe(true)
  })

  it('hides the tail when the latest turn is finished and only a stale activeTurnId remains', () => {
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
        status: 'completed' as const,
        startedAt: t0,
        completedAt: t0
      },
      messages: [
        {
          id: 'assistant:turn-1',
          role: 'assistant' as const,
          text: 'done',
          turnId: 'turn-1',
          streaming: false,
          sequence: 1,
          createdAt: t0,
          updatedAt: t0
        }
      ]
    }
    const show = shouldShowTranscriptEndThinkingRow(thread, {
      isPendingTurnStart: false,
      hasActiveThinkingActivity: false
    })
    expect(show).toBe(false)
  })

  it('hides the fallback tail when the active turn already has a streaming plan', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'running' as const,
        providerName: 'codex' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'plan' as const,
        activeTurnId: 'turn-2',
        activePlanId: 'plan:th:turn:turn-1',
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-2',
        status: 'running' as const,
        startedAt: t0,
        completedAt: null
      },
      proposedPlans: [
        {
          id: 'plan:th:turn:turn-1',
          turnId: 'turn-2',
          text: '# Rollout',
          status: 'streaming' as const,
          createdAt: t0,
          updatedAt: t0
        }
      ]
    }
    const show = shouldShowTranscriptEndThinkingRow(thread, {
      isPendingTurnStart: true,
      hasActiveThinkingActivity: false
    })
    expect(show).toBe(false)
  })
})

describe('pending-turn snapshot & events', () => {
  it('running snapshot does not clear pending wait by itself', () => {
    const thread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'running' as const,
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
    expect(snapshotMergeClearsPendingTurnStart(thread)).toBe(false)
  })

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

  it('snapshot clears pending on assistant message, visible activity, plan, or terminal session', () => {
    const base = createEmptyThread('th', t0)
    expect(
      snapshotMergeClearsPendingTurnStart({
        ...base,
        messages: [
          {
            id: 'assistant:1',
            role: 'assistant',
            text: 'hello',
            turnId: 'turn-1',
            streaming: false,
            createdAt: t0,
            updatedAt: t0
          }
        ]
      })
    ).toBe(true)
    expect(
      snapshotMergeClearsPendingTurnStart({
        ...base,
        session: {
          threadId: 'th',
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: 'turn-1',
          activePlanId: null,
          lastError: null,
          updatedAt: t0
        },
        activities: [
          {
            id: 'tool:1',
            kind: 'tool.started',
            tone: 'tool',
            summary: 'terminal',
            payload: { itemType: 'command_execution', status: 'inProgress' },
            turnId: 'turn-1',
            createdAt: t0
          }
        ]
      })
    ).toBe(true)
    expect(
      snapshotMergeClearsPendingTurnStart({
        ...base,
        proposedPlans: [
          {
            id: 'plan:1',
            turnId: 'turn-1',
            text: 'Plan',
            status: 'proposed',
            createdAt: t0,
            updatedAt: t0
          }
        ]
      })
    ).toBe(true)
    expect(
      snapshotMergeClearsPendingTurnStart({
        ...base,
        session: {
          threadId: 'th',
          status: 'interrupted',
          providerName: 'codex',
          runtimeMode: 'auto-accept-edits',
          interactionMode: 'default',
          activeTurnId: null,
          activePlanId: null,
          lastError: null,
          updatedAt: t0
        }
      })
    ).toBe(true)
  })

  it('merged snapshot keeps pending wait when a follow-up user message is still optimistic', () => {
    const serverThread = {
      ...createEmptyThread('th', t0),
      session: {
        threadId: 'th',
        status: 'running' as const,
        providerName: 'opencode' as const,
        runtimeMode: 'auto-accept-edits' as const,
        interactionMode: 'default' as const,
        activeTurnId: 'turn-2',
        activePlanId: null,
        lastError: null,
        updatedAt: t0
      },
      latestTurn: {
        id: 'turn-2',
        status: 'running' as const,
        startedAt: t0,
        completedAt: null
      },
      messages: [
        {
          id: 'assistant:1',
          role: 'assistant' as const,
          text: 'first reply',
          turnId: 'turn-1',
          streaming: false,
          sequence: 1,
          createdAt: t0,
          updatedAt: t0
        }
      ]
    }

    expect(snapshotMergeClearsPendingTurnStart(serverThread)).toBe(true)

    const mergedThread = mergePendingUserMessages(
      serverThread,
      new Map([
        [
          'user:2',
          {
            id: 'user:2',
            role: 'user' as const,
            text: 'follow-up',
            turnId: null,
            streaming: false,
            sequence: 1.5,
            createdAt: t0,
            updatedAt: t0
          }
        ]
      ])
    )

    expect(snapshotMergeClearsPendingTurnStart(mergedThread)).toBe(false)
  })
})

describe('groupTranscriptItems', () => {
  it('collapses adjacent opencode reasoning activities across empty assistant segments', () => {
    const groups = groupTranscriptItems(
      [
        {
          id: 'thinking-1',
          kind: 'activity',
          sequence: 1,
          createdAt: t0,
          activity: {
            id: 'thinking:1',
            kind: 'task.completed',
            tone: 'thinking',
            summary: 'Thinking',
            turnId: 'turn-1',
            resolved: true,
            createdAt: t0,
            payload: { itemType: 'reasoning', reasoningText: 'first' }
          }
        },
        {
          id: 'assistant-empty',
          kind: 'message',
          sequence: 2,
          createdAt: t0,
          workDurationMs: null,
          message: {
            id: 'message:empty',
            role: 'assistant',
            text: '',
            turnId: 'turn-1',
            streaming: false,
            sequence: 2,
            createdAt: t0,
            updatedAt: t0
          }
        },
        {
          id: 'thinking-2',
          kind: 'activity',
          sequence: 3,
          createdAt: t0,
          activity: {
            id: 'thinking:2',
            kind: 'task.completed',
            tone: 'thinking',
            summary: 'Thinking',
            turnId: 'turn-1',
            resolved: true,
            createdAt: t0,
            payload: { itemType: 'reasoning', reasoningText: 'second' }
          }
        }
      ],
      'opencode'
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      kind: 'reasoning-run',
      activities: [{ id: 'thinking-1' }, { id: 'thinking-2' }]
    })
  })

  it('keeps empty assistant segments as separators for non-opencode providers', () => {
    const groups = groupTranscriptItems(
      [
        {
          id: 'thinking-1',
          kind: 'activity',
          sequence: 1,
          createdAt: t0,
          activity: {
            id: 'thinking:1',
            kind: 'task.completed',
            tone: 'thinking',
            summary: 'Thinking',
            turnId: 'turn-1',
            resolved: true,
            createdAt: t0,
            payload: { itemType: 'reasoning', reasoningText: 'first' }
          }
        },
        {
          id: 'assistant-empty',
          kind: 'message',
          sequence: 2,
          createdAt: t0,
          workDurationMs: null,
          message: {
            id: 'message:empty',
            role: 'assistant',
            text: '',
            turnId: 'turn-1',
            streaming: false,
            sequence: 2,
            createdAt: t0,
            updatedAt: t0
          }
        },
        {
          id: 'thinking-2',
          kind: 'activity',
          sequence: 3,
          createdAt: t0,
          activity: {
            id: 'thinking:2',
            kind: 'task.completed',
            tone: 'thinking',
            summary: 'Thinking',
            turnId: 'turn-1',
            resolved: true,
            createdAt: t0,
            payload: { itemType: 'reasoning', reasoningText: 'second' }
          }
        }
      ],
      'codex'
    )

    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.kind)).toEqual(['non-tool', 'non-tool', 'non-tool'])
  })
})

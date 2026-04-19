import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type { AgentApi, OrchestrationEvent, OrchestrationThread } from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'

window.scrollTo = vi.fn()
Element.prototype.scrollIntoView = vi.fn()

const now = new Date('2026-04-19T00:00:00.000Z').toISOString()
let sequence = 0
const testThreads = new Map<string, OrchestrationThread>()
const threadListeners = new Map<string, Array<(event: OrchestrationEvent) => void>>()

export function createTestThread(
  overrides: Partial<OrchestrationThread> = {}
): OrchestrationThread {
  return {
    id: 'local:main',
    title: 'Chat title',
    cwd: '/Users/ankush/codespace/gencode',
    branch: 'main',
    messages: [],
    activities: [],
    proposedPlans: [],
    session: null,
    latestTurn: null,
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides
  }
}

const agentApiMock: AgentApi = {
  dispatchCommand: vi.fn(async (input) => {
    if (input.type === 'thread.turn.start') {
      emitThreadEvent(input.threadId, {
        sequence: nextSequence(),
        type: 'thread.message-upserted',
        threadId: input.threadId,
        message: {
          id: `user:${input.commandId}`,
          role: 'user',
          text: input.input,
          attachments: input.attachments,
          turnId: null,
          streaming: false,
          sequence,
          createdAt: input.createdAt,
          updatedAt: input.createdAt
        },
        createdAt: input.createdAt
      })
    }
    return {
      accepted: true,
      commandId: input.commandId,
      threadId: input.threadId,
      turnId: 'turn:test'
    }
  }),
  subscribeThread: vi.fn((_input, listener) => {
    const thread = getTestThread(_input.threadId)
    const listeners = threadListeners.get(_input.threadId) ?? []
    const eventListener = (event: OrchestrationEvent): void => listener({ kind: 'event', event })
    listeners.push(eventListener)
    threadListeners.set(_input.threadId, listeners)
    listener({
      kind: 'snapshot',
      snapshot: {
        snapshotSequence: sequence,
        thread
      }
    })
    return vi.fn(() => {
      const current = threadListeners.get(_input.threadId) ?? []
      threadListeners.set(
        _input.threadId,
        current.filter((candidate) => candidate !== eventListener)
      )
    })
  }),
  interruptTurn: vi.fn(async () => {}),
  respondToApproval: vi.fn(async () => {}),
  respondToUserInput: vi.fn(async () => {}),
  stopSession: vi.fn(async () => {}),
  listProviders: vi.fn(async () => [
    {
      id: 'codex' as const,
      name: 'Codex',
      status: 'available' as const,
      detail: 'codex-cli 0.121.0'
    }
  ]),
  listModels: vi.fn(async () => []),
  clearThread: vi.fn(async () => {}),
  openWorkspaceFolder: vi.fn(async () => ({
    path: '/Users/ankush/codespace/gencode',
    name: 'gencode'
  })),
  revealPath: vi.fn(async () => {})
}

window.agentApi = agentApiMock

export function resetAgentApiMock(): void {
  sequence = 0
  testThreads.clear()
  threadListeners.clear()
}

function getTestThread(threadId: string): OrchestrationThread {
  const existing = testThreads.get(threadId)
  if (existing) return existing
  const thread = createTestThread({ id: threadId })
  testThreads.set(threadId, thread)
  return thread
}

function emitThreadEvent(threadId: string, event: OrchestrationEvent): void {
  const current = getTestThread(threadId)
  testThreads.set(threadId, applyOrchestrationEvent(current, event))
  for (const listener of threadListeners.get(threadId) ?? []) listener(event)
}

function nextSequence(): number {
  sequence += 1
  return sequence
}

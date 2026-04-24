import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type {
  AgentApi,
  OrchestrationEvent,
  OrchestrationShellEvent,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThread
} from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'
import { DEFAULT_THREAD_TITLE } from '../../../shared/threadTitle'

window.scrollTo = vi.fn()
Element.prototype.scrollIntoView = vi.fn()

const now = new Date('2026-04-19T00:00:00.000Z').toISOString()
let sequence = 0
const testThreads = new Map<string, OrchestrationThread>()
const threadListeners = new Map<string, Array<(event: OrchestrationEvent) => void>>()
let shellListeners: Array<(item: OrchestrationShellStreamItem) => void> = []
let shellSnapshot: OrchestrationShellSnapshot = { projects: [], threads: [] }

export function createTestThread(
  overrides: Partial<OrchestrationThread> = {}
): OrchestrationThread {
  return {
    id: 'local:main',
    title: DEFAULT_THREAD_TITLE,
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
      const existingThread = getTestThread(input.threadId)
      if (input.titleSeed && existingThread.title === DEFAULT_THREAD_TITLE) {
        const existingShellThread = shellSnapshot.threads.find((thread) => thread.id === input.threadId)
        if (existingShellThread) {
          const updatedShellThread = {
            ...existingShellThread,
            title: input.titleSeed,
            updatedAt: input.createdAt
          }
          shellSnapshot = {
            ...shellSnapshot,
            threads: shellSnapshot.threads.map((thread) =>
              thread.id === input.threadId ? updatedShellThread : thread
            )
          }
          emitShellEvent({ type: 'shell.thread-upserted', thread: updatedShellThread })
        }
        emitThreadEvent(input.threadId, {
          sequence: nextSequence(),
          type: 'thread.renamed',
          threadId: input.threadId,
          title: input.titleSeed,
          createdAt: input.createdAt
        })
      }
    } else if (input.type === 'project.create') {
      const project = {
        id: input.projectId,
        name: input.name,
        path: input.path,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null
      }
      shellSnapshot = {
        ...shellSnapshot,
        projects: [...shellSnapshot.projects.filter((p) => p.id !== input.projectId), project]
      }
      emitShellEvent({ type: 'shell.project-upserted', project })
    } else if (input.type === 'thread.create') {
      const thread = {
        id: input.threadId,
        projectId: input.projectId,
        title: input.title,
        cwd: input.cwd,
        branch: input.branch ?? 'main',
        latestTurnId: null,
        sessionStatus: 'idle' as const,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null
      }
      shellSnapshot = {
        ...shellSnapshot,
        threads: [...shellSnapshot.threads.filter((t) => t.id !== input.threadId), thread]
      }
      emitShellEvent({ type: 'shell.thread-upserted', thread })
    } else if (input.type === 'thread.rename') {
      const existing = shellSnapshot.threads.find((t) => t.id === input.threadId)
      if (existing) {
        const updated = { ...existing, title: input.title, updatedAt: input.createdAt }
        shellSnapshot = {
          ...shellSnapshot,
          threads: shellSnapshot.threads.map((t) => (t.id === input.threadId ? updated : t))
        }
        emitShellEvent({ type: 'shell.thread-upserted', thread: updated })
      }
    } else if (input.type === 'thread.delete') {
      shellSnapshot = {
        ...shellSnapshot,
        threads: shellSnapshot.threads.filter((t) => t.id !== input.threadId)
      }
      emitShellEvent({ type: 'shell.thread-removed', threadId: input.threadId })
    } else if (input.type === 'project.delete') {
      shellSnapshot = {
        ...shellSnapshot,
        projects: shellSnapshot.projects.filter((p) => p.id !== input.projectId)
      }
      emitShellEvent({ type: 'shell.project-removed', projectId: input.projectId })
    }
    return {
      accepted: true,
      commandId: input.commandId,
      threadId: 'threadId' in input ? input.threadId : '',
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
  subscribeShell: vi.fn((listener) => {
    listener({ kind: 'snapshot', snapshot: shellSnapshot })
    shellListeners.push(listener)
    return vi.fn(() => {
      shellListeners = shellListeners.filter((l) => l !== listener)
    })
  }),
  getShellSnapshot: vi.fn(async (): Promise<OrchestrationShellSnapshot> => shellSnapshot),
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
  getCheckpointDiff: vi.fn(async (input) => ({ ...input, diff: '', truncated: false })),
  getCheckpointWorktreeDiff: vi.fn(async (input) => ({
    ...input,
    diff: '',
    files: [],
    truncated: false
  })),
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
  shellListeners = []
  shellSnapshot = { projects: [], threads: [] }
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

function emitShellEvent(event: OrchestrationShellEvent): void {
  for (const listener of shellListeners) listener({ kind: 'event', event })
}

function nextSequence(): number {
  sequence += 1
  return sequence
}

import { beforeEach, describe, expect, it, vi } from 'vitest'

const promptMock = vi.fn()
const createMock = vi.fn()
const deleteMock = vi.fn()
const closeMock = vi.fn()
const eventSubscribeMock = vi.fn()
const promptAsyncMock = vi.fn()

vi.mock('./opencodeRuntime', () => ({
  buildOpenCodePermissionRules: vi.fn(() => [{ permission: '*', pattern: '*', action: 'ask' }]),
  connectToOpenCodeServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:7777',
    external: false,
    close: closeMock
  })),
  createOpenCodeSdkClient: vi.fn(() => ({
    session: {
      create: createMock,
      prompt: promptMock,
      promptAsync: promptAsyncMock,
      delete: deleteMock
    },
    event: {
      subscribe: eventSubscribeMock
    }
  })),
  inventoryToModelInfos: vi.fn(() => [{ id: 'anthropic/claude-sonnet-4', providerId: 'opencode' }]),
  loadOpenCodeInventory: vi.fn(async () => ({})),
  parseOpenCodeModelSlug: vi.fn((slug: string | null | undefined) => {
    if (!slug) return null
    const [providerID, modelID] = slug.split('/')
    return providerID && modelID ? { providerID, modelID } : null
  }),
  readOpenCodeConfigFromEnv: vi.fn(() => ({
    binaryPath: 'opencode',
    serverUrl: '',
    serverPassword: ''
  })),
  resolveOpenCodeBinaryPath: vi.fn((value: string) => value),
  appendOpenCodeAssistantTextDelta: vi.fn(),
  mergeOpenCodeAssistantText: vi.fn(),
  openCodeQuestionId: vi.fn(),
  readOpencodeResumeSessionId: vi.fn(),
  runOpenCodeCommand: vi.fn(),
  toOpenCodeFileParts: vi.fn(() => []),
  toOpenCodePermissionReply: vi.fn(),
  toOpenCodeQuestionAnswers: vi.fn()
}))

import { mergeOpenCodeAssistantText } from './opencodeRuntime'
import {
  OpenCodeAdapter,
  todoItemsFromOpenCodeToolPart,
  toolLifecycleTitle
} from './OpenCodeAdapter'

function createEventStream() {
  const queue: unknown[] = []
  let notify: (() => void) | undefined
  let closed = false

  return {
    push(event: unknown): void {
      queue.push(event)
      notify?.()
      notify = undefined
    },
    close(): void {
      closed = true
      notify?.()
      notify = undefined
    },
    stream: {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve
            })
          }
          while (queue.length > 0) {
            yield queue.shift()
          }
        }
      }
    }
  }
}

describe('OpenCodeAdapter.generateThreadTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createMock.mockResolvedValue({ data: { id: 'session:title' } })
    deleteMock.mockResolvedValue({})
    closeMock.mockReset()
  })

  it('does not request structured output when the provider marks it unsupported', async () => {
    promptMock.mockResolvedValue({
      data: {
        info: {},
        parts: [{ type: 'text', text: '{"title":"Provider Layer"}' }]
      }
    })
    const adapter = new OpenCodeAdapter()

    const title = await adapter.generateThreadTitle({
      cwd: '/tmp/project',
      input: 'Please build the provider layer',
      model: 'anthropic/claude-sonnet-4',
      useStructuredOutput: false
    })

    expect(title).toBe('Provider Layer')
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session:title',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        parts: expect.any(Array)
      })
    )
    expect(promptMock.mock.calls[0]?.[0]).not.toHaveProperty('format')
    expect(deleteMock).toHaveBeenCalledWith({ sessionID: 'session:title' })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('passes the JSON schema when structured output is enabled', async () => {
    promptMock.mockResolvedValue({
      data: {
        info: { structured: { title: 'Sidebar Layout' } },
        parts: []
      }
    })
    const adapter = new OpenCodeAdapter()

    const title = await adapter.generateThreadTitle({
      cwd: '/tmp/project',
      input: 'Please refactor the sidebar layout',
      model: 'anthropic/claude-sonnet-4',
      useStructuredOutput: true
    })

    expect(title).toBe('Sidebar Layout')
    expect(promptMock.mock.calls[0]?.[0]).toHaveProperty('format')
  })
})

describe('OpenCodeAdapter event mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createMock.mockResolvedValue({ data: { id: 'session:events' } })
    promptAsyncMock.mockResolvedValue({})
    vi.mocked(mergeOpenCodeAssistantText).mockImplementation((previous, text) => ({
      latestText: text,
      deltaToEmit: previous === undefined ? text : text.slice(previous.length)
    }))
    closeMock.mockReset()
  })

  it('does not emit tool lifecycle rows for OpenCode step markers', async () => {
    const stream = createEventStream()
    eventSubscribeMock.mockResolvedValue({ stream: stream.stream })
    const adapter = new OpenCodeAdapter()
    const events: Array<Parameters<Parameters<typeof adapter.streamEvents>[0]>[0]> = []
    adapter.streamEvents((event) => events.push(event))

    await adapter.startSession({
      threadId: 'thread-1',
      cwd: '/tmp/project',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      model: 'anthropic/claude-sonnet-4'
    })
    await vi.waitFor(() => expect(eventSubscribeMock).toHaveBeenCalled())

    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'step-start-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'step-start'
        },
        time: Date.now()
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'step-finish-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'step-finish',
          reason: 'done',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        },
        time: Date.now()
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const lifecycle = events.filter(
      (event) => event.type === 'item.started' || event.type === 'item.completed'
    )
    expect(lifecycle).toEqual([])

    stream.close()
  })

  it('ignores events tagged for another OpenCode session', async () => {
    const stream = createEventStream()
    eventSubscribeMock.mockResolvedValue({ stream: stream.stream })
    const adapter = new OpenCodeAdapter()
    const events: Array<Parameters<Parameters<typeof adapter.streamEvents>[0]>[0]> = []
    adapter.streamEvents((event) => events.push(event))

    await adapter.startSession({
      threadId: 'thread-1',
      cwd: '/tmp/project',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      model: 'anthropic/claude-sonnet-4'
    })
    await vi.waitFor(() => expect(eventSubscribeMock).toHaveBeenCalled())

    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:other',
        part: {
          id: 'part-other',
          messageID: 'message-other',
          type: 'text',
          text: 'Wrong thread'
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events.some((event) => event.type === 'content.delta')).toBe(false)

    stream.close()
  })

  it('ignores untagged events that cannot be correlated to this session', async () => {
    const stream = createEventStream()
    eventSubscribeMock.mockResolvedValue({ stream: stream.stream })
    const adapter = new OpenCodeAdapter()
    const events: Array<Parameters<Parameters<typeof adapter.streamEvents>[0]>[0]> = []
    adapter.streamEvents((event) => events.push(event))

    await adapter.startSession({
      threadId: 'thread-1',
      cwd: '/tmp/project',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      model: 'anthropic/claude-sonnet-4'
    })
    await vi.waitFor(() => expect(eventSubscribeMock).toHaveBeenCalled())

    stream.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-unknown',
          messageID: 'message-unknown',
          type: 'text',
          text: 'Untagged stranger'
        }
      }
    })
    stream.push({
      type: 'permission.asked',
      properties: {
        id: 'permission-unknown',
        permission: 'bash',
        patterns: ['bun test']
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events.some((event) => event.type === 'content.delta')).toBe(false)
    expect(events.some((event) => event.type === 'request.opened')).toBe(false)

    stream.close()
  })

  it('accepts untagged updates for known message and request ids', async () => {
    const stream = createEventStream()
    eventSubscribeMock.mockResolvedValue({ stream: stream.stream })
    const adapter = new OpenCodeAdapter()
    const events: Array<Parameters<Parameters<typeof adapter.streamEvents>[0]>[0]> = []
    adapter.streamEvents((event) => events.push(event))

    await adapter.startSession({
      threadId: 'thread-1',
      cwd: '/tmp/project',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      model: 'anthropic/claude-sonnet-4'
    })
    await vi.waitFor(() => expect(eventSubscribeMock).toHaveBeenCalled())

    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: { id: 'message-1', role: 'assistant' }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          messageID: 'message-1',
          type: 'text',
          text: 'Known message'
        }
      }
    })
    stream.push({
      type: 'permission.asked',
      properties: {
        sessionID: 'session:events',
        id: 'permission-1',
        permission: 'bash',
        patterns: ['bun test']
      }
    })
    stream.push({
      type: 'permission.replied',
      properties: {
        requestID: 'permission-1',
        reply: 'once'
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'content.delta',
          payload: expect.objectContaining({ delta: 'Known message' })
        }),
        expect.objectContaining({
          type: 'request.opened',
          requestId: 'permission-1'
        }),
        expect.objectContaining({
          type: 'request.resolved',
          requestId: 'permission-1'
        })
      ])
    )

    stream.close()
  })

  it('does not let untagged session lifecycle events complete an active turn', async () => {
    const stream = createEventStream()
    eventSubscribeMock.mockResolvedValue({ stream: stream.stream })
    const adapter = new OpenCodeAdapter()
    const events: Array<Parameters<Parameters<typeof adapter.streamEvents>[0]>[0]> = []
    adapter.streamEvents((event) => events.push(event))

    await adapter.startSession({
      threadId: 'thread-1',
      cwd: '/tmp/project',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      model: 'anthropic/claude-sonnet-4'
    })
    await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'hello',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'session.status',
      properties: {
        status: { type: 'idle' }
      }
    })
    stream.push({
      type: 'session.error',
      properties: {
        error: { message: 'wrong lifecycle' }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const turnCompletions = events.filter((event) => event.type === 'turn.completed')
    const runtimeErrors = events.filter((event) => event.type === 'runtime.error')
    expect(turnCompletions).toEqual([])
    expect(runtimeErrors).toEqual([])

    stream.close()
  })
})

describe('todoItemsFromOpenCodeToolPart', () => {
  it('normalizes TodoWrite tool state into checklist items', () => {
    expect(
      todoItemsFromOpenCodeToolPart({
        id: 'part-1',
        callID: 'call-1',
        messageID: 'message-1',
        tool: 'TodoWrite',
        metadata: {},
        state: {
          status: 'running',
          title: 'TodoWrite',
          input: {
            todos: [
              { id: 'todo-1', content: 'Add persistence model', status: 'completed' },
              { id: 'todo-2', content: 'Render composer pill', status: 'in_progress' },
              { id: 'todo-3', content: 'Add tests', status: 'pending' }
            ]
          },
          metadata: {}
        }
      } as never)
    ).toEqual([
      { id: 'todo-1', text: 'Add persistence model', status: 'completed' },
      { id: 'todo-2', text: 'Render composer pill', status: 'in_progress' },
      { id: 'todo-3', text: 'Add tests', status: 'pending' }
    ])
  })

  it('prefers completed output state over stale input snapshots', () => {
    expect(
      todoItemsFromOpenCodeToolPart({
        id: 'part-1',
        callID: 'call-1',
        messageID: 'message-1',
        tool: 'TodoWrite',
        metadata: {},
        state: {
          status: 'completed',
          title: 'TodoWrite',
          input: {
            todos: [{ id: 'todo-1', content: 'Add persistence model', status: 'pending' }]
          },
          output: JSON.stringify({
            todos: [{ id: 'todo-1', content: 'Add persistence model', status: 'completed' }]
          }),
          metadata: {}
        }
      } as never)
    ).toEqual([{ id: 'todo-1', text: 'Add persistence model', status: 'completed' }])
  })
})

describe('toolLifecycleTitle', () => {
  it('renders todowrite as Editing todos instead of the raw tool title', () => {
    expect(
      toolLifecycleTitle({
        id: 'part-1',
        callID: 'call-1',
        messageID: 'message-1',
        type: 'tool',
        tool: 'TodoWrite',
        metadata: {},
        state: {
          status: 'running',
          title: 'Edited todowrite',
          input: {
            todos: [{ id: 'todo-1', content: 'Wire persistence', status: 'in_progress' }]
          },
          metadata: {}
        }
      } as never)
    ).toBe('Editing todos')
  })
})

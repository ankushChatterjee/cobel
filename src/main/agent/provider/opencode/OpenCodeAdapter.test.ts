import { beforeEach, describe, expect, it, vi } from 'vitest'

const promptMock = vi.fn()
const createMock = vi.fn()
const deleteMock = vi.fn()
const closeMock = vi.fn()
const eventSubscribeMock = vi.fn()

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
  readOpenCodeConfigFromEnv: vi.fn(() => ({ binaryPath: 'opencode', serverUrl: '', serverPassword: '' })),
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

import { OpenCodeAdapter, todoItemsFromOpenCodeToolPart, toolLifecycleTitle } from './OpenCodeAdapter'

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

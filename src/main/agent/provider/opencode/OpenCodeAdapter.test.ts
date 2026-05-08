import { beforeEach, describe, expect, it, vi } from 'vitest'

const promptMock = vi.fn()
const createMock = vi.fn()
const deleteMock = vi.fn()
const closeMock = vi.fn()
const eventSubscribeMock = vi.fn()
const promptAsyncMock = vi.fn()
const permissionReplyMock = vi.fn()

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
    },
    permission: {
      reply: permissionReplyMock
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
  fileEditChangesFromOpenCodeToolPart,
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
    permissionReplyMock.mockResolvedValue({})
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

  it('optimistically resolves OpenCode approvals and ignores duplicate approval responses', async () => {
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
      input: 'run typecheck',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'permission.asked',
      properties: {
        sessionID: 'session:events',
        id: 'permission-1',
        permission: 'bash',
        patterns: ['bun run typecheck'],
        metadata: {},
        tool: { messageID: 'message-1', callID: 'tool-1' }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await adapter.respondToApproval({
      threadId: 'thread-1',
      requestId: 'permission-1',
      decision: 'accept'
    })
    await adapter.respondToApproval({
      threadId: 'thread-1',
      requestId: 'permission-1',
      decision: 'accept'
    })

    expect(permissionReplyMock).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'request.resolved',
        requestId: 'permission-1',
        payload: expect.objectContaining({ decision: 'accept' })
      })
    )

    stream.close()
  })

  it('resolves abandoned OpenCode approvals when their tool is aborted after idle', async () => {
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
      input: 'run lint',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: { id: 'message-1', sessionID: 'session:events', role: 'assistant' }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'part-bash-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'tool',
          tool: 'bash',
          callID: 'tool-bash-1',
          state: {
            status: 'running',
            input: { command: 'bun run lint', description: 'Run linter' },
            time: { start: 1 },
            metadata: {}
          }
        }
      }
    })
    stream.push({
      type: 'permission.asked',
      properties: {
        sessionID: 'session:events',
        id: 'permission-lint',
        permission: 'bash',
        patterns: ['bun run lint'],
        metadata: {},
        tool: { messageID: 'message-1', callID: 'tool-bash-1' }
      }
    })
    stream.push({
      type: 'session.idle',
      properties: { sessionID: 'session:events' }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'part-bash-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'tool',
          tool: 'bash',
          callID: 'tool-bash-1',
          state: {
            status: 'error',
            input: { command: 'bun run lint', description: 'Run linter' },
            error: 'Tool execution aborted',
            time: { start: 1, end: 2 },
            metadata: { interrupted: true }
          }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'request.resolved',
        requestId: 'permission-lint',
        payload: expect.objectContaining({ decision: 'cancel' })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'item.completed',
        itemId: 'tool-bash-1',
        payload: expect.objectContaining({ status: 'failed' })
      })
    )

    stream.close()
  })

  it('uses the tool part id when OpenCode omits callID so running edits can complete', async () => {
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
      input: 'edit the file',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

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
        sessionID: 'session:events',
        part: {
          id: 'part-edit-1',
          messageID: 'message-1',
          type: 'tool',
          tool: 'edit',
          metadata: {},
          state: {
            status: 'running',
            title: 'Edited edit',
            input: { filePath: 'src/lib/themes.ts' },
            time: { start: Date.now() },
            metadata: {}
          }
        }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'part-edit-1',
          messageID: 'message-1',
          type: 'tool',
          tool: 'edit',
          metadata: {},
          state: {
            status: 'completed',
            title: 'themes.ts',
            input: { filePath: 'src/lib/themes.ts' },
            output: 'done',
            time: { end: Date.now() },
            metadata: {
              diff: 'diff --git a/src/lib/themes.ts b/src/lib/themes.ts\n@@ -1 +1 @@\n-old\n+new\n'
            }
          }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const toolEvents = events.filter(
      (event) =>
        (event.type === 'item.updated' || event.type === 'item.completed') &&
        event.itemId === 'part-edit-1'
    )
    expect(toolEvents).toEqual([
      expect.objectContaining({
        type: 'item.updated',
        itemId: 'part-edit-1',
        payload: expect.objectContaining({ status: 'inProgress' })
      }),
      expect.objectContaining({
        type: 'item.completed',
        itemId: 'part-edit-1',
        payload: expect.objectContaining({ status: 'completed' })
      })
    ])

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

  it('keeps an OpenCode turn running across assistant messages that finish with tool-calls', async () => {
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
      input: 'work until done',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: { id: 'message-1', sessionID: 'session:events', role: 'assistant' }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'text-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'text',
          text: 'I will read files.',
          time: { start: 1, end: 2 }
        }
      }
    })
    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: {
          id: 'message-1',
          sessionID: 'session:events',
          role: 'assistant',
          finish: 'tool-calls'
        }
      }
    })
    stream.push({
      type: 'session.status',
      properties: { sessionID: 'session:events', status: { type: 'busy' } }
    })
    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: { id: 'message-2', sessionID: 'session:events', role: 'assistant' }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'text-2',
          sessionID: 'session:events',
          messageID: 'message-2',
          type: 'text',
          text: 'Now I will edit.',
          time: { start: 3, end: 4 }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([])
    expect(
      events.filter(
        (event) =>
          event.type === 'item.completed' &&
          event.payload.itemType === 'assistant_message'
      )
    ).toEqual([])
    expect(events.filter((event) => event.type === 'content.delta')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ delta: 'I will read files.' })
      }),
      expect.objectContaining({ payload: expect.objectContaining({ delta: 'Now I will edit.' }) })
    ])

    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: {
          id: 'message-2',
          sessionID: 'session:events',
          role: 'assistant',
          finish: 'stop'
        }
      }
    })
    stream.push({
      type: 'session.idle',
      properties: { sessionID: 'session:events' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)

    stream.close()
  })

  it('ignores stale running tool snapshots after OpenCode reports the same tool completed', async () => {
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
      input: 'edit the file',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: { id: 'message-1', sessionID: 'session:events', role: 'assistant' }
      }
    })
    const basePart = {
      id: 'part-edit-stale',
      sessionID: 'session:events',
      messageID: 'message-1',
      type: 'tool' as const,
      callID: 'call-edit-stale',
      tool: 'edit',
      metadata: {}
    }
    const input = {
      filePath: 'src/app.ts',
      oldString: 'old',
      newString: 'new',
      replaceAll: false
    }
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          ...basePart,
          state: { status: 'running', input, time: { start: 1 }, metadata: {} }
        }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          ...basePart,
          state: {
            status: 'completed',
            input,
            output: 'Edit applied successfully.',
            title: 'src/app.ts',
            time: { start: 1, end: 2 },
            metadata: { diff: 'diff --git a/src/app.ts b/src/app.ts\n@@\n-old\n+new\n' }
          }
        }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          ...basePart,
          state: { status: 'running', input, time: { start: 1 }, metadata: {} }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const toolEvents = events.filter((event) => event.itemId === 'call-edit-stale')
    expect(toolEvents).toEqual([
      expect.objectContaining({
        type: 'item.updated',
        payload: expect.objectContaining({ status: 'inProgress' })
      }),
      expect.objectContaining({
        type: 'item.completed',
        payload: expect.objectContaining({ status: 'completed' })
      })
    ])

    stream.close()
  })

  it('keeps late OpenCode reasoning completions attached to the completed turn', async () => {
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
    const turn = await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'think and finish',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'message.updated',
      properties: {
        sessionID: 'session:events',
        info: { id: 'message-1', sessionID: 'session:events', role: 'assistant' }
      }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'reasoning-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'reasoning',
          text: 'Thinking',
          time: { start: 1 }
        }
      }
    })
    stream.push({
      type: 'session.idle',
      properties: { sessionID: 'session:events' }
    })
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 'session:events',
        part: {
          id: 'reasoning-1',
          sessionID: 'session:events',
          messageID: 'message-1',
          type: 'reasoning',
          text: 'Thinking',
          time: { start: 1, end: 2 }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.completed',
        turnId: turn.turnId,
        payload: expect.objectContaining({ state: 'completed' })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'item.completed',
        turnId: turn.turnId,
        itemId: 'reasoning-1',
        payload: expect.objectContaining({ itemType: 'reasoning', status: 'completed' })
      })
    )

    stream.close()
  })

  it('attaches OpenCode session diffs that arrive after idle to the just-completed turn', async () => {
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
    const turn = await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'edit then report diff',
      model: 'anthropic/claude-sonnet-4',
      interactionMode: 'default'
    })
    await vi.waitFor(() => expect(promptAsyncMock).toHaveBeenCalled())

    stream.push({
      type: 'session.idle',
      properties: { sessionID: 'session:events' }
    })
    stream.push({
      type: 'session.diff',
      properties: {
        sessionID: 'session:events',
        diff: [
          {
            file: 'src/app.ts',
            patch: 'diff --git a/src/app.ts b/src/app.ts\n@@\n-old\n+new\n'
          }
        ]
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'item.completed',
        turnId: turn.turnId,
        itemId: 'opencode:session-diff',
        payload: expect.objectContaining({ itemType: 'file_change', status: 'completed' })
      })
    )

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

describe('fileEditChangesFromOpenCodeToolPart', () => {
  it('returns no diff while an OpenCode edit is still running', () => {
    expect(
      fileEditChangesFromOpenCodeToolPart({
        id: 'part-1',
        callID: 'call-1',
        messageID: 'message-1',
        type: 'tool',
        tool: 'edit',
        metadata: {},
        state: {
          status: 'running',
          title: 'Editing src/app.ts',
          input: { filePath: 'src/app.ts' },
          metadata: {}
        }
      } as never)
    ).toBeUndefined()
  })

  it('extracts file edit changes from completed OpenCode edit metadata', () => {
    expect(
      fileEditChangesFromOpenCodeToolPart({
        id: 'part-1',
        callID: 'call-1',
        messageID: 'message-1',
        type: 'tool',
        tool: 'edit',
        metadata: {},
        state: {
          status: 'completed',
          title: 'Edited src/app.ts',
          input: { filePath: 'src/app.ts' },
          metadata: {
            diff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
          }
        }
      } as never)
    ).toEqual([
      {
        path: 'src/app.ts',
        diff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new'
      }
    ])
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

import { describe, expect, it } from 'vitest'
import type { ProviderRuntimeEvent } from '../../../shared/agent'
import { OrchestrationEngine } from './OrchestrationEngine'
import { ProviderRuntimeIngestion } from './ProviderRuntimeIngestion'

const createdAt = '2026-04-19T00:00:00.000Z'

describe('ProviderRuntimeIngestion', () => {
  it('buffers assistant deltas and flushes on approval boundaries with a new segment after approval', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        payload: { streamKind: 'assistant_text', delta: 'Before approval. ' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'request.opened',
        turnId: 'turn-1',
        requestId: 'approval-1',
        payload: { requestType: 'command_execution_approval', detail: 'bun test' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        payload: { streamKind: 'assistant_text', delta: 'After approval.' }
      })
    )
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    const thread = engine.getThread('thread-1')
    expect(thread.messages.map((message) => message.text)).toEqual([
      'Before approval. ',
      'After approval.'
    ])
    expect(thread.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'approval:approval-1',
          kind: 'approval.requested',
          resolved: false
        })
      ])
    )
    expect(thread.session?.status).toBe('ready')
  })

  it('streams assistant deltas into one visible message and closes it at turn completion', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        payload: { streamKind: 'assistant_text', delta: 'Hel' }
      })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'Hel',
        streaming: true
      })
    ])

    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        payload: { streamKind: 'assistant_text', delta: 'lo' }
      })
    )
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'Hello',
        streaming: false
      })
    ])
  })

  it('does not let a stale turn completion close a different active turn', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-active', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'turn.completed',
        turnId: 'turn-stale',
        payload: { state: 'completed' }
      })
    )
    await ingestion.drain()

    const thread = engine.getThread('thread-1')
    expect(thread.session?.status).toBe('running')
    expect(thread.session?.activeTurnId).toBe('turn-active')
  })

  it('finalizes plan text when a turn completes', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        payload: { streamKind: 'plan_text', delta: '<proposed_plan>Ship it</proposed_plan>' }
      })
    )
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').proposedPlans[0]).toEqual(
      expect.objectContaining({
        id: 'plan:thread-1:turn:turn-1',
        text: '<proposed_plan>Ship it</proposed_plan>',
        status: 'proposed'
      })
    )
  })

  it('keeps separate tools with the same title and appends output to the matching tool', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'tool-1',
        payload: {
          itemType: 'command_execution',
          status: 'inProgress',
          title: 'terminal',
          detail: 'bun test'
        }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'tool-1',
        payload: { streamKind: 'command_output', delta: 'one\n' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'tool-2',
        payload: {
          itemType: 'command_execution',
          status: 'inProgress',
          title: 'terminal',
          detail: 'bun build'
        }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'tool-2',
        payload: { streamKind: 'command_output', delta: 'two\n' }
      })
    )
    await ingestion.drain()

    const tools = engine
      .getThread('thread-1')
      .activities.filter((activity) => activity.kind.startsWith('tool.'))
    expect(tools).toHaveLength(2)
    expect(tools.map((activity) => activity.id)).toEqual(['tool:tool-1', 'tool:tool-2'])
    expect(tools[0].payload?.output).toBe('one\n')
    expect(tools[1].payload?.output).toBe('two\n')
    expect(tools[0].sequence).toBeLessThan(tools[1].sequence ?? Number.MAX_SAFE_INTEGER)
  })

  it('updates one tool tile when the same provider item changes state', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: {
          itemType: 'command_execution',
          status: 'inProgress',
          title: '/bin/zsh -lc ls',
          detail: '/bin/zsh -lc ls'
        }
      })
    )
    ingestion.enqueue(
      event({
        type: 'item.updated',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: {
          itemType: 'command_execution',
          status: 'completed',
          title: '/bin/zsh -lc ls'
        }
      })
    )
    await ingestion.drain()

    const tools = engine
      .getThread('thread-1')
      .activities.filter((activity) => activity.id === 'tool:call-1')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        summary: '/bin/zsh -lc ls',
        payload: expect.objectContaining({
          status: 'completed',
          title: '/bin/zsh -lc ls',
          detail: '/bin/zsh -lc ls'
        })
      })
    )
  })

  it('turns reasoning items into transient thinking activity', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        payload: {
          itemType: 'reasoning',
          status: 'inProgress'
        }
      })
    )
    await ingestion.drain()
    expect(engine.getThread('thread-1').activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'thinking:reasoning-1',
          kind: 'task.started',
          tone: 'thinking',
          summary: 'Thinking',
          resolved: false
        })
      ])
    )

    ingestion.enqueue(
      event({
        type: 'item.completed',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        payload: {
          itemType: 'reasoning',
          status: 'completed'
        }
      })
    )
    await ingestion.drain()
    expect(
      engine
        .getThread('thread-1')
        .activities.find((activity) => activity.id === 'thinking:reasoning-1')
    ).toEqual(
      expect.objectContaining({
        kind: 'task.completed',
        resolved: true
      })
    )
  })

  it('turns assistant message items into assistant messages, not tool activities', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'item.completed',
        turnId: 'turn-1',
        itemId: 'agent-1',
        payload: {
          itemType: 'assistant_message',
          status: 'completed',
          data: { text: 'The result is ready.' }
        }
      })
    )
    await ingestion.drain()

    const thread = engine.getThread('thread-1')
    expect(thread.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          text: 'The result is ready.'
        })
      ])
    )
    expect(thread.activities.some((activity) => activity.id.includes('agent-1'))).toBe(false)
  })
})

function event<T extends ProviderRuntimeEvent['type']>(
  input: Extract<ProviderRuntimeEvent, { type: T }> extends infer E
    ? Omit<E, 'eventId' | 'provider' | 'threadId' | 'createdAt'>
    : never
): ProviderRuntimeEvent {
  return {
    eventId: `event:${Math.random()}`,
    provider: 'codex',
    threadId: 'thread-1',
    createdAt,
    raw: { source: 'fake.provider', payload: input },
    ...input
  } as unknown as ProviderRuntimeEvent
}

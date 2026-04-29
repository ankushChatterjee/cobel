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
          kind: 'approval.resolved',
          resolved: true
        })
      ])
    )
    expect(thread.session?.status).toBe('ready')
  })

  it('accumulates reasoning_text on the thinking activity and keeps it when the reasoning item completes', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'reason-1',
        payload: { streamKind: 'reasoning_text', delta: 'First ' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'reason-1',
        payload: { streamKind: 'reasoning_text', delta: 'thought.' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'item.completed',
        turnId: 'turn-1',
        itemId: 'reason-1',
        payload: {
          itemType: 'reasoning',
          status: 'completed',
          data: {}
        }
      })
    )
    await ingestion.drain()

    const thinking = engine.getThread('thread-1').activities.find((a) => a.id === 'thinking:reason-1')
    expect(thinking).toEqual(
      expect.objectContaining({
        tone: 'thinking',
        resolved: true,
        payload: expect.objectContaining({
          itemType: 'reasoning',
          status: 'completed',
          reasoningText: 'First thought.'
        })
      })
    )
  })

  it('resolves reasoning thinking when assistant_text streaming starts, before reasoning item completes', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'reason-1',
        payload: { streamKind: 'reasoning_text', delta: 'Working it out…' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        payload: { streamKind: 'assistant_text', delta: 'Hello' }
      })
    )
    await ingestion.drain()

    const thinking = engine.getThread('thread-1').activities.find((a) => a.id === 'thinking:reason-1')
    expect(thinking).toEqual(
      expect.objectContaining({
        resolved: true,
        kind: 'task.completed',
        payload: expect.objectContaining({
          reasoningText: 'Working it out…',
          itemType: 'reasoning',
          status: 'completed'
        })
      })
    )
  })

  it('preserves file-change approval args when the approval resolves', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)
    const args = {
      item: {
        type: 'fileChange',
        changes: [
          {
            path: 'src/app.ts',
            kind: 'edit',
            diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
          }
        ]
      }
    }

    ingestion.enqueue(
      event({
        type: 'request.opened',
        turnId: 'turn-1',
        requestId: 'approval-1',
        payload: {
          requestType: 'file_change_approval',
          detail: 'src/app.ts',
          args
        }
      })
    )
    ingestion.enqueue(
      event({
        type: 'request.resolved',
        turnId: 'turn-1',
        requestId: 'approval-1',
        payload: {
          requestType: 'unknown',
          decision: 'accept',
          resolution: { decision: 'accept' }
        }
      })
    )
    await ingestion.drain()

    expect(
      engine
        .getThread('thread-1')
        .activities.find((activity) => activity.id === 'approval:approval-1')
    ).toEqual(
      expect.objectContaining({
        kind: 'approval.resolved',
        summary: 'src/app.ts',
        payload: expect.objectContaining({
          requestType: 'file_change_approval',
          decision: 'accept',
          args
        })
      })
    )
  })

  it('attaches provider approval resolution without a request id to the pending approval', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

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
        type: 'request.resolved',
        turnId: 'turn-1',
        payload: {
          requestType: 'unknown',
          decision: 'accept',
          resolution: {}
        }
      })
    )
    await ingestion.drain()

    const approvals = engine
      .getThread('thread-1')
      .activities.filter((activity) => activity.id.startsWith('approval:'))
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toEqual(
      expect.objectContaining({
        id: 'approval:approval-1',
        kind: 'approval.resolved',
        payload: expect.objectContaining({ decision: 'accept' })
      })
    )
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

  it('uses final assistant item snapshots to close streamed messages without duplicating text', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'agent-1',
        payload: { streamKind: 'assistant_text', delta: 'The result is ready.' }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'agent-1',
        raw: { source: 'codex.app-server.notification', method: 'item/completed', payload: {} },
        payload: { streamKind: 'assistant_text', delta: 'The result is ready.' }
      })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'The result is ready.',
        streaming: false
      })
    ])
  })

  it('still creates a closed assistant message from a final snapshot without prior deltas', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'agent-1',
        raw: { source: 'codex.app-server.notification', method: 'item/completed', payload: {} },
        payload: { streamKind: 'assistant_text', delta: 'Only final text.' }
      })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'Only final text.',
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

  it('records an active turn runtime error and marks the session errored', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'runtime.error',
        turnId: 'turn-1',
        payload: { message: 'exec_command failed' }
      })
    )
    await ingestion.drain()

    const thread = engine.getThread('thread-1')
    expect(thread.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'runtime.error',
          summary: 'exec_command failed',
          turnId: 'turn-1'
        })
      ])
    )
    expect(thread.session).toEqual(
      expect.objectContaining({
        status: 'error',
        activeTurnId: null,
        lastError: 'exec_command failed'
      })
    )
  })

  it('records stale turn runtime errors without overwriting the active running session', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-active', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'runtime.error',
        turnId: 'turn-stale',
        payload: { message: 'stale failure' }
      })
    )
    await ingestion.drain()

    const thread = engine.getThread('thread-1')
    expect(thread.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'runtime.error',
          summary: 'stale failure',
          turnId: 'turn-stale'
        })
      ])
    )
    expect(thread.session).toEqual(
      expect.objectContaining({
        status: 'running',
        activeTurnId: 'turn-active',
        lastError: null
      })
    )
  })

  it('clears the last runtime error after a later successful turn', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'runtime.error',
        turnId: 'turn-1',
        payload: { message: 'exec_command failed' }
      })
    )
    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-2', payload: {} }))
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-2', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').session).toEqual(
      expect.objectContaining({
        status: 'ready',
        activeTurnId: null,
        lastError: null
      })
    )
  })

  it('finalizes activities for a stale completed turn without closing the active turn', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-active', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-stale',
        itemId: 'tool-stale',
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
        type: 'item.started',
        turnId: 'turn-stale',
        itemId: 'reasoning-stale',
        payload: {
          itemType: 'reasoning',
          status: 'inProgress'
        }
      })
    )
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
    expect(thread.activities.find((activity) => activity.id === 'tool:tool-stale')).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
    expect(
      thread.activities.find((activity) => activity.id === 'thinking:reasoning-stale')
    ).toEqual(
      expect.objectContaining({
        kind: 'task.completed',
        resolved: true,
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
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
        text: 'Ship it',
        status: 'proposed'
      })
    )
  })

  it('updates the active plan instead of creating a new one for plan feedback', async () => {
    const engine = new OrchestrationEngine()
    engine.ensureThread({ threadId: 'thread-1' })
    engine.upsertProposedPlan(
      {
        id: 'plan:thread-1:turn:turn-1',
        turnId: 'turn-1',
        text: 'Original plan',
        status: 'proposed',
        createdAt,
        updatedAt: createdAt
      },
      'thread-1'
    )
    engine.setSession({
      threadId: 'thread-1',
      status: 'running',
      providerName: 'codex',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'plan',
      activeTurnId: 'turn-2',
      activePlanId: 'plan:thread-1:turn:turn-1',
      lastError: null,
      createdAt
    })
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-2',
        payload: { streamKind: 'plan_text', delta: '<proposed_plan>Refined plan</proposed_plan>' }
      })
    )
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-2', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    expect(engine.getThread('thread-1').proposedPlans).toHaveLength(1)
    expect(engine.getThread('thread-1').proposedPlans[0]).toEqual(
      expect.objectContaining({
        id: 'plan:thread-1:turn:turn-1',
        turnId: 'turn-2',
        text: 'Refined plan',
        status: 'proposed',
        createdAt
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

  it('keeps a completed tool completed when late output arrives', async () => {
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
          title: 'terminal',
          detail: 'bun test'
        }
      })
    )
    ingestion.enqueue(
      event({
        type: 'item.completed',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: {
          itemType: 'command_execution',
          status: 'completed',
          title: 'terminal'
        }
      })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: { streamKind: 'command_output', delta: 'done\n' }
      })
    )
    await ingestion.drain()

    const tool = engine
      .getThread('thread-1')
      .activities.find((activity) => activity.id === 'tool:call-1')
    expect(tool).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({
          status: 'completed',
          output: 'done\n'
        })
      })
    )
  })

  it('creates a live command tool row from command output when no item lifecycle arrived yet', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'call-from-output',
        payload: { streamKind: 'command_output', delta: 'pwd\n' }
      })
    )
    await ingestion.drain()

    expect(
      engine
        .getThread('thread-1')
        .activities.find((activity) => activity.id === 'tool:call-from-output')
    ).toEqual(
      expect.objectContaining({
        kind: 'tool.updated',
        summary: 'terminal',
        payload: expect.objectContaining({
          itemType: 'command_execution',
          status: 'inProgress',
          title: 'terminal',
          output: 'pwd\n'
        })
      })
    )
  })

  it('keeps a completed tool completed when late item updates arrive', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(
      event({
        type: 'item.completed',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: {
          itemType: 'command_execution',
          status: 'completed',
          title: 'terminal',
          detail: 'bun test'
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
          status: 'inProgress',
          title: 'terminal'
        }
      })
    )
    await ingestion.drain()

    expect(
      engine.getThread('thread-1').activities.find((activity) => activity.id === 'tool:call-1')
    ).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('marks newly seen late item updates for an already completed turn as completed', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    ingestion.enqueue(
      event({
        type: 'item.updated',
        turnId: 'turn-1',
        itemId: 'late-call',
        payload: {
          itemType: 'command_execution',
          status: 'inProgress',
          title: 'terminal',
          detail: 'pwd'
        }
      })
    )
    await ingestion.drain()

    expect(
      engine.getThread('thread-1').activities.find((activity) => activity.id === 'tool:late-call')
    ).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('marks newly seen late output for an already completed turn as completed', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    ingestion.enqueue(
      event({
        type: 'content.delta',
        turnId: 'turn-1',
        itemId: 'late-call',
        payload: { streamKind: 'command_output', delta: 'done\n' }
      })
    )
    await ingestion.drain()

    expect(
      engine.getThread('thread-1').activities.find((activity) => activity.id === 'tool:late-call')
    ).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({
          itemType: 'command_execution',
          status: 'completed',
          title: 'terminal',
          output: 'done\n'
        })
      })
    )
  })

  it('keeps resolved thinking resolved when late reasoning updates arrive', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

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
    ingestion.enqueue(
      event({
        type: 'item.updated',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        payload: {
          itemType: 'reasoning',
          status: 'inProgress'
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
        resolved: true,
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('marks newly seen late reasoning updates for an already completed turn as resolved', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    ingestion.enqueue(
      event({
        type: 'item.updated',
        turnId: 'turn-1',
        itemId: 'late-reasoning',
        payload: {
          itemType: 'reasoning',
          status: 'inProgress'
        }
      })
    )
    await ingestion.drain()

    expect(
      engine
        .getThread('thread-1')
        .activities.find((activity) => activity.id === 'thinking:late-reasoning')
    ).toEqual(
      expect.objectContaining({
        kind: 'task.completed',
        resolved: true,
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('resolves thinking when the turn completes without a reasoning item completion', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
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
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    expect(
      engine
        .getThread('thread-1')
        .activities.find((activity) => activity.id === 'thinking:reasoning-1')
    ).toEqual(
      expect.objectContaining({
        kind: 'task.completed',
        resolved: true,
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('marks still-running terminal tools completed when the turn completes', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: {
          itemType: 'command_execution',
          status: 'inProgress',
          title: 'terminal',
          detail: 'bun test'
        }
      })
    )
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'completed' } })
    )
    await ingestion.drain()

    expect(
      engine.getThread('thread-1').activities.find((activity) => activity.id === 'tool:call-1')
    ).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('marks still-running terminal tools failed when the turn fails', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'call-1',
        payload: {
          itemType: 'command_execution',
          status: 'inProgress',
          title: 'terminal',
          detail: 'bun test'
        }
      })
    )
    ingestion.enqueue(
      event({ type: 'turn.completed', turnId: 'turn-1', payload: { state: 'failed' } })
    )
    await ingestion.drain()

    expect(
      engine.getThread('thread-1').activities.find((activity) => activity.id === 'tool:call-1')
    ).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({ status: 'failed' })
      })
    )
  })

  it('marks still-running activities failed when the session closes without turn completion', async () => {
    const engine = new OrchestrationEngine()
    const ingestion = new ProviderRuntimeIngestion(engine)

    ingestion.enqueue(event({ type: 'turn.started', turnId: 'turn-1', payload: {} }))
    ingestion.enqueue(
      event({
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'call-1',
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
        type: 'item.started',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        payload: {
          itemType: 'reasoning',
          status: 'inProgress'
        }
      })
    )
    ingestion.enqueue(event({ type: 'session.state.changed', payload: { state: 'stopped' } }))
    await ingestion.drain()

    const thread = engine.getThread('thread-1')
    expect(thread.latestTurn).toEqual(
      expect.objectContaining({
        id: 'turn-1',
        status: 'interrupted',
        completedAt: createdAt
      })
    )
    expect(thread.activities.find((activity) => activity.id === 'tool:call-1')).toEqual(
      expect.objectContaining({
        kind: 'tool.completed',
        payload: expect.objectContaining({ status: 'failed' })
      })
    )
    expect(thread.activities.find((activity) => activity.id === 'thinking:reasoning-1')).toEqual(
      expect.objectContaining({
        kind: 'task.completed',
        resolved: true,
        payload: expect.objectContaining({ status: 'completed' })
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

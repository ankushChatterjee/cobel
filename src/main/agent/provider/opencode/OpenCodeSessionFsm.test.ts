import { describe, expect, it, vi } from 'vitest'

vi.mock('./opencodeRuntime', () => ({
  appendOpenCodeAssistantTextDelta: vi.fn((previous: string, delta: string) => ({
    nextText: previous + delta,
    deltaToEmit: delta
  })),
  mergeOpenCodeAssistantText: vi.fn((previous: string | undefined, text: string) => ({
    latestText: text,
    deltaToEmit: previous === undefined ? text : text.slice(previous.length)
  })),
  openCodeQuestionId: vi.fn((index: number) => `q-${index}`)
}))

import { OpenCodeSessionFsm } from './OpenCodeSessionFsm'

const THREAD = 'thread-1'
const SESSION = 'session:abc'

function makeFsm(interactionMode = 'default'): OpenCodeSessionFsm {
  const fsm = new OpenCodeSessionFsm(THREAD, SESSION)
  fsm.setInteractionMode(interactionMode)
  return fsm
}

function sdkEvent(
  type: string,
  properties: Record<string, unknown> = {}
): { type: string; properties: Record<string, unknown> } {
  return { type, properties: { sessionID: SESSION, ...properties } }
}

describe('OpenCodeSessionFsm — turn lifecycle', () => {
  it('idle → running: beginTurn emits turn.started', () => {
    const fsm = makeFsm()
    const effects = fsm.beginTurn('turn-1', { model: 'anthropic/claude', effort: 'medium' })
    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({
      type: 'turn.started',
      turnId: 'turn-1',
      provider: 'opencode',
      threadId: THREAD,
      payload: { model: 'anthropic/claude', effort: 'medium' }
    })
    expect(fsm.activeTurnId).toBe('turn-1')
  })

  it('multi-step turn: 3x tool-calls then stop+idle → exactly one turn.completed', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    // Three assistant messages with finish: 'tool-calls'
    for (let i = 0; i < 3; i++) {
      fsm.dispatch(
        sdkEvent('message.updated', {
          info: { id: `msg-${i}`, role: 'assistant', finish: 'tool-calls' }
        })
      )
    }
    expect(fsm.activeTurnId).toBe('turn-1')

    // Final message with finish: 'stop' → awaiting_idle
    fsm.dispatch(
      sdkEvent('message.updated', { info: { id: 'msg-final', role: 'assistant', finish: 'stop' } })
    )
    expect(fsm.activeTurnId).toBe('turn-1') // still active

    // session.idle → complete
    const effects = fsm.dispatch(sdkEvent('session.idle'))
    const completions = effects.filter((e) => e.type === 'turn.completed')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({
      type: 'turn.completed',
      turnId: 'turn-1',
      payload: { state: 'completed' }
    })
    expect(fsm.activeTurnId).toBeUndefined()
    expect(fsm.lastTurnId).toBe('turn-1')
  })

  it('session.idle during running (without finish:stop) still completes the turn', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    const effects = fsm.dispatch(sdkEvent('session.idle'))
    const completions = effects.filter((e) => e.type === 'turn.completed')
    // Should still complete
    expect(completions).toHaveLength(1)
  })

  it('terminal state rejects further session.idle events (no double completion)', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('session.idle')) // completes
    const secondIdle = fsm.dispatch(sdkEvent('session.idle'))
    expect(secondIdle.filter((e) => e.type === 'turn.completed')).toHaveLength(0)
  })

  it('doInterrupt emits turn.completed:interrupted and sets pendingInterruptId', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    const effects = fsm.doInterrupt('turn-1')
    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({
      type: 'turn.completed',
      turnId: 'turn-1',
      payload: { state: 'interrupted' }
    })
    expect(fsm.activeTurnId).toBeUndefined()
  })

  it('session.error after interrupt is swallowed when error is MessageAbortedError (B5 fix)', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.doInterrupt('turn-1')

    const effects = fsm.dispatch(
      sdkEvent('session.error', {
        error: { name: 'MessageAbortedError', message: 'Session aborted' }
      })
    )
    // Should produce NO runtime.error or turn.completed
    expect(effects.filter((e) => e.type === 'runtime.error')).toHaveLength(0)
    expect(effects.filter((e) => e.type === 'turn.completed')).toHaveLength(0)
  })

  it('session.error without prior interrupt emits runtime.error + turn.completed:failed', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    const effects = fsm.dispatch(
      sdkEvent('session.error', {
        error: { data: { message: 'Something went wrong', name: 'SomeOtherError' } }
      })
    )
    expect(effects.filter((e) => e.type === 'runtime.error')).toHaveLength(1)
    const completion = effects.find((e) => e.type === 'turn.completed')
    expect(completion).toMatchObject({
      payload: { state: 'failed' }
    })
  })
})

describe('OpenCodeSessionFsm — B4: startTurn during awaiting_idle is queued', () => {
  it('queues the second turn and emits both turn.completed+turn.started on idle', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    // Transition to awaiting_idle
    fsm.dispatch(
      sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant', finish: 'stop' } })
    )

    // Second turn while awaiting_idle — should NOT emit turn.started immediately
    const secondBeginEffects = fsm.beginTurn('turn-2', { model: 'foo' })
    expect(secondBeginEffects.filter((e) => e.type === 'turn.started')).toHaveLength(0)
    // activeTurnId is still turn-1
    expect(fsm.activeTurnId).toBe('turn-1')

    // Now session.idle fires
    const idleEffects = fsm.dispatch(sdkEvent('session.idle'))
    const completions = idleEffects.filter((e) => e.type === 'turn.completed')
    const starts = idleEffects.filter((e) => e.type === 'turn.started')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ turnId: 'turn-1', payload: { state: 'completed' } })
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ turnId: 'turn-2', payload: { model: 'foo' } })

    // Completion order: turn.completed then turn.started
    const completionIdx = idleEffects.indexOf(completions[0]!)
    const startIdx = idleEffects.indexOf(starts[0]!)
    expect(completionIdx).toBeLessThan(startIdx)

    expect(fsm.activeTurnId).toBe('turn-2')
  })
})

describe('OpenCodeSessionFsm — tool part lifecycle', () => {
  it('late running snapshot after completed is dropped', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    const runningPart = {
      id: 'tool-1',
      callID: 'call-1',
      messageID: 'msg-1',
      type: 'tool',
      tool: 'bash',
      metadata: {},
      state: { status: 'running', input: { command: 'ls' }, time: { start: 1 }, metadata: {} }
    }
    const completedPart = {
      ...runningPart,
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'file.ts',
        time: { start: 1, end: 2 },
        metadata: {}
      }
    }

    const running1 = fsm.dispatch(sdkEvent('message.part.updated', { part: runningPart }))
    expect(running1.some((e) => e.type === 'item.updated')).toBe(true)

    const completed = fsm.dispatch(sdkEvent('message.part.updated', { part: completedPart }))
    expect(completed.some((e) => e.type === 'item.completed')).toBe(true)

    // Stale running event after completed → dropped
    const staleRunning = fsm.dispatch(sdkEvent('message.part.updated', { part: runningPart }))
    expect(staleRunning.filter((e) => e.itemId === 'call-1')).toHaveLength(0)
  })

  it('pending tool part emits item.started with placeholder title', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))
    const pendingPart = {
      id: 'tool-1',
      callID: 'call-1',
      messageID: 'msg-1',
      type: 'tool',
      tool: 'edit',
      metadata: {},
      state: { status: 'pending', metadata: {} }
    }
    const effects = fsm.dispatch(sdkEvent('message.part.updated', { part: pendingPart }))
    const started = effects.find((e) => e.type === 'item.started')
    expect(started).toBeDefined()
    expect((started?.payload as { title?: string })?.title).toBe('Preparing edit')
  })

  it('running edit part with filePath shows basename as title', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))
    const runningPart = {
      id: 'tool-1',
      callID: 'call-1',
      messageID: 'msg-1',
      type: 'tool',
      tool: 'edit',
      metadata: {},
      state: {
        status: 'running',
        input: { filePath: 'src/components/Button.tsx' },
        time: { start: 1 },
        metadata: {}
      }
    }
    const effects = fsm.dispatch(sdkEvent('message.part.updated', { part: runningPart }))
    const updated = effects.find((e) => e.type === 'item.updated')
    expect((updated?.payload as { title?: string })?.title).toBe('Button.tsx')
  })
})

describe('OpenCodeSessionFsm — permission lifecycle', () => {
  it('decline keeps turn alive (B1 fix)', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')

    // Tool running
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    // Permission asked
    fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls'],
        metadata: {}
      })
    )

    // Permission replied with reject (→ decline)
    const effects = fsm.dispatch(
      sdkEvent('permission.replied', { requestID: 'perm-1', reply: 'reject' })
    )

    // request.resolved with decision: decline
    const resolved = effects.find((e) => e.type === 'request.resolved')
    expect(resolved).toMatchObject({ payload: { decision: 'decline' } })

    // Turn should still be alive
    expect(fsm.activeTurnId).toBe('turn-1')
    // No turn.completed
    expect(effects.filter((e) => e.type === 'turn.completed')).toHaveLength(0)
  })

  it('resolves all open permissions with cancel on session.error', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls'],
        metadata: {}
      })
    )

    const effects = fsm.dispatch(
      sdkEvent('session.error', { error: { data: { message: 'error' } } })
    )
    const resolved = effects.filter((e) => e.type === 'request.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ payload: { decision: 'cancel' } })
  })

  it('optimistic permission reply deduplicates the SDK echo', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls'],
        metadata: {}
      })
    )

    // Optimistic reply from respondToApproval
    const optimistic = fsm.replyToPermission('perm-1', 'accept', undefined)
    expect(optimistic.shouldReplyToSdk).toBe(true)
    expect(optimistic.effects.filter((e) => e.type === 'request.resolved')).toHaveLength(1)

    // SDK echo arrives — should be dropped
    const echoEffects = fsm.dispatch(
      sdkEvent('permission.replied', { requestID: 'perm-1', reply: 'once' })
    )
    expect(echoEffects.filter((e) => e.type === 'request.resolved')).toHaveLength(0)
  })

  it('does not reopen a resolved permission when OpenCode replays permission.asked', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    const opened = fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls'],
        metadata: {}
      })
    )
    expect(opened.filter((e) => e.type === 'request.opened')).toHaveLength(1)

    const optimistic = fsm.replyToPermission('perm-1', 'accept', undefined)
    expect(optimistic.effects.filter((e) => e.type === 'request.resolved')).toHaveLength(1)

    const replayed = fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls -la'],
        metadata: {}
      })
    )
    expect(replayed.filter((e) => e.type === 'request.opened')).toHaveLength(0)

    const duplicateReply = fsm.replyToPermission('perm-1', 'accept', undefined)
    expect(duplicateReply.shouldReplyToSdk).toBe(false)
    expect(duplicateReply.effects).toHaveLength(0)
  })

  it('does not re-resolve a permission when its approved tool later completes', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))
    fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls'],
        metadata: {},
        tool: { callID: 'call-1' }
      })
    )

    const optimistic = fsm.replyToPermission('perm-1', 'accept', undefined)
    expect(optimistic.effects.filter((e) => e.type === 'request.resolved')).toHaveLength(1)

    const completed = fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: {
          id: 'tool-1',
          callID: 'call-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'bash',
          metadata: {},
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'file.ts',
            time: { start: 1, end: 2 },
            metadata: {}
          }
        }
      })
    )

    expect(completed.some((e) => e.type === 'item.completed')).toBe(true)
    expect(completed.filter((e) => e.type === 'request.resolved')).toHaveLength(0)
  })

  it('deduplicates duplicate open permission asks while still pending', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    const first = fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['ls'],
        metadata: {}
      })
    )
    const duplicate = fsm.dispatch(
      sdkEvent('permission.asked', {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['pwd'],
        metadata: {}
      })
    )

    expect(first.filter((e) => e.type === 'request.opened')).toHaveLength(1)
    expect(duplicate.filter((e) => e.type === 'request.opened')).toHaveLength(0)
  })
})

describe('OpenCodeSessionFsm — reasoning part', () => {
  it('late reasoning completion arrives after turn completed and is still attached', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    // Reasoning part without time.end
    fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: {
          id: 'reasoning-1',
          messageID: 'msg-1',
          type: 'reasoning',
          text: 'Thinking...',
          time: { start: 1 }
        }
      })
    )

    // Turn completes (session.idle arrives)
    fsm.dispatch(sdkEvent('session.idle'))

    // Late reasoning part with time.end
    const effects = fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: {
          id: 'reasoning-1',
          messageID: 'msg-1',
          type: 'reasoning',
          text: 'Thinking...',
          time: { start: 1, end: 2 }
        }
      })
    )

    const completed = effects.find((e) => e.type === 'item.completed')
    expect(completed).toMatchObject({
      type: 'item.completed',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      payload: { itemType: 'reasoning', status: 'completed' }
    })
  })

  it('reasoning part does not emit item.completed twice (completedReasoningPartIds dedup)', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    const partWithEnd = {
      id: 'reasoning-1',
      messageID: 'msg-1',
      type: 'reasoning',
      text: 'Done',
      time: { start: 1, end: 2 }
    }

    const first = fsm.dispatch(sdkEvent('message.part.updated', { part: partWithEnd }))
    const second = fsm.dispatch(sdkEvent('message.part.updated', { part: partWithEnd }))

    const firstCompletions = first.filter(
      (e) => e.type === 'item.completed' && e.itemId === 'reasoning-1'
    )
    const secondCompletions = second.filter(
      (e) => e.type === 'item.completed' && e.itemId === 'reasoning-1'
    )
    expect(firstCompletions).toHaveLength(1)
    expect(secondCompletions).toHaveLength(0)
  })
})

describe('OpenCodeSessionFsm — session.diff is dropped entirely (B3 fix)', () => {
  it('session.diff events produce no effects', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    const effects = fsm.dispatch(
      sdkEvent('session.diff', {
        diff: [{ file: 'src/app.ts', patch: 'diff...' }]
      })
    )
    expect(effects).toHaveLength(0)
  })
})

describe('OpenCodeSessionFsm — session.compacted clears caches (S1.7)', () => {
  it('compact() clears per-message and per-part caches', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))
    fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: {
          id: 'text-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Hello'
        }
      })
    )

    // Verify part is tracked
    expect(fsm.partById.has('text-1')).toBe(true)

    // Compact
    const effects = fsm.dispatch(sdkEvent('session.compacted'))
    expect(effects.some((e) => e.type === 'runtime.info')).toBe(true)

    // Caches should be cleared
    expect(fsm.partById.has('text-1')).toBe(false)
    // But the active turn should still be running
    expect(fsm.activeTurnId).toBe('turn-1')
  })
})

describe('OpenCodeSessionFsm — B7: plan-mode routing', () => {
  it('routes assistant text deltas as plan_text when interactionMode is plan', () => {
    const fsm = makeFsm('plan')
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    const effects = fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: {
          id: 'text-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Plan step 1'
        }
      })
    )

    const delta = effects.find((e) => e.type === 'content.delta')
    expect(delta?.payload).toMatchObject({ streamKind: 'plan_text' })
  })

  it('routes reasoning as reasoning_text regardless of interactionMode', () => {
    const fsm = makeFsm('plan')
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    const effects = fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: {
          id: 'reasoning-1',
          messageID: 'msg-1',
          type: 'reasoning',
          text: 'Thinking about the plan',
          time: { start: 1 }
        }
      })
    )

    const delta = effects.find((e) => e.type === 'content.delta')
    expect(delta?.payload).toMatchObject({ streamKind: 'reasoning_text' })
  })

  it('default mode uses assistant_text for text parts', () => {
    const fsm = makeFsm('default')
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))

    const effects = fsm.dispatch(
      sdkEvent('message.part.updated', {
        part: { id: 'text-1', messageID: 'msg-1', type: 'text', text: 'Hello' }
      })
    )

    const delta = effects.find((e) => e.type === 'content.delta')
    expect(delta?.payload).toMatchObject({ streamKind: 'assistant_text' })
  })
})

describe('OpenCodeSessionFsm — B8: optimistic question close', () => {
  it('replyToQuestion emits user-input.resolved and the late SDK echo is deduplicated', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')

    // Question asked
    const request = {
      questions: [
        { header: 'Choose', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }
      ]
    }
    fsm.dispatch(
      sdkEvent('question.asked', {
        id: 'question-1',
        ...request
      })
    )

    // Optimistic close from respondToUserInput
    const effects = fsm.replyToQuestion('question-1', { 'q-0': 'A' }, request as never, undefined)
    expect(effects.filter((e) => e.type === 'user-input.resolved')).toHaveLength(1)
    expect(fsm.pendingQuestions.has('question-1')).toBe(false)

    // SDK echo → should be deduped
    const echoEffects = fsm.dispatch(
      sdkEvent('question.replied', { requestID: 'question-1', answers: [['A']] })
    )
    expect(echoEffects.filter((e) => e.type === 'user-input.resolved')).toHaveLength(0)
  })
})

describe('OpenCodeSessionFsm — eventBelongsToContext', () => {
  it('accepts events with matching sessionID', () => {
    const fsm = makeFsm()
    expect(
      fsm.eventBelongsToContext({ type: 'session.idle', properties: { sessionID: SESSION } })
    ).toBe(true)
  })

  it('rejects events with different sessionID', () => {
    const fsm = makeFsm()
    expect(
      fsm.eventBelongsToContext({
        type: 'session.idle',
        properties: { sessionID: 'session:other' }
      })
    ).toBe(false)
  })

  it('accepts untagged message.part.updated for known message', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.dispatch(sdkEvent('message.updated', { info: { id: 'msg-1', role: 'assistant' } }))
    expect(
      fsm.eventBelongsToContext({
        type: 'message.part.updated',
        properties: {
          part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'Hi' }
        }
      })
    ).toBe(true)
  })

  it('rejects untagged message.part.updated for unknown message', () => {
    const fsm = makeFsm()
    expect(
      fsm.eventBelongsToContext({
        type: 'message.part.updated',
        properties: {
          part: { id: 'part-unknown', messageID: 'msg-unknown', type: 'text', text: 'hi' }
        }
      })
    ).toBe(false)
  })
})

describe('OpenCodeSessionFsm — resetForNewTurn after terminal state', () => {
  it('allows new turn after interrupt + resetForNewTurn', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.doInterrupt('turn-1')
    expect(fsm.activeTurnId).toBeUndefined()

    // Without reset, beginTurn might not work as expected
    fsm.resetForNewTurn()
    const effects = fsm.beginTurn('turn-2')
    expect(effects.some((e) => e.type === 'turn.started')).toBe(true)
    expect(fsm.activeTurnId).toBe('turn-2')
  })

  it('pendingInterruptId is cleared on next beginTurn (B5)', () => {
    const fsm = makeFsm()
    fsm.beginTurn('turn-1')
    fsm.doInterrupt('turn-1')
    fsm.resetForNewTurn()
    fsm.beginTurn('turn-2')

    // Session error after next turn is NOT swallowed (the interrupt flag was cleared)
    const effects = fsm.dispatch(
      sdkEvent('session.error', {
        error: { name: 'MessageAbortedError', message: 'aborted' }
      })
    )
    // turn-2 is still running — this should fail the turn, not be swallowed
    expect(effects.filter((e) => e.type === 'runtime.error')).toHaveLength(1)
  })
})

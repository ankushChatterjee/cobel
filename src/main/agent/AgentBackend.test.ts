import { describe, expect, it } from 'vitest'
import { DEFAULT_THREAD_ID } from '../../shared/agent'
import { AgentBackend } from './AgentBackend'

describe('AgentBackend', () => {
  it('runs a full fake-provider turn through snapshot and live events', async () => {
    const backend = new AgentBackend({ useFakeProvider: true })
    const streamItems: unknown[] = []
    const unsubscribe = backend.subscribeThread({ threadId: DEFAULT_THREAD_ID }, (item) =>
      streamItems.push(item)
    )

    const result = await backend.dispatchCommand({
      type: 'thread.turn.start',
      commandId: 'cmd-1',
      threadId: DEFAULT_THREAD_ID,
      provider: 'codex',
      input: 'Implement the test path',
      cwd: '/tmp/project',
      runtimeMode: 'auto-accept-edits',
      createdAt: '2026-04-19T00:00:00.000Z'
    })
    await backend.drain()
    unsubscribe()

    const thread = backend.engine.getThread(DEFAULT_THREAD_ID)
    expect(result.accepted).toBe(true)
    expect(thread.messages.some((message) => message.role === 'user')).toBe(true)
    expect(thread.messages.some((message) => message.role === 'assistant')).toBe(true)
    expect(thread.messages.every((message) => typeof message.sequence === 'number')).toBe(true)
    expect(thread.activities.some((activity) => activity.kind === 'tool.completed')).toBe(true)
    expect(thread.activities.some((activity) => activity.payload?.output)).toBe(true)
    expect(thread.session?.status).toBe('ready')
    expect(streamItems[0]).toEqual(expect.objectContaining({ kind: 'snapshot' }))
    expect(streamItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'event' })])
    )
  })
})

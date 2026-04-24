import { describe, expect, it } from 'vitest'
import { mapProviderEvent } from './CodexAdapter'
import type { ProviderEvent } from './CodexAppServerManager'

const baseEvent: Omit<ProviderEvent, 'id' | 'method' | 'payload'> = {
  kind: 'notification',
  provider: 'codex',
  threadId: 'thread-1',
  createdAt: '2026-04-19T00:00:00.000Z'
}

describe('mapProviderEvent', () => {
  it('maps provider warning events to runtime warnings', () => {
    expect(
      mapProviderEvent({
        ...baseEvent,
        kind: 'warning',
        id: 'event-warning',
        method: 'runtime/warning',
        message: 'MCP transport unavailable: local MCP server connection was refused.',
        payload: { raw: 'rmcp transport closed' }
      })
    ).toEqual(
      expect.objectContaining({
        type: 'runtime.warning',
        payload: {
          message: 'MCP transport unavailable: local MCP server connection was refused.',
          detail: { raw: 'rmcp transport closed' }
        }
      })
    )
  })

  it('normalizes nested tool item payloads', () => {
    const event = mapProviderEvent({
      ...baseEvent,
      id: 'event-1',
      method: 'item/started',
      itemId: 'item-1',
      payload: {
        item: {
          type: 'command_execution',
          toolName: 'terminal',
          command: 'bun test',
          status: 'running'
        }
      }
    })

    expect(event).toEqual(
      expect.objectContaining({
        type: 'item.started',
        itemId: 'item-1',
        payload: expect.objectContaining({
          itemType: 'command_execution',
          title: 'terminal',
          detail: 'bun test',
          status: 'inProgress',
          data: expect.objectContaining({
            normalized: expect.objectContaining({
              title: 'terminal',
              detail: 'bun test'
            })
          })
        })
      })
    )
  })

  it('uses nested Codex call ids as canonical item ids across state changes', () => {
    const started = mapProviderEvent({
      ...baseEvent,
      id: 'event-started',
      method: 'item/started',
      payload: {
        item: {
          type: 'commandExecution',
          id: 'call_plFbYuh75DJVDRY1m6vjKl0S',
          command: '/bin/zsh -lc ls',
          status: 'inProgress'
        }
      }
    })
    const completed = mapProviderEvent({
      ...baseEvent,
      id: 'event-completed',
      method: 'item/completed',
      payload: {
        item: {
          type: 'commandExecution',
          id: 'call_plFbYuh75DJVDRY1m6vjKl0S',
          command: '/bin/zsh -lc ls',
          status: 'completed'
        }
      }
    })

    expect(started?.itemId).toBe('call_plFbYuh75DJVDRY1m6vjKl0S')
    expect(completed?.itemId).toBe('call_plFbYuh75DJVDRY1m6vjKl0S')
    expect(started?.payload).toEqual(
      expect.objectContaining({
        itemType: 'command_execution',
        title: '/bin/zsh -lc ls',
        status: 'inProgress'
      })
    )
    expect(completed?.payload).toEqual(
      expect.objectContaining({
        itemType: 'command_execution',
        title: '/bin/zsh -lc ls',
        status: 'completed'
      })
    )
  })

  it('maps generic Codex item updates so live tool status can change in place', () => {
    const event = mapProviderEvent({
      ...baseEvent,
      id: 'event-updated',
      method: 'item/updated',
      payload: {
        item: {
          type: 'commandExecution',
          id: 'call-live-1',
          command: '/bin/zsh -lc ls',
          status: 'completed'
        }
      }
    })

    expect(event).toEqual(
      expect.objectContaining({
        type: 'item.updated',
        itemId: 'call-live-1',
        payload: expect.objectContaining({
          itemType: 'command_execution',
          title: '/bin/zsh -lc ls',
          status: 'completed'
        })
      })
    )
  })

  it('ignores Codex userMessage items', () => {
    expect(
      mapProviderEvent({
        ...baseEvent,
        id: 'event-user',
        method: 'item/started',
        payload: {
          item: {
            type: 'userMessage',
            id: 'user-item-1',
            text: 'hello'
          }
        }
      })
    ).toBeNull()
  })

  it('does not treat the local approval decision echo as provider resolution', () => {
    expect(
      mapProviderEvent({
        ...baseEvent,
        id: 'event-approval-decision',
        method: 'item/requestApproval/decision',
        requestId: 'approval-1',
        payload: { decision: 'accept' }
      })
    ).toBeNull()
  })

  it('maps provider approval resolution to an accepted approval result by default', () => {
    expect(
      mapProviderEvent({
        ...baseEvent,
        id: 'event-approval-resolved',
        method: 'serverRequest/resolved',
        requestId: 'approval-1',
        payload: {}
      })
    ).toEqual(
      expect.objectContaining({
        type: 'request.resolved',
        requestId: 'approval-1',
        payload: expect.objectContaining({ decision: 'accept' })
      })
    )
  })

  it('maps Codex agentMessage items to assistant text instead of tool items', () => {
    expect(
      mapProviderEvent({
        ...baseEvent,
        id: 'event-agent',
        method: 'item/completed',
        payload: {
          item: {
            type: 'agentMessage',
            id: 'agent-item-1',
            text: 'Done.'
          }
        }
      })
    ).toEqual(
      expect.objectContaining({
        type: 'content.delta',
        itemId: 'agent-item-1',
        payload: {
          streamKind: 'assistant_text',
          delta: 'Done.'
        }
      })
    )
  })
})

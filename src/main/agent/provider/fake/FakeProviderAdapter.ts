import type { ProviderRuntimeEvent, ProviderSession } from '../../../../shared/agent'
import { createEventId, nowIso, ProviderEventBus } from '../types'
import type { ProviderAdapter, SendTurnInput, StartSessionInput } from '../types'

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = 'codex' as const
  private readonly bus = new ProviderEventBus()
  private readonly sessions = new Map<string, ProviderSession>()

  async getSummary(): Promise<{ id: 'codex'; name: string; status: 'available'; detail: string }> {
    return {
      id: 'codex',
      name: 'Codex',
      status: 'available',
      detail: 'Fake provider for deterministic tests'
    }
  }

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    const now = nowIso()
    const session: ProviderSession = {
      provider: 'codex',
      status: 'ready',
      runtimeMode: input.runtimeMode,
      cwd: input.cwd,
      model: input.model,
      threadId: input.threadId,
      resumeCursor: { threadId: `fake:${input.threadId}` },
      createdAt: now,
      updatedAt: now
    }
    this.sessions.set(input.threadId, session)
    this.emit(input.threadId, { type: 'session.state.changed', payload: { state: 'ready' } })
    return session
  }

  async sendTurn(input: SendTurnInput): Promise<{ turnId: string; resumeCursor?: unknown }> {
    const turnId = createEventId('fake-turn')
    const session = this.sessions.get(input.threadId)
    if (session)
      this.sessions.set(input.threadId, { ...session, activeTurnId: turnId, status: 'running' })
    this.emit(input.threadId, { type: 'turn.started', turnId, payload: {} })
    this.emit(input.threadId, {
      type: 'content.delta',
      turnId,
      payload: {
        streamKind: 'assistant_text',
        delta: `I can work on "${input.input.slice(0, 80)}". This fake provider proves the UI stream.`
      }
    })
    this.emit(input.threadId, {
      type: 'item.started',
      turnId,
      itemId: `tool:${turnId}`,
      payload: {
        itemType: 'command_execution',
        status: 'inProgress',
        title: 'terminal',
        detail: 'echo deterministic smoke'
      }
    })
    this.emit(input.threadId, {
      type: 'content.delta',
      turnId,
      itemId: `tool:${turnId}`,
      payload: {
        streamKind: 'command_output',
        delta: 'deterministic smoke\n'
      }
    })
    this.emit(input.threadId, {
      type: 'item.completed',
      turnId,
      itemId: `tool:${turnId}`,
      payload: {
        itemType: 'command_execution',
        status: 'completed',
        title: 'terminal',
        detail: 'completed'
      }
    })
    this.emit(input.threadId, {
      type: 'turn.completed',
      turnId,
      payload: { state: 'completed' }
    })
    return { turnId, resumeCursor: session?.resumeCursor }
  }

  async interruptTurn(): Promise<void> {
    await Promise.resolve()
  }

  async rollbackConversation(): Promise<void> {
    await Promise.resolve()
  }

  async respondToApproval(): Promise<void> {
    await Promise.resolve()
  }

  async respondToUserInput(): Promise<void> {
    await Promise.resolve()
  }

  async stopSession(input: { threadId: string }): Promise<void> {
    this.sessions.delete(input.threadId)
    this.emit(input.threadId, { type: 'session.state.changed', payload: { state: 'stopped' } })
  }

  async readThread(): Promise<unknown> {
    return null
  }

  streamEvents(listener: (event: ProviderRuntimeEvent) => void): () => void {
    return this.bus.subscribe(listener)
  }

  private emit(
    threadId: string,
    event: Omit<ProviderRuntimeEvent, 'eventId' | 'provider' | 'threadId' | 'createdAt' | 'raw'>
  ): void {
    this.bus.emit({
      eventId: createEventId('fake-event'),
      provider: 'codex',
      threadId,
      createdAt: nowIso(),
      raw: { source: 'fake.provider', payload: event },
      ...event
    } as ProviderRuntimeEvent)
  }
}

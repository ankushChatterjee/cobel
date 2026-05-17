/**
 * RuntimeTurnCompiler
 *
 * Compiles session lifecycle and turn lifecycle `ProviderRuntimeEvent`s
 * (`session.state.changed`, `thread.started`, `turn.started`, `turn.completed`)
 * into `OrchestrationCommand`s.
 *
 * Provider-originated command ids follow the pattern `provider:<eventId>:<purpose>`.
 */
import type { OrchestrationCommand, ProviderRuntimeEvent } from '../../../shared/agent'
import type { ThreadReader } from './RuntimeOperationCompiler'

function isOpenCodeReadyEventMeansTurnIdle(
  event: Extract<ProviderRuntimeEvent, { type: 'session.state.changed' }>
): boolean {
  if (event.provider !== 'opencode') return false
  const raw = event.raw?.payload
  if (!raw || typeof raw !== 'object') return false
  const type = (raw as Record<string, unknown>)['type']
  if (type === 'session.idle') return true
  if (type !== 'session.status') return false
  const properties = (raw as Record<string, unknown>)['properties']
  if (!properties || typeof properties !== 'object') return false
  const status = (properties as Record<string, unknown>)['status']
  if (!status || typeof status !== 'object') return false
  return (status as Record<string, unknown>)['type'] === 'idle'
}

export function compileTurnLifecycleEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: 'session.state.changed' | 'thread.started' | 'turn.started' | 'turn.completed' }
  >,
  readThread: ThreadReader
): OrchestrationCommand[] {
  const commands: OrchestrationCommand[] = []
  const thread = readThread(event.threadId)

  switch (event.type) {
    case 'thread.started':
      // No orchestration command needed; the session start is captured by session.state.changed.
      return []

    case 'session.state.changed': {
      const { state, reason } = event.payload
      const session = thread.session

      const activeTurnId =
        state === 'running'
          ? (event.turnId ?? session?.activeTurnId ?? null)
          : null

      // Determine whether a running turn should be finalized by this ready event.
      const shouldFinalizeTurnOnReady =
        state === 'ready' &&
        (event.provider !== 'opencode' || isOpenCodeReadyEventMeansTurnIdle(event))

      const runningTurnId =
        event.turnId ??
        session?.activeTurnId ??
        (thread.latestTurn?.status === 'running' ? thread.latestTurn.id : null)

      if (
        (state === 'stopped' || state === 'error') &&
        runningTurnId
      ) {
        commands.push({
          type: 'provider.turn.complete',
          commandId: `provider:${event.eventId}:turn-close-on-terminal-session`,
          threadId: event.threadId,
          turnId: runningTurnId,
          provider: event.provider,
          state: state === 'error' ? 'failed' : 'interrupted',
          errorMessage: reason,
          createdAt: event.createdAt
        })
      } else if (shouldFinalizeTurnOnReady && runningTurnId) {
        commands.push({
          type: 'provider.turn.complete',
          commandId: `provider:${event.eventId}:turn-close-on-ready`,
          threadId: event.threadId,
          turnId: runningTurnId,
          provider: event.provider,
          state: 'completed',
          createdAt: event.createdAt
        })
      }

      commands.push({
        type: 'provider.session.update',
        commandId: `provider:${event.eventId}:session`,
        threadId: event.threadId,
        status: mapSessionStatus(state),
        providerName: event.provider,
        runtimeMode: session?.runtimeMode ?? 'auto-accept-edits',
        interactionMode: session?.interactionMode ?? 'default',
        model: session?.model,
        effort: session?.effort,
        activeTurnId: activeTurnId,
        activePlanId: state === 'running' ? (session?.activePlanId ?? null) : null,
        lastError: state === 'error' ? (reason ?? 'Provider error') : null,
        createdAt: event.createdAt
      })
      return commands
    }

    case 'turn.started': {
      const turnId = event.turnId ?? event.eventId
      const thread2 = readThread(event.threadId)
      const session2 = thread2.session
      commands.push({
        type: 'provider.turn.start',
        commandId: `provider:${event.eventId}:turn-start`,
        threadId: event.threadId,
        turnId,
        provider: event.provider,
        model:
          typeof event.payload.model === 'string' ? event.payload.model : session2?.model,
        effort:
          typeof event.payload.effort === 'string'
            ? (event.payload.effort as OrchestrationCommand extends { type: 'provider.turn.start' }
                ? OrchestrationCommand['effort']
                : never)
            : session2?.effort,
        createdAt: event.createdAt
      })
      return commands
    }

    case 'turn.completed': {
      const turnId = event.turnId ?? event.eventId
      commands.push({
        type: 'provider.turn.complete',
        commandId: `provider:${event.eventId}:turn-complete`,
        threadId: event.threadId,
        turnId,
        provider: event.provider,
        state: event.payload.state,
        errorMessage: event.payload.errorMessage,
        createdAt: event.createdAt
      })
      return commands
    }
  }
}

function mapSessionStatus(
  state: 'starting' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error'
): 'starting' | 'running' | 'ready' | 'stopped' | 'error' {
  switch (state) {
    case 'starting':
      return 'starting'
    case 'running':
    case 'waiting':
      return 'running'
    case 'ready':
      return 'ready'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

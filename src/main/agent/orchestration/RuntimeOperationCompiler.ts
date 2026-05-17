/**
 * RuntimeOperationCompiler
 *
 * Top-level dispatcher: maps a `ProviderRuntimeEvent` to one or more
 * `OrchestrationCommand`s. The compiler is pure-ish — it reads current thread
 * state through a read-only getter but does not write to the engine directly.
 *
 * Architecture position:
 *   ProviderRuntimeEvent → RuntimeOperationCompiler → OrchestrationCommand[]
 *                                                   → OrchestrationEngine.dispatch()
 */
import type { OrchestrationThread, ProviderRuntimeEvent } from '../../../shared/agent'
import { compileApprovalEvent, compileUserInputEvent } from './RuntimeApprovalCompiler'
import { compileTodoEvent, compileRuntimeInfoEvent } from './RuntimeMiscCompiler'
import type { RuntimeMessageCompiler } from './RuntimeMessageCompiler'
import { compileTurnLifecycleEvent } from './RuntimeTurnCompiler'
import { compileItemEvent, type CompletedTurnToolStatusLookup } from './RuntimeToolCompiler'

export type ThreadReader = (threadId: string) => OrchestrationThread

/** Options shared by runtime-event compilation (buffers + completed-turn guardrails). */
export interface CompileRuntimeEventOptions {
  messageCompiler: RuntimeMessageCompiler
  completedTurnLookup?: CompletedTurnToolStatusLookup
}

/**
 * Compile a single `ProviderRuntimeEvent` into zero or more
 * `OrchestrationCommand`s to be dispatched to the engine.
 *
 * The `readThread` function provides read-only access to current thread state
 * so compilers can derive context-dependent output (e.g. active turn id).
 */
export function compileRuntimeEvent(
  event: ProviderRuntimeEvent,
  readThread: ThreadReader,
  options: CompileRuntimeEventOptions
) {
  const { messageCompiler, completedTurnLookup } = options
  switch (event.type) {
    case 'session.state.changed':
    case 'thread.started':
    case 'turn.started':
    case 'turn.completed':
      return compileTurnLifecycleEvent(event, readThread)

    case 'content.delta':
      return messageCompiler.compileContentDelta(event, readThread, completedTurnLookup)

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return compileItemEvent(event, readThread, completedTurnLookup)

    case 'request.opened':
    case 'request.resolved':
      return compileApprovalEvent(event, readThread)

    case 'user-input.requested':
    case 'user-input.resolved':
      return compileUserInputEvent(event, readThread)

    case 'todo.updated':
      return compileTodoEvent(event, readThread)

    case 'runtime.error':
    case 'runtime.warning':
    case 'runtime.info':
      return compileRuntimeInfoEvent(event, readThread)

    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

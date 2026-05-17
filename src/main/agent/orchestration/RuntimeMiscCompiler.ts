/**
 * RuntimeMiscCompiler
 *
 * Compiles `todo.updated`, `runtime.info`, `runtime.error`, and
 * `runtime.warning` `ProviderRuntimeEvent`s into `OrchestrationCommand`s.
 */
import type { OrchestrationCommand, OrchestrationTodo, OrchestrationTodoList, ProviderRuntimeEvent } from '../../../shared/agent'
import type { ThreadReader } from './RuntimeOperationCompiler'

export function compileTodoEvent(
  event: Extract<ProviderRuntimeEvent, { type: 'todo.updated' }>,
  _readThread: ThreadReader
): OrchestrationCommand[] {
  const turnId = event.turnId ?? event.eventId
  const items = normalizeTodoItems(event.payload.items)
  if (items.length === 0) return []
  const todoList: OrchestrationTodoList = {
    id: `todo:${event.threadId}:turn:${turnId}:${event.payload.source}`,
    turnId,
    source: event.payload.source,
    title: event.payload.title,
    explanation: event.payload.explanation,
    items,
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  }
  return [
    {
      type: 'provider.todo-list.upsert',
      commandId: `provider:${event.eventId}:todo`,
      threadId: event.threadId,
      todoList,
      createdAt: event.createdAt
    }
  ]
}

export function compileRuntimeInfoEvent(
  event: Extract<ProviderRuntimeEvent, { type: 'runtime.info' | 'runtime.error' | 'runtime.warning' }>,
  _readThread: ThreadReader
): OrchestrationCommand[] {
  switch (event.type) {
    case 'runtime.info':
      return [
        {
          type: 'provider.activity.upsert',
          commandId: `provider:${event.eventId}:runtime-info`,
          threadId: event.threadId,
          activity: {
            id: `runtime-info:${event.eventId}`,
            kind: 'task.progress',
            tone: 'info',
            summary: event.payload.message ?? event.payload.kind ?? 'Info',
            payload: { detail: event.payload.detail, kind: event.payload.kind },
            turnId: event.turnId ?? null,
            createdAt: event.createdAt
          },
          createdAt: event.createdAt
        }
      ]

    case 'runtime.error':
    case 'runtime.warning':
      return [
        {
          type: 'provider.activity.upsert',
          commandId: `provider:${event.eventId}:runtime-diagnostic`,
          threadId: event.threadId,
          activity: {
            id: `${event.type}:${event.eventId}`,
            kind: event.type === 'runtime.error' ? 'runtime.error' : 'runtime.warning',
            tone: event.type === 'runtime.error' ? 'error' : 'info',
            summary: event.payload.message,
            payload: { detail: event.payload.detail },
            turnId: event.turnId ?? null,
            createdAt: event.createdAt
          },
          createdAt: event.createdAt
        }
      ]

    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

function normalizeTodoItems(
  items: Array<{ id?: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>
): OrchestrationTodo[] {
  return items
    .map((item, index) => {
      const text = item.text.trim()
      if (!text) return null
      return {
        id: item.id?.trim() || `todo-item:${index}:${text.toLowerCase()}`,
        text,
        status: item.status,
        order: index
      }
    })
    .filter((item): item is OrchestrationTodo => item !== null)
}

/**
 * RuntimeToolCompiler
 *
 * Compiles `item.started`, `item.updated`, `item.completed` `ProviderRuntimeEvent`s
 * (tool calls, file edits, file reads, reasoning, assistant items, plan items)
 * into `OrchestrationCommand`s.
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  OrchestrationCommand,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent
} from '../../../shared/agent'
import { mergeFileEditChanges, readCanonicalFileEditChanges } from '../../../shared/fileEditChanges'
import { mergeFileReadPreview, readCanonicalFileReadPreview } from '../../../shared/fileReadPreview'
import type { ThreadReader } from './RuntimeOperationCompiler'

export type CompletedTurnToolStatusLookup = (
  threadId: string,
  turnId: string | null | undefined
) => 'completed' | 'failed' | undefined
export function compileItemEvent(
  event: Extract<ProviderRuntimeEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>,
  readThread: ThreadReader,
  completedTurnLookup?: CompletedTurnToolStatusLookup
): OrchestrationCommand[] {
  if (event.payload.itemType === 'user_message') return []

  if (event.payload.itemType === 'reasoning') {
    return compileThinkingItem(event, readThread, completedTurnLookup)
  }

  if (event.payload.itemType === 'assistant_message') {
    return compileAssistantItem(event)
  }

  if (event.payload.itemType === 'plan') {
    return compilePlanItem(event)
  }

  return compileToolItem(event, readThread, completedTurnLookup)
}

function compileThinkingItem(
  event: Extract<ProviderRuntimeEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>,
  readThread: ThreadReader,
  completedTurnLookup?: CompletedTurnToolStatusLookup
): OrchestrationCommand[] {
  const id = `thinking:${event.itemId ?? event.turnId ?? event.eventId}`
  const thread = readThread(event.threadId)
  const existing = thread.activities.find((a) => a.id === id)
  const existingStatus = readPayloadStr(existing?.payload, 'status')
  const preservedText = readPayloadStr(existing?.payload, 'reasoningText')
  const completedTurnStatus = completedTurnLookup?.(event.threadId, event.turnId)
  const completed =
    existing?.resolved === true ||
    isTerminalStatus(existingStatus) ||
    completedTurnStatus !== undefined ||
    event.type === 'item.completed' ||
    event.payload.status === 'completed'

  return [
    {
      type: 'provider.activity.upsert',
      commandId: `provider:${event.eventId}:thinking`,
      threadId: event.threadId,
      activity: {
        id,
        kind: completed
          ? 'task.completed'
          : event.type === 'item.started'
            ? 'task.started'
            : 'task.progress',
        tone: 'thinking',
        summary: 'Thinking',
        payload: {
          itemType: event.payload.itemType,
          status: completed ? 'completed' : (event.payload.status ?? 'inProgress'),
          data: event.payload.data,
          ...(preservedText !== undefined ? { reasoningText: preservedText } : {})
        },
        turnId: event.turnId ?? null,
        resolved: completed,
        createdAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

function compileAssistantItem(
  event: Extract<ProviderRuntimeEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>
): OrchestrationCommand[] {
  const text = readNestedStr(event.payload.data, 'text', 'content', 'message', 'markdown')
  if (!text) return []
  const messageId = `assistant:${event.itemId ?? event.turnId ?? event.eventId}`
  return [
    {
      type: 'provider.message.upsert',
      commandId: `provider:${event.eventId}:assistant-item`,
      threadId: event.threadId,
      message: {
        id: messageId,
        role: 'assistant',
        text,
        turnId: event.turnId ?? null,
        streaming: event.type !== 'item.completed',
        createdAt: event.createdAt,
        updatedAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

function compilePlanItem(
  event: Extract<ProviderRuntimeEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>
): OrchestrationCommand[] {
  if (event.type !== 'item.completed') return []
  const raw =
    readNestedStr(event.payload.data, 'item', 'text') ??
    readNestedStr(event.payload.data, 'text')
  if (!raw) return []
  const text = raw
    .trim()
    .replace(/^<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>$/i, '$1')
    .trim()
  if (!text) return []
  const turnId = event.turnId ?? event.eventId
  return [
    {
      type: 'provider.proposed-plan.upsert',
      commandId: `provider:${event.eventId}:plan-item`,
      threadId: event.threadId,
      proposedPlan: {
        id: `plan:${event.threadId}:turn:${turnId}`,
        turnId,
        text,
        status: 'proposed',
        createdAt: event.createdAt,
        updatedAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

function compileToolItem(
  event: Extract<ProviderRuntimeEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>,
  readThread: ThreadReader,
  completedTurnLookup?: CompletedTurnToolStatusLookup
): OrchestrationCommand[] {
  const id = `tool:${event.itemId ?? event.eventId}`
  const thread = readThread(event.threadId)
  const existing = thread.activities.find((a) => a.id === id)
  const existingStatus = readPayloadStr(existing?.payload, 'status')
  const completedTurnStatus = completedTurnLookup?.(event.threadId, event.turnId)
  const nextStatus = nextToolStatus(existingStatus, completedTurnStatus ?? event.payload.status)
  const kind: OrchestrationThreadActivity['kind'] =
    existing?.kind === 'tool.completed' || isTerminalStatus(nextStatus)
      ? 'tool.completed'
      : event.type === 'item.started'
        ? 'tool.started'
        : 'tool.updated'

  const mergedFileEdit = mergeFileEditChanges(
    (() => {
      const inc = readCanonicalFileEditChanges(event.payload)
      return inc.length > 0 ? inc : undefined
    })(),
    (() => {
      const prev = readCanonicalFileEditChanges(existing?.payload)
      return prev.length > 0 ? prev : undefined
    })()
  )
  const mergedReadPreview = mergeFileReadPreview(
    readCanonicalFileReadPreview(event.payload),
    readCanonicalFileReadPreview(existing?.payload)
  )

  const toolPayload: Record<string, unknown> = {
    ...existing?.payload,
    itemType: event.payload.itemType ?? readPayloadStr(existing?.payload, 'itemType'),
    status: nextStatus,
    title: event.payload.title ?? readPayloadStr(existing?.payload, 'title'),
    detail: event.payload.detail ?? readPayloadStr(existing?.payload, 'detail'),
    data: event.payload.data ?? existing?.payload?.data
  }
  if (mergedFileEdit && mergedFileEdit.length > 0) {
    toolPayload.fileEditChanges = mergedFileEdit
  }
  if (mergedReadPreview) {
    toolPayload.fileReadPreview = mergedReadPreview
  }

  return [
    {
      type: 'provider.activity.upsert',
      commandId: `provider:${event.eventId}:tool-item`,
      threadId: event.threadId,
      activity: {
        id,
        kind,
        tone: toneForItem(event.payload.itemType),
        summary:
          event.payload.title ??
          existing?.summary ??
          event.payload.detail ??
          titleForItem(event.payload.itemType),
        payload: toolPayload,
        turnId: event.turnId ?? null,
        createdAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPayloadStr(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = payload?.[key]
  return typeof v === 'string' ? v : undefined
}

function readNestedStr(value: unknown, ...keys: string[]): string | undefined {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string') return candidate
  }
  const item = record.item
  if (typeof item === 'object' && item !== null) return readNestedStr(item, ...keys)
  return undefined
}

function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'success' ||
    status === 'failed' ||
    status === 'declined'
  )
}

function nextToolStatus(
  existingStatus: string | undefined,
  incomingStatus: string | undefined
): string {
  if (isTerminalStatus(existingStatus)) return existingStatus ?? 'completed'
  return incomingStatus ?? existingStatus ?? 'inProgress'
}

function toneForItem(
  itemType: CanonicalItemType
): OrchestrationThreadActivity['tone'] {
  if (itemType === 'reasoning') return 'thinking'
  if (itemType === 'error') return 'error'
  return 'tool'
}

function titleForItem(itemType: CanonicalItemType): string {
  return itemType.replaceAll('_', ' ')
}

export function itemTypeForRequest(requestType: CanonicalRequestType): CanonicalItemType {
  switch (requestType) {
    case 'command_execution_approval':
    case 'exec_command_approval':
      return 'command_execution'
    case 'file_read_approval':
      return 'file_read'
    case 'file_change_approval':
    case 'apply_patch_approval':
      return 'file_change'
    case 'dynamic_tool_call':
      return 'dynamic_tool_call'
    case 'tool_user_input':
    case 'auth_tokens_refresh':
    case 'unknown':
      return 'dynamic_tool_call'
    default: {
      const _exhaustive: never = requestType
      return _exhaustive
    }
  }
}

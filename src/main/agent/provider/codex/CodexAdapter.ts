import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeEventBase,
  ProviderRuntimeEvent,
  ProviderSession,
  RuntimeContentStreamKind
} from '../../../../shared/agent'
import { CodexAppServerManager, type ProviderEvent } from './CodexAppServerManager'
import { ProviderEventBus } from '../types'
import type { ProviderAdapter, SendTurnInput, StartSessionInput } from '../types'

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const
  private readonly bus = new ProviderEventBus()

  constructor(private readonly manager = new CodexAppServerManager()) {
    this.manager.onEvent((event) => this.handleRawEvent(event))
  }

  async getSummary(): Promise<{
    id: 'codex'
    name: string
    status: 'available' | 'missing' | 'error'
    detail?: string
  }> {
    const summary = await this.manager.getSummary()
    return { id: 'codex', name: 'Codex', ...summary }
  }

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    return this.manager.startSession(input)
  }

  async sendTurn(input: SendTurnInput): Promise<{ turnId: string; resumeCursor?: unknown }> {
    return this.manager.sendTurn(input)
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.manager.interruptTurn(input)
  }

  async respondToApproval(input: {
    threadId: string
    requestId: string
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  }): Promise<void> {
    await this.manager.respondToApproval(input)
  }

  async respondToUserInput(input: {
    threadId: string
    requestId: string
    answers: Record<string, unknown>
  }): Promise<void> {
    await this.manager.respondToUserInput(input)
  }

  async stopSession(input: { threadId: string }): Promise<void> {
    await this.manager.stopSession(input)
  }

  async readThread(input: { threadId: string }): Promise<unknown> {
    return this.manager.readThread(input)
  }

  streamEvents(listener: (event: ProviderRuntimeEvent) => void): () => void {
    return this.bus.subscribe(listener)
  }

  private handleRawEvent(event: ProviderEvent): void {
    const runtimeEvent = mapProviderEvent(event)
    if (runtimeEvent) {
      logEvent('codex/runtime', runtimeEvent)
      this.bus.emit(runtimeEvent)
    } else {
      logEvent('codex/dropped', event)
    }
  }
}

export function mapProviderEvent(event: ProviderEvent): ProviderRuntimeEvent | null {
  const payload = readRecord(event.payload)
  const itemPayload = readBestItemPayload(payload)
  const base = {
    eventId: event.id,
    provider: 'codex' as const,
    threadId: event.threadId,
    turnId: event.turnId ?? readString(payload, 'turnId'),
    itemId: event.itemId ?? readProviderItemId(payload, itemPayload),
    requestId: event.requestId,
    createdAt: event.createdAt,
    raw: {
      source:
        event.kind === 'request'
          ? ('codex.app-server.request' as const)
          : ('codex.app-server.notification' as const),
      method: event.method,
      payload: event.payload
    }
  }

  if (event.kind === 'error') {
    return {
      ...base,
      type: 'runtime.error',
      payload: { message: event.message ?? 'Codex error', detail: event.payload }
    }
  }

  switch (event.method) {
    case 'session/connecting':
      return { ...base, type: 'session.state.changed', payload: { state: 'starting' } }
    case 'session/ready':
      return { ...base, type: 'session.state.changed', payload: { state: 'ready' } }
    case 'session/exited':
    case 'session/closed':
      return { ...base, type: 'session.state.changed', payload: { state: 'stopped' } }
    case 'thread/started':
      return {
        ...base,
        type: 'thread.started',
        payload: {
          providerThreadId: readString(event.payload, 'providerThreadId') ?? event.threadId
        }
      }
    case 'turn/started':
      return {
        ...base,
        type: 'turn.started',
        payload: {
          model: readString(event.payload, 'model'),
          effort: readString(event.payload, 'effort')
        }
      }
    case 'turn/completed':
      return {
        ...base,
        type: 'turn.completed',
        payload: {
          state: readCompletionState(event.payload),
          stopReason: readString(event.payload, 'stopReason'),
          errorMessage: readString(event.payload, 'errorMessage'),
          usage: readRecord(event.payload).usage
        }
      }
    case 'turn/aborted':
      return {
        ...base,
        type: 'turn.completed',
        payload: { state: 'interrupted', stopReason: 'aborted' }
      }
    case 'item/agentMessage/delta':
      return contentDelta(base, 'assistant_text', event)
    case 'item/reasoning/textDelta':
    case 'codex/event/reasoning_content_delta':
      return contentDelta(base, 'reasoning_text', event)
    case 'item/reasoning/summaryTextDelta':
      return contentDelta(base, 'reasoning_summary_text', event)
    case 'turn/plan/updated':
      return contentDelta(base, 'plan_text', event)
    case 'item/commandExecution/outputDelta':
      return contentDelta(base, 'command_output', event)
    case 'item/fileChange/outputDelta':
      return contentDelta(base, 'file_change_output', event)
    case 'item/started':
      return itemEvent(base, 'item.started', event)
    case 'item/updated':
      return itemEvent(base, 'item.updated', event)
    case 'item/completed':
      return itemEvent(base, 'item.completed', event)
    case 'item/reasoning/summaryPartAdded':
    case 'item/commandExecution/terminalInteraction':
    case 'item/mcpToolCall/progress':
      return itemEvent(base, 'item.updated', event)
    case 'item/commandExecution/requestApproval':
    case 'item/fileRead/requestApproval':
    case 'item/fileChange/requestApproval':
      return {
        ...base,
        type: 'request.opened',
        payload: {
          requestType: requestTypeForMethod(event.method),
          detail: approvalDetail(event),
          args: event.payload
        }
      }
    case 'item/requestApproval/decision':
      return {
        ...base,
        type: 'request.resolved',
        payload: {
          requestType: 'unknown',
          decision: readString(event.payload, 'decision'),
          resolution: event.payload
        }
      }
    case 'item/tool/requestUserInput':
      return {
        ...base,
        type: 'user-input.requested',
        payload: { questions: readQuestions(event.payload) }
      }
    case 'item/tool/requestUserInput/answered':
      return {
        ...base,
        type: 'user-input.resolved',
        payload: { answers: readRecord(readRecord(event.payload).answers ?? event.payload) }
      }
    default:
      if (event.kind === 'request') {
        return {
          ...base,
          type: 'request.opened',
          payload: { requestType: 'unknown', detail: event.method, args: event.payload }
        }
      }
      return null
  }
}

function contentDelta(
  base: RuntimeEventBase,
  streamKind: RuntimeContentStreamKind,
  event: ProviderEvent
): ProviderRuntimeEvent {
  return {
    ...base,
    type: 'content.delta',
    payload: {
      streamKind,
      delta:
        event.textDelta ??
        readString(event.payload, 'delta') ??
        readString(event.payload, 'textDelta') ??
        readString(event.payload, 'text') ??
        ''
    }
  }
}

function itemEvent(
  base: RuntimeEventBase,
  type: 'item.started' | 'item.updated' | 'item.completed',
  event: ProviderEvent
): ProviderRuntimeEvent | null {
  const payload = readRecord(event.payload)
  const itemPayload = readBestItemPayload(payload)
  const itemType = itemTypeForProvider(
    readString(itemPayload, 'itemType') ??
      readString(itemPayload, 'type') ??
      readString(payload, 'itemType') ??
      readString(payload, 'type') ??
      event.method
  )
  if (itemType === 'user_message') return null
  if (itemType === 'assistant_message') {
    return assistantItemEvent(base, type, payload, itemPayload)
  }
  const title = readToolTitle(itemPayload) ?? readToolTitle(payload)
  const detail = readToolDetail(itemPayload) ?? readToolDetail(payload)
  return {
    ...base,
    type,
    payload: {
      itemType,
      status: readItemStatus(itemPayload, type),
      title,
      detail,
      data: {
        ...payload,
        normalized: {
          itemType,
          title,
          detail
        }
      }
    }
  }
}

function assistantItemEvent(
  base: RuntimeEventBase,
  type: 'item.started' | 'item.updated' | 'item.completed',
  payload: Record<string, unknown>,
  itemPayload: Record<string, unknown>
): ProviderRuntimeEvent | null {
  const text = readTextContent(itemPayload) ?? readTextContent(payload)
  if (!text || type === 'item.started') return null
  return {
    ...base,
    type: 'content.delta',
    payload: {
      streamKind: 'assistant_text',
      delta: text
    }
  }
}

function readProviderItemId(
  payload: Record<string, unknown>,
  itemPayload: Record<string, unknown>
): string | undefined {
  return (
    readString(payload, 'itemId') ??
    readString(payload, 'item_id') ??
    readString(itemPayload, 'id') ??
    readString(itemPayload, 'itemId') ??
    readString(itemPayload, 'callId') ??
    readString(itemPayload, 'call_id')
  )
}

function requestTypeForMethod(method: string): CanonicalRequestType {
  if (method.includes('commandExecution')) return 'command_execution_approval'
  if (method.includes('fileRead')) return 'file_read_approval'
  if (method.includes('fileChange')) return 'file_change_approval'
  return 'unknown'
}

const ITEM_TYPE_RULES: Array<{ includes: string[]; type: CanonicalItemType }> = [
  { includes: ['usermessage', 'user_message'], type: 'user_message' },
  {
    includes: ['agentmessage', 'assistantmessage', 'assistant_message'],
    type: 'assistant_message'
  },
  { includes: ['command'], type: 'command_execution' },
  { includes: ['file', 'patch', 'edit'], type: 'file_change' },
  { includes: ['mcp'], type: 'mcp_tool_call' },
  { includes: ['dynamic'], type: 'dynamic_tool_call' },
  { includes: ['web'], type: 'web_search' },
  { includes: ['assistant', 'agent'], type: 'assistant_message' },
  { includes: ['reason'], type: 'reasoning' },
  { includes: ['plan'], type: 'plan' },
  { includes: ['error'], type: 'error' }
]

function itemTypeForProvider(value: string): CanonicalItemType {
  const normalized = value.toLowerCase()
  return (
    ITEM_TYPE_RULES.find((rule) => rule.includes.some((snippet) => normalized.includes(snippet)))
      ?.type ?? 'unknown'
  )
}

function approvalDetail(event: ProviderEvent): string {
  const payload = readRecord(event.payload)
  const itemPayload = readBestItemPayload(payload)
  return (
    readToolDetail(itemPayload) ??
    readToolTitle(itemPayload) ??
    readString(payload, 'command') ??
    readString(payload, 'path') ??
    readString(payload, 'summary') ??
    event.method
  )
}

function readBestItemPayload(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['item', 'toolCall', 'tool_call', 'call', 'command', 'fileChange']) {
    const candidate = readRecord(payload[key])
    if (Object.keys(candidate).length > 0) return candidate
  }
  return payload
}

function readToolTitle(payload: Record<string, unknown>): string | undefined {
  return (
    readString(payload, 'title') ??
    readString(payload, 'toolName') ??
    readString(payload, 'tool_name') ??
    readString(payload, 'name') ??
    readString(payload, 'command') ??
    readString(payload, 'path')
  )
}

function readToolDetail(payload: Record<string, unknown>): string | undefined {
  return (
    readString(payload, 'detail') ??
    readString(payload, 'summary') ??
    readString(payload, 'description') ??
    readString(payload, 'path') ??
    readString(payload, 'command')
  )
}

function readTextContent(payload: Record<string, unknown>): string | undefined {
  return (
    readString(payload, 'text') ??
    readString(payload, 'content') ??
    readString(payload, 'message') ??
    readString(payload, 'markdown')
  )
}

function readItemStatus(
  payload: Record<string, unknown>,
  eventType: 'item.started' | 'item.updated' | 'item.completed'
): 'inProgress' | 'completed' | 'failed' | 'declined' {
  const status = readString(payload, 'status') ?? readString(payload, 'state')
  if (status === 'failed' || status === 'declined') return status
  if (status === 'completed' || eventType === 'item.completed') return 'completed'
  return 'inProgress'
}

function readCompletionState(value: unknown): 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  const state = readString(value, 'state') ?? readString(value, 'status')
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return state
  return 'completed'
}

function readQuestions(value: unknown): Array<{
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }>
}> {
  const questions = readRecord(value).questions
  return Array.isArray(questions)
    ? questions
        .map((question, index) => {
          const record = readRecord(question)
          const id = readString(record, 'id') ?? `question-${index + 1}`
          const text =
            readString(record, 'question') ?? readString(record, 'label') ?? 'Provide input'
          const header = readString(record, 'header')
          const rawOptions = record.options
          const options = Array.isArray(rawOptions)
            ? rawOptions.map((option) => ({
                label: readString(option, 'label') ?? String(option),
                description: readString(option, 'description')
              }))
            : undefined
          return { id, header, question: text, options }
        })
        .filter((question) => question.question.length > 0)
    : []
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown, key: string): string | undefined {
  const candidate = readRecord(value)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function logEvent(label: string, payload: unknown): void {
  console.log(`[gencode:${label}]`, payload)
}

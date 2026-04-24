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
import type { ModelInfo } from './codex-api-types'

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const
  readonly supportsStructuredOutput = true
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

  async generateThreadTitle(input: {
    cwd?: string
    input: string
    model?: string
    useStructuredOutput?: boolean
  }): Promise<string | null> {
    return this.manager.generateThreadTitle(input)
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.manager.interruptTurn(input)
  }

  async rollbackConversation(input: { threadId: string; numTurns: number }): Promise<void> {
    await this.manager.rollbackConversation(input)
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

  async listModels(): Promise<ModelInfo[]> {
    return this.manager.listModels()
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

  if (event.kind === 'error' || event.kind === 'warning') {
    return {
      ...base,
      type: event.kind === 'error' ? 'runtime.error' : 'runtime.warning',
      payload: {
        message: event.message ?? (event.kind === 'error' ? 'Codex error' : 'Codex warning'),
        detail: event.payload
      }
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
    case 'turn/started': {
      const turnRecord = readRecord(readRecord(event.payload)['turn'])
      return {
        ...base,
        // Codex: params.turn.id is the canonical turn id
        turnId: base.turnId ?? readString(turnRecord, 'id'),
        type: 'turn.started',
        payload: {
          model: readString(event.payload, 'model') ?? readString(turnRecord, 'model'),
          effort: readString(event.payload, 'effort') ?? readString(turnRecord, 'effort')
        }
      }
    }
    case 'turn/completed': {
      const turnRecord = readRecord(readRecord(event.payload)['turn'])
      return {
        ...base,
        turnId: base.turnId ?? readString(turnRecord, 'id'),
        type: 'turn.completed',
        payload: {
          state: readCompletionState(event.payload),
          stopReason: readString(event.payload, 'stopReason'),
          errorMessage:
            readString(event.payload, 'errorMessage') ??
            readString(readRecord(turnRecord['error']), 'message'),
          usage: readRecord(event.payload).usage
        }
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
    case 'serverRequest/resolved':
      return {
        ...base,
        type: 'request.resolved',
        payload: {
          requestType: 'unknown',
          decision: 'resolved',
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

const ITEM_TYPE_EXACT: Record<string, CanonicalItemType> = {
  userMessage: 'user_message',
  user_message: 'user_message',
  agentMessage: 'assistant_message',
  assistantMessage: 'assistant_message',
  assistant_message: 'assistant_message',
  commandExecution: 'command_execution',
  command_execution: 'command_execution',
  fileChange: 'file_change',
  file_change: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  mcp_tool_call: 'mcp_tool_call',
  dynamicToolCall: 'dynamic_tool_call',
  dynamic_tool_call: 'dynamic_tool_call',
  collabAgentToolCall: 'collab_agent_tool_call',
  collab_agent_tool_call: 'collab_agent_tool_call',
  webSearch: 'web_search',
  web_search: 'web_search',
  imageView: 'image_view',
  image_view: 'image_view',
  enteredReviewMode: 'review_entered',
  exitedReviewMode: 'review_exited',
  contextCompaction: 'context_compaction',
  context_compaction: 'context_compaction',
  reasoning: 'reasoning',
  plan: 'plan',
  error: 'error'
}

const ITEM_TYPE_RULES: Array<{ includes: string[]; type: CanonicalItemType }> = [
  { includes: ['usermessage', 'user_message'], type: 'user_message' },
  {
    includes: ['agentmessage', 'assistantmessage', 'assistant_message'],
    type: 'assistant_message'
  },
  { includes: ['commandexecution', 'command_execution', 'command'], type: 'command_execution' },
  { includes: ['filechange', 'file_change', 'file', 'patch', 'edit'], type: 'file_change' },
  { includes: ['mcp'], type: 'mcp_tool_call' },
  { includes: ['dynamic'], type: 'dynamic_tool_call' },
  { includes: ['collab'], type: 'collab_agent_tool_call' },
  { includes: ['websearch', 'web_search', 'web'], type: 'web_search' },
  { includes: ['imageview', 'image_view', 'image'], type: 'image_view' },
  { includes: ['enteredreview', 'entered_review'], type: 'review_entered' },
  { includes: ['exitedreview', 'exited_review'], type: 'review_exited' },
  { includes: ['contextcompaction', 'context_compaction', 'compact'], type: 'context_compaction' },
  { includes: ['assistant', 'agent'], type: 'assistant_message' },
  { includes: ['reason'], type: 'reasoning' },
  { includes: ['plan'], type: 'plan' },
  { includes: ['error'], type: 'error' }
]

function itemTypeForProvider(value: string): CanonicalItemType {
  // Exact match first (covers Codex camelCase type names)
  const exact = ITEM_TYPE_EXACT[value]
  if (exact) return exact
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
  // commandExecution: command is the full shell string
  // mcpToolCall: server + tool
  // webSearch: query
  // fileChange: first changed path
  // dynamicToolCall: tool name
  const type = readString(payload, 'type')
  if (type === 'mcpToolCall') {
    const server = readString(payload, 'server')
    const tool = readString(payload, 'tool')
    if (server && tool) return `${server}: ${tool}`
    return tool ?? server
  }
  if (type === 'webSearch') return readString(payload, 'query')
  if (type === 'fileChange') {
    const changes = payload['changes']
    if (Array.isArray(changes) && changes.length > 0) {
      const first = readRecord(changes[0])
      const path = readString(first, 'path')
      if (path) return changes.length > 1 ? `${path} +${changes.length - 1}` : path
    }
  }
  if (type === 'dynamicToolCall') return readString(payload, 'tool')
  if (type === 'imageView') return readString(payload, 'path')
  return (
    readString(payload, 'title') ??
    readString(payload, 'tool') ??
    readString(payload, 'toolName') ??
    readString(payload, 'tool_name') ??
    readString(payload, 'name') ??
    readString(payload, 'query') ??
    readString(payload, 'command') ??
    readString(payload, 'path')
  )
}

function readToolDetail(payload: Record<string, unknown>): string | undefined {
  const type = readString(payload, 'type')
  if (type === 'commandExecution') {
    const cwd = readString(payload, 'cwd')
    const output = readString(payload, 'aggregatedOutput')
    if (output) return output
    return cwd
  }
  if (type === 'mcpToolCall') {
    const args = payload['arguments']
    if (args && typeof args === 'object') {
      try {
        return JSON.stringify(args)
      } catch {
        // ignore
      }
    }
  }
  return (
    readString(payload, 'detail') ??
    readString(payload, 'summary') ??
    readString(payload, 'description') ??
    readString(payload, 'cwd') ??
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
  if (status === 'completed' || status === 'success' || eventType === 'item.completed')
    return 'completed'
  if (status === 'interrupted') return 'failed'
  return 'inProgress'
}

function readCompletionState(value: unknown): 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  // Codex turn/completed params: { threadId, turn: { id, status, ... } }
  const record = readRecord(value)
  const turnRecord = readRecord(record['turn'])
  const state =
    readString(turnRecord, 'status') ?? readString(record, 'state') ?? readString(record, 'status')
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
  console.log(`[cobel:${label}]`, payload)
}

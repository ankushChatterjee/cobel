import type {
  CanonicalItemType,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
  RuntimeContentStreamKind,
  RuntimeSessionState
} from '../../../shared/agent'
import { OrchestrationEngine } from './OrchestrationEngine'

const MAX_BUFFERED_ASSISTANT_CHARS = 24_000

interface AssistantSegmentState {
  baseKey: string
  nextSegmentIndex: number
  activeMessageId: string | null
  buffer: string
}

interface PlanBufferState {
  text: string
  createdAt: string
}

export class ProviderRuntimeIngestion {
  private readonly queue: ProviderRuntimeEvent[] = []
  private readonly assistantSegments = new Map<string, AssistantSegmentState>()
  private readonly planBuffers = new Map<string, PlanBufferState>()
  private draining = false
  private drainPromise: Promise<void> = Promise.resolve()

  constructor(private readonly engine: OrchestrationEngine) {}

  enqueue(event: ProviderRuntimeEvent): void {
    logEvent('runtime/enqueue', event)
    this.queue.push(event)
    if (!this.draining) {
      this.drainPromise = this.drainInternal()
    }
  }

  async drain(): Promise<void> {
    await this.drainPromise
  }

  private async drainInternal(): Promise<void> {
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()
        if (event) this.ingest(event)
      }
    } finally {
      this.draining = false
    }
  }

  private ingest(event: ProviderRuntimeEvent): void {
    logEvent('runtime/ingest', event)
    this.engine.ensureThread({ threadId: event.threadId })

    switch (event.type) {
      case 'session.state.changed':
        this.engine.setSession({
          threadId: event.threadId,
          status: mapSessionStatus(event.payload.state),
          providerName: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          activeTurnId:
            event.payload.state === 'running'
              ? (event.turnId ??
                this.engine.getThread(event.threadId).session?.activeTurnId ??
                null)
              : null,
          lastError:
            event.payload.state === 'error' ? (event.payload.reason ?? 'Provider error') : null,
          createdAt: event.createdAt
        })
        return

      case 'turn.started':
        this.engine.setLatestTurn(event.threadId, {
          id: event.turnId ?? event.eventId,
          status: 'running',
          startedAt: event.createdAt,
          completedAt: null
        })
        this.engine.setSession({
          threadId: event.threadId,
          status: 'running',
          providerName: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          activeTurnId: event.turnId ?? null,
          lastError: null,
          createdAt: event.createdAt
        })
        return

      case 'turn.completed':
        this.flushAssistant(event, { closeSegment: true })
        this.finalizePlan(event)
        this.closeActiveTurn(event)
        return

      case 'content.delta':
        this.ingestContentDelta(event)
        return

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.ingestItem(event)
        if (event.type === 'item.completed' && event.payload.itemType !== 'reasoning')
          this.flushAssistant(event, { closeSegment: true })
        return

      case 'request.opened':
        this.flushAssistant(event, { closeSegment: true })
        this.engine.upsertActivity(
          {
            id: `approval:${event.requestId ?? event.eventId}`,
            kind: 'approval.requested',
            tone: 'approval',
            summary: event.payload.detail ?? titleForRequest(event.payload.requestType),
            payload: { requestType: event.payload.requestType, args: event.payload.args },
            turnId: event.turnId ?? null,
            resolved: false,
            createdAt: event.createdAt
          },
          event.threadId
        )
        this.engine.setSession({
          threadId: event.threadId,
          status: 'ready',
          providerName: event.provider,
          runtimeMode:
            this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
          activeTurnId: event.turnId ?? null,
          lastError: null,
          createdAt: event.createdAt
        })
        return

      case 'request.resolved':
        this.engine.upsertActivity(
          {
            id: `approval:${event.requestId ?? event.eventId}`,
            kind: 'approval.resolved',
            tone: 'info',
            summary: `Approval ${event.payload.decision ?? 'resolved'}`,
            payload: {
              requestType: event.payload.requestType,
              decision: event.payload.decision,
              resolution: event.payload.resolution
            },
            turnId: event.turnId ?? null,
            resolved: true,
            createdAt: event.createdAt
          },
          event.threadId
        )
        return

      case 'user-input.requested':
        this.flushAssistant(event, { closeSegment: true })
        this.engine.upsertActivity(
          {
            id: `user-input:${event.requestId ?? event.eventId}`,
            kind: 'user-input.requested',
            tone: 'approval',
            summary: event.payload.questions[0]?.question ?? 'Codex needs input',
            payload: { questions: event.payload.questions },
            turnId: event.turnId ?? null,
            resolved: false,
            createdAt: event.createdAt
          },
          event.threadId
        )
        return

      case 'user-input.resolved':
        this.engine.upsertActivity(
          {
            id: `user-input:${event.requestId ?? event.eventId}`,
            kind: 'user-input.resolved',
            tone: 'info',
            summary: 'User input submitted',
            payload: { answers: event.payload.answers },
            turnId: event.turnId ?? null,
            resolved: true,
            createdAt: event.createdAt
          },
          event.threadId
        )
        return

      case 'runtime.error':
      case 'runtime.warning':
        this.engine.upsertActivity(
          {
            id: `${event.type}:${event.eventId}`,
            kind: event.type === 'runtime.error' ? 'runtime.error' : 'runtime.warning',
            tone: event.type === 'runtime.error' ? 'error' : 'info',
            summary: event.payload.message,
            payload: { detail: event.payload.detail },
            turnId: event.turnId ?? null,
            createdAt: event.createdAt
          },
          event.threadId
        )
        if (event.type === 'runtime.error') {
          this.engine.setSession({
            threadId: event.threadId,
            status: 'error',
            providerName: event.provider,
            runtimeMode:
              this.engine.getThread(event.threadId).session?.runtimeMode ?? 'auto-accept-edits',
            activeTurnId: null,
            lastError: event.payload.message,
            createdAt: event.createdAt
          })
        }
        return

      case 'thread.started':
        return
    }
  }

  private ingestContentDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    if (event.payload.streamKind === 'assistant_text') {
      const state = this.getAssistantState(event)
      state.buffer += event.payload.delta
      this.flushAssistant(event, { closeSegment: false })
      if (state.buffer.length >= MAX_BUFFERED_ASSISTANT_CHARS)
        this.flushAssistant(event, { closeSegment: true })
      return
    }

    if (event.payload.streamKind === 'plan_text') {
      const key = this.planKey(event.threadId, event.turnId ?? event.eventId)
      const existing = this.planBuffers.get(key)
      if (existing) {
        existing.text += event.payload.delta
      } else {
        this.planBuffers.set(key, { text: event.payload.delta, createdAt: event.createdAt })
      }
      return
    }

    if (isToolOutput(event.payload.streamKind)) {
      this.appendToolOutput(event)
    }
  }

  private ingestItem(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    if (event.payload.itemType === 'user_message') return
    if (event.payload.itemType === 'assistant_message') {
      this.ingestAssistantItem(event)
      return
    }
    if (event.payload.itemType === 'reasoning') {
      this.ingestThinking(event)
      return
    }

    const kind =
      event.type === 'item.started'
        ? 'tool.started'
        : event.type === 'item.completed' || event.payload.status === 'completed'
          ? 'tool.completed'
          : 'tool.updated'
    const id = toolActivityId(event)
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    this.engine.upsertActivity(
      {
        id,
        kind,
        tone: toneForItem(event.payload.itemType),
        summary:
          event.payload.title ??
          existing?.summary ??
          event.payload.detail ??
          titleForItem(event.payload.itemType),
        payload: {
          ...existing?.payload,
          itemType: event.payload.itemType ?? readPayloadString(existing?.payload, 'itemType'),
          status: event.payload.status ?? existing?.payload?.status,
          title: event.payload.title ?? readPayloadString(existing?.payload, 'title'),
          detail: event.payload.detail ?? readPayloadString(existing?.payload, 'detail'),
          data: event.payload.data ?? existing?.payload?.data
        },
        turnId: event.turnId ?? null,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private ingestAssistantItem(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    const text = readNestedPayloadString(event.payload.data, 'text', 'content', 'message', 'markdown')
    if (!text) return
    const state = this.getAssistantState(event)
    state.buffer += text
    this.flushAssistant(event, { closeSegment: true })
  }

  private ingestThinking(
    event: Extract<
      ProviderRuntimeEvent,
      { type: 'item.started' | 'item.updated' | 'item.completed' }
    >
  ): void {
    const id = `thinking:${event.itemId ?? event.turnId ?? event.eventId}`
    const completed = event.type === 'item.completed' || event.payload.status === 'completed'
    this.engine.upsertActivity(
      {
        id,
        kind: completed ? 'task.completed' : event.type === 'item.started' ? 'task.started' : 'task.progress',
        tone: 'thinking',
        summary: 'Thinking',
        payload: {
          itemType: event.payload.itemType,
          status: completed ? 'completed' : (event.payload.status ?? 'inProgress'),
          data: event.payload.data
        },
        turnId: event.turnId ?? null,
        resolved: completed,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private appendToolOutput(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>
  ): void {
    const id = toolActivityId(event)
    const existing = this.engine
      .getThread(event.threadId)
      .activities.find((activity) => activity.id === id)
    const output = `${readPayloadString(existing?.payload, 'output') ?? ''}${event.payload.delta}`
    this.engine.upsertActivity(
      {
        id,
        kind: 'tool.updated',
        tone: 'tool',
        summary: existing?.summary ?? 'Tool output',
        payload: {
          ...existing?.payload,
          itemType: readPayloadString(existing?.payload, 'itemType') ?? 'unknown',
          status: existing?.payload?.status ?? 'inProgress',
          output,
          streamKind: event.payload.streamKind
        },
        turnId: event.turnId ?? existing?.turnId ?? null,
        createdAt: event.createdAt
      },
      event.threadId
    )
  }

  private getAssistantState(event: ProviderRuntimeEvent): AssistantSegmentState {
    const key = `${event.threadId}:${event.itemId ?? event.turnId ?? event.eventId}`
    const existing = this.assistantSegments.get(key)
    if (existing) return existing

    const state: AssistantSegmentState = {
      baseKey: String(event.itemId ?? event.turnId ?? event.eventId),
      nextSegmentIndex: 0,
      activeMessageId: null,
      buffer: ''
    }
    this.assistantSegments.set(key, state)
    return state
  }

  private flushAssistant(
    event: ProviderRuntimeEvent,
    options: { closeSegment: boolean } = { closeSegment: true }
  ): void {
    for (const [key, state] of this.assistantSegments) {
      if (!key.startsWith(`${event.threadId}:`)) continue
      if (state.buffer.length === 0) {
        if (options.closeSegment && state.activeMessageId) {
          this.closeAssistantMessage(event, state.activeMessageId)
          state.activeMessageId = null
          state.nextSegmentIndex += 1
        }
        continue
      }
      const messageId =
        state.activeMessageId ?? assistantSegmentMessageId(state.baseKey, state.nextSegmentIndex)
      const existing = this.engine
        .getThread(event.threadId)
        .messages.find((message) => message.id === messageId)
      const now = event.createdAt
      const message: OrchestrationMessage = {
        id: messageId,
        role: 'assistant',
        text: `${existing?.text ?? ''}${state.buffer}`,
        turnId: event.turnId ?? existing?.turnId ?? null,
        streaming: event.type !== 'turn.completed',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      this.engine.upsertMessage(message, event.threadId)
      state.buffer = ''
      state.activeMessageId = messageId
      if (options.closeSegment) {
        state.activeMessageId = null
        state.nextSegmentIndex += 1
      }
    }
  }

  private closeAssistantMessage(event: ProviderRuntimeEvent, messageId: string): void {
    const existing = this.engine
      .getThread(event.threadId)
      .messages.find((message) => message.id === messageId)
    if (!existing || !existing.streaming) return
    this.engine.upsertMessage(
      {
        ...existing,
        streaming: event.type !== 'turn.completed',
        updatedAt: event.createdAt
      },
      event.threadId
    )
  }

  private finalizePlan(event: ProviderRuntimeEvent): void {
    const turnId = event.turnId ?? event.eventId
    const key = this.planKey(event.threadId, turnId)
    const buffer = this.planBuffers.get(key)
    if (!buffer || buffer.text.trim().length === 0) return
    const proposedPlan: OrchestrationProposedPlan = {
      id: `plan:${event.threadId}:turn:${turnId}`,
      turnId,
      text: buffer.text,
      status: 'proposed',
      createdAt: buffer.createdAt,
      updatedAt: event.createdAt
    }
    this.engine.upsertProposedPlan(proposedPlan, event.threadId)
    this.planBuffers.delete(key)
  }

  private closeActiveTurn(event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>): void {
    const thread = this.engine.getThread(event.threadId)
    const activeTurnId = thread.session?.activeTurnId
    if (activeTurnId && event.turnId && activeTurnId !== event.turnId) return

    this.engine.setLatestTurn(event.threadId, {
      id: event.turnId ?? event.eventId,
      status: event.payload.state,
      startedAt: thread.latestTurn?.startedAt ?? event.createdAt,
      completedAt: event.createdAt
    })
    this.engine.setSession({
      threadId: event.threadId,
      status:
        event.payload.state === 'completed'
          ? 'ready'
          : event.payload.state === 'interrupted'
            ? 'interrupted'
            : 'error',
      providerName: event.provider,
      runtimeMode: thread.session?.runtimeMode ?? 'auto-accept-edits',
      activeTurnId: null,
      lastError: event.payload.errorMessage ?? null,
      createdAt: event.createdAt
    })
  }

  private planKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
  }
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): string {
  return segmentIndex === 0
    ? `assistant:${baseKey}`
    : `assistant:${baseKey}:segment:${segmentIndex}`
}

function mapSessionStatus(
  state: RuntimeSessionState
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
    default:
      return 'ready'
  }
}

function isToolOutput(kind: RuntimeContentStreamKind): boolean {
  return kind === 'command_output' || kind === 'file_change_output'
}

function toolActivityId(event: Pick<ProviderRuntimeEvent, 'itemId' | 'eventId'>): string {
  return `tool:${event.itemId ?? event.eventId}`
}

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

function readNestedPayloadString(value: unknown, ...keys: string[]): string | undefined {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string') return candidate
  }
  const item = record.item
  if (typeof item === 'object' && item !== null) return readNestedPayloadString(item, ...keys)
  return undefined
}

function toneForItem(itemType: CanonicalItemType): OrchestrationThreadActivity['tone'] {
  if (itemType === 'reasoning') return 'thinking'
  if (itemType === 'error') return 'error'
  return 'tool'
}

function titleForItem(itemType: CanonicalItemType): string {
  return itemType.replaceAll('_', ' ')
}

function titleForRequest(requestType: string): string {
  return requestType.replaceAll('_', ' ')
}

function logEvent(label: string, payload: unknown): void {
  console.log(`[gencode:${label}]`, payload)
}

/**
 * RuntimeMessageCompiler
 *
 * Compiles `content.delta` `ProviderRuntimeEvent`s (assistant text, plan text,
 * reasoning text) into `OrchestrationCommand`s. Manages the per-thread assistant
 * segment buffer so that text chunks are batched before being emitted as
 * message upserts.
 *
 * The compiler is stateful (it owns the segment buffers) and is instantiated
 * once per `ProviderRuntimeIngestion` instance, not shared across threads.
 */
import { randomUUID } from 'node:crypto'
import type { OrchestrationCommand, OrchestrationMessage, ProviderRuntimeEvent } from '../../../shared/agent'
import type { ThreadReader } from './RuntimeOperationCompiler'
import type { CompletedTurnToolStatusLookup } from './RuntimeToolCompiler'

const MAX_BUFFERED_ASSISTANT_CHARS = 24_000
const MAX_BUFFERED_REASONING_TEXT_CHARS = 16_000

export interface AssistantSegmentState {
  baseKey: string
  nextSegmentIndex: number
  activeMessageId: string | null
  buffer: string
}

export interface PlanBufferState {
  text: string
  createdAt: string
}

export class RuntimeMessageCompiler {
  readonly assistantSegments = new Map<string, AssistantSegmentState>()
  readonly streamedAssistantItems = new Set<string>()
  readonly planBuffers = new Map<string, PlanBufferState>()

  compileContentDelta(
    event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>,
    readThread: ThreadReader,
    completedTurnLookup?: CompletedTurnToolStatusLookup
  ): OrchestrationCommand[] {
    return compileContentDeltaEvent(event, readThread, this, completedTurnLookup)
  }

  /**
   * Flush all buffered assistant text for a given thread, emitting upsert
   * commands for any non-empty segments. Called by `RuntimeTurnCompiler` when
   * finalizing a turn.
   */
  flushAssistantForThread(
    threadId: string,
    turnId: string | undefined,
    createdAt: string,
    streaming: boolean
  ): OrchestrationCommand[] {
    return flushAssistantSegments(threadId, turnId, createdAt, streaming, this)
  }

  finalizePlan(
    threadId: string,
    turnId: string,
    createdAt: string,
    readThread: ThreadReader,
    fallbackText?: string
  ): OrchestrationCommand[] {
    return finalizePlan(threadId, turnId, createdAt, readThread, this, fallbackText)
  }
}

// ---------------------------------------------------------------------------
// Internal implementation functions
// ---------------------------------------------------------------------------

export function compileContentDeltaEvent(
  event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>,
  readThread: ThreadReader,
  state: RuntimeMessageCompiler,
  completedTurnLookup?: CompletedTurnToolStatusLookup
): OrchestrationCommand[] {
  const commands: OrchestrationCommand[] = []
  const { streamKind, delta } = event.payload

  if (streamKind === 'assistant_text') {
    const key = assistantStateKey(event)
    const isFinal = event.raw?.method === 'item/completed'

    const seg = getOrCreateSegment(event, state)

    const dupFinalCodexSnap = isFinal && state.streamedAssistantItems.has(key)
    if (dupFinalCodexSnap) {
      const messageId = seg.activeMessageId ?? assistantSegmentMessageId(seg.baseKey, seg.nextSegmentIndex)
      const threadSnap = readThread(event.threadId)
      const prev = threadSnap.messages.find((message) => message.id === messageId)
      commands.push({
        type: 'provider.message.upsert',
        commandId: `provider:${event.eventId}:assistant-terminal-snapshot`,
        threadId: event.threadId,
        message: prev
          ? { ...prev, streaming: false, text: '', updatedAt: event.createdAt }
          : {
              id: messageId,
              role: 'assistant',
              text: seg.buffer,
              turnId: event.turnId ?? null,
              streaming: false,
              createdAt: event.createdAt,
              updatedAt: event.createdAt
            },
        createdAt: event.createdAt
      })
      seg.buffer = ''
      if (seg.activeMessageId) seg.activeMessageId = null
      seg.nextSegmentIndex += 1
      return commands
    }

    if (!isFinal) {
      state.streamedAssistantItems.add(key)
    }

    seg.buffer += delta

    const flushCmds = flushAssistantSegments(
      event.threadId,
      event.turnId,
      event.createdAt,
      !isFinal,
      state,
      isFinal
    )
    commands.push(...flushCmds)

    if (seg.buffer.length >= MAX_BUFFERED_ASSISTANT_CHARS) {
      const overflowCmds = flushAssistantSegments(
        event.threadId,
        event.turnId,
        event.createdAt,
        true,
        state,
        true
      )
      commands.push(...overflowCmds)
    }
    return commands
  }

  if (streamKind === 'plan_text') {
    const turnIdNorm = event.turnId ?? event.eventId
    const threadSnapPlan = readThread(event.threadId)
    const planId =
      threadSnapPlan.session?.activePlanId ??
      `plan:${event.threadId}:turn:${turnIdNorm}`
    const existingBuf = state.planBuffers.get(planId)
    if (existingBuf) {
      existingBuf.text += delta
    } else {
      state.planBuffers.set(planId, { text: delta, createdAt: event.createdAt })
    }
    const upsertCmds = buildStreamingPlanCommand(event, state, readThread)
    commands.push(...upsertCmds)
    return commands
  }

  if (streamKind === 'reasoning_text') {
    const completedTurnStatus = completedTurnLookup?.(event.threadId, event.turnId)
    const id = `thinking:${event.itemId ?? event.turnId ?? event.eventId}`
    const thread = readThread(event.threadId)
    const existing = thread.activities.find((a) => a.id === id)
    if (existing?.resolved === true) return commands

    const prevText = readPayloadStr(existing?.payload, 'reasoningText') ?? ''
    const merged = `${prevText}${delta}`
    const nextText =
      merged.length > MAX_BUFFERED_REASONING_TEXT_CHARS
        ? merged.slice(merged.length - MAX_BUFFERED_REASONING_TEXT_CHARS)
        : merged

    const resolvedByTurn = completedTurnStatus !== undefined
    const kind: import('../../../shared/agent').OrchestrationThreadActivity['kind'] =
      resolvedByTurn
        ? 'task.completed'
        : existing?.kind === 'task.started' || existing?.kind === 'task.progress'
          ? 'task.progress'
          : 'task.started'

    const itemType = readPayloadStr(existing?.payload, 'itemType') ?? 'reasoning'
    const basePayload =
      typeof existing?.payload === 'object' && existing.payload !== null
        ? (existing.payload as Record<string, unknown>)
        : {}

    commands.push({
      type: 'provider.activity.upsert',
      commandId: `provider:${event.eventId}:reasoning-text`,
      threadId: event.threadId,
      activity: {
        id,
        kind,
        tone: 'thinking',
        summary: 'Thinking',
        payload: {
          ...basePayload,
          itemType,
          status: resolvedByTurn ? 'completed' : 'inProgress',
          reasoningText: nextText
        },
        turnId: event.turnId ?? existing?.turnId ?? null,
        resolved: resolvedByTurn,
        createdAt: event.createdAt
      },
      createdAt: event.createdAt
    })
    return commands
  }

  // command_output / file_change_output — tool output streaming
  if (streamKind === 'command_output' || streamKind === 'file_change_output') {
    const completedTurnStatus = completedTurnLookup?.(event.threadId, event.turnId)
    const id = resolveToolOutputActivityId(event, readThread)
    const thread = readThread(event.threadId)
    const existing = thread.activities.find((a) => a.id === id)
    const output = `${readPayloadStr(existing?.payload, 'output') ?? ''}${delta}`
    const existingStatus = readPayloadStr(existing?.payload, 'status')
    const completed =
      completedTurnStatus === 'completed' ||
      existing?.kind === 'tool.completed' ||
      existingStatus === 'completed' ||
      existingStatus === 'success'
    const terminalFailed = completedTurnStatus === 'failed'
    const itemType = streamKind === 'command_output' ? 'command_execution' : 'file_change'
    commands.push({
      type: 'provider.activity.upsert',
      commandId: `provider:${event.eventId}:tool-output`,
      threadId: event.threadId,
      activity: {
        id,
        kind: terminalFailed || completed ? 'tool.completed' : 'tool.updated',
        tone: 'tool',
        summary: existing?.summary ?? (streamKind === 'command_output' ? 'terminal' : 'file changes'),
        payload: {
          ...existing?.payload,
          itemType: readPayloadStr(existing?.payload, 'itemType') ?? itemType,
          status: completed
            ? 'completed'
            : terminalFailed
              ? 'failed'
              : (existing?.payload?.status ?? 'inProgress'),
          title:
            readPayloadStr(existing?.payload, 'title') ??
            (streamKind === 'command_output' ? 'terminal' : 'file changes'),
          output,
          streamKind
        },
        turnId: event.turnId ?? existing?.turnId ?? null,
        createdAt: event.createdAt
      },
      createdAt: event.createdAt
    })
    return commands
  }

  return commands
}

function flushAssistantSegments(
  threadId: string,
  turnId: string | undefined,
  createdAt: string,
  streaming: boolean,
  state: RuntimeMessageCompiler,
  closeSegment = true
): OrchestrationCommand[] {
  const commands: OrchestrationCommand[] = []
  for (const [key, seg] of state.assistantSegments) {
    if (!key.startsWith(`${threadId}:`)) continue
    if (seg.buffer.length === 0) {
      if (closeSegment && seg.activeMessageId) {
        seg.activeMessageId = null
        seg.nextSegmentIndex += 1
      }
      continue
    }
    const messageId =
      seg.activeMessageId ?? assistantSegmentMessageId(seg.baseKey, seg.nextSegmentIndex)
    const message: OrchestrationMessage = {
      id: messageId,
      role: 'assistant',
      text: seg.buffer,
      turnId: turnId ?? null,
      streaming,
      createdAt,
      updatedAt: createdAt
    }
    commands.push({
      type: 'provider.message.upsert',
      commandId: `provider:${randomUUID()}:assistant-upsert:${messageId}`,
      threadId,
      message,
      createdAt
    })
    seg.buffer = ''
    seg.activeMessageId = messageId
    if (closeSegment) {
      seg.activeMessageId = null
      seg.nextSegmentIndex += 1
    }
  }
  return commands
}

function buildStreamingPlanCommand(
  event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>,
  state: RuntimeMessageCompiler,
  readThread: ThreadReader
): OrchestrationCommand[] {
  const turnId = event.turnId ?? event.eventId
  const threadSnapPlan = readThread(event.threadId)
  const planId =
    threadSnapPlan.session?.activePlanId ??
    `plan:${event.threadId}:turn:${turnId}`
  const buffer = state.planBuffers.get(planId)
  if (!buffer) return []
  const text = buffer.text.trim().replace(/^<proposed_plan>\s*/i, '').replace(/\s*<\/proposed_plan>$/i, '').trim()
  return [
    {
      type: 'provider.proposed-plan.upsert',
      commandId: `provider:${event.eventId}:plan-stream`,
      threadId: event.threadId,
      proposedPlan: {
        id: planId,
        turnId,
        text,
        status: 'streaming',
        createdAt: buffer.createdAt,
        updatedAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

function finalizePlan(
  threadId: string,
  turnId: string,
  createdAt: string,
  readThread: ThreadReader,
  state: RuntimeMessageCompiler,
  fallbackText?: string
): OrchestrationCommand[] {
  const threadSnap = readThread(threadId)
  const planId = threadSnap.session?.activePlanId ?? `plan:${threadId}:turn:${turnId}`
  const buffer = state.planBuffers.get(planId)
  const rawText = buffer?.text ?? fallbackText
  if (!rawText) return []
  const text = rawText
    .trim()
    .replace(/^<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>$/i, '$1')
    .trim()
  if (!text) return []
  state.planBuffers.delete(planId)
  return [
    {
      type: 'provider.proposed-plan.upsert',
      commandId: `provider:${randomUUID()}:plan-final:${planId}`,
      threadId,
      proposedPlan: {
        id: planId,
        turnId,
        text,
        status: 'proposed',
        createdAt: buffer?.createdAt ?? createdAt,
        updatedAt: createdAt
      },
      createdAt
    }
  ]
}

function getOrCreateSegment(
  event: ProviderRuntimeEvent,
  state: RuntimeMessageCompiler
): AssistantSegmentState {
  const key = assistantStateKey(event)
  const existing = state.assistantSegments.get(key)
  if (existing) return existing
  const seg: AssistantSegmentState = {
    baseKey: String(event.itemId ?? event.turnId ?? event.eventId),
    nextSegmentIndex: 0,
    activeMessageId: null,
    buffer: ''
  }
  state.assistantSegments.set(key, seg)
  return seg
}

function assistantStateKey(event: ProviderRuntimeEvent): string {
  return `${event.threadId}:${event.itemId ?? event.turnId ?? event.eventId}`
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): string {
  return segmentIndex === 0
    ? `assistant:${baseKey}`
    : `assistant:${baseKey}:segment:${segmentIndex}`
}

function resolveToolOutputActivityId(
  event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>,
  readThread: ThreadReader
): string {
  if (event.itemId) return `tool:${event.itemId}`
  const at = readThread(event.threadId).activeTurn
  if (at && at.activeItemIds.length > 0) {
    for (let i = at.activeItemIds.length - 1; i >= 0; i -= 1) {
      const slot = at.activeItemIds[i]!
      if (!slot.startsWith('approval:')) return `tool:${slot}`
    }
  }
  return `tool:${event.eventId}`
}

function readPayloadStr(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = payload?.[key]
  return typeof v === 'string' ? v : undefined
}

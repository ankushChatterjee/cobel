/**
 * ActiveTurnSurface
 *
 * Owns the deterministic derivation of the active-turn tail state
 * (`ActiveTurnProjection.phase` and `visibleIndicator`). Extracted from
 * `ProviderRuntimeIngestion` so the logic is testable in isolation and does
 * not scatter `patchActiveTurn` calls throughout the ingestion class.
 *
 * Rules (in priority order):
 *  1. Terminal phases (completed/failed/interrupted/idle/queued/finalizing) are never overridden.
 *  2. Pending approval slots → `waiting_for_input / approval`.
 *  3. Active tool slots → `tool_running / tool`.
 *  4. Unresolved reasoning thinking → `thinking / thinking`.
 *  5. Streaming assistant message → `streaming / assistant_stream`.
 *  6. Streaming plan → `streaming / plan`.
 *  7. Otherwise → `streaming / exploring` (the default "model is working" state).
 */
import type { ActiveTurnProjection, OrchestrationThread } from '../../../shared/agent'

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Re-derives the tail phase/indicator from current thread state. Returns the
 * next `ActiveTurnProjection`, or the same object reference if nothing changed.
 */
export function reconcileActiveTurnTail(
  thread: Pick<OrchestrationThread, 'activities' | 'messages' | 'proposedPlans' | 'session'>,
  base: ActiveTurnProjection,
  createdAt: string
): ActiveTurnProjection {
  const { phase } = base

  if (
    phase === 'completed' ||
    phase === 'failed' ||
    phase === 'interrupted' ||
    phase === 'idle' ||
    phase === 'finalizing' ||
    phase === 'queued'
  ) {
    return base
  }

  if (phase === 'waiting_for_input' && base.visibleIndicator === 'approval') {
    return base
  }

  if (base.turnId.startsWith('pending:')) {
    return base.visibleIndicator === 'exploring' && base.updatedAt === createdAt
      ? base
      : { ...base, visibleIndicator: 'exploring', updatedAt: createdAt }
  }

  const approvalSlots = base.activeItemIds.filter((id) => id.startsWith('approval:'))
  if (approvalSlots.length > 0) {
    return {
      ...base,
      phase: 'waiting_for_input',
      visibleIndicator: 'approval',
      updatedAt: createdAt
    }
  }

  const toolSlots = base.activeItemIds.filter((id) => !id.startsWith('approval:'))
  if (toolSlots.length > 0) {
    return { ...base, phase: 'tool_running', visibleIndicator: 'tool', updatedAt: createdAt }
  }

  if (hasUnresolvedReasoningThinking(thread, base.turnId)) {
    return { ...base, phase: 'thinking', visibleIndicator: 'thinking', updatedAt: createdAt }
  }

  if (hasStreamingAssistant(thread, base.turnId)) {
    return {
      ...base,
      phase: 'streaming',
      visibleIndicator: 'assistant_stream',
      updatedAt: createdAt
    }
  }

  if (hasStreamingPlan(thread, base.turnId)) {
    return { ...base, phase: 'streaming', visibleIndicator: 'plan', updatedAt: createdAt }
  }

  const nextPhase: ActiveTurnProjection['phase'] = phase === 'starting' ? 'starting' : 'streaming'
  return { ...base, phase: nextPhase, visibleIndicator: 'exploring', updatedAt: createdAt }
}

function hasUnresolvedReasoningThinking(
  thread: Pick<OrchestrationThread, 'activities' | 'session'>,
  turnId: string
): boolean {
  const sessionTurnId = thread.session?.activeTurnId
  for (const activity of thread.activities) {
    if (!activity.id.startsWith('thinking:')) continue
    if (activity.resolved === true) continue
    if (readPayloadString(activity.payload, 'itemType') !== 'reasoning') continue
    const aTurn = activity.turnId
    if (aTurn) {
      if (aTurn !== turnId) continue
    } else if (sessionTurnId !== turnId) {
      continue
    }
    return true
  }
  return false
}

function hasStreamingAssistant(
  thread: Pick<OrchestrationThread, 'messages'>,
  turnId: string
): boolean {
  return thread.messages.some(
    (m) => m.role === 'assistant' && m.turnId === turnId && m.streaming === true
  )
}

function hasStreamingPlan(
  thread: Pick<OrchestrationThread, 'proposedPlans'>,
  turnId: string
): boolean {
  return thread.proposedPlans.some((p) => p.turnId === turnId && p.status === 'streaming')
}

export function activeTurnProjectionEquals(
  a: ActiveTurnProjection | null,
  b: ActiveTurnProjection | null
): boolean {
  if (a === null && b === null) return true
  if (!a || !b) return false
  if (a.turnId !== b.turnId || a.phase !== b.phase || a.visibleIndicator !== b.visibleIndicator) {
    return false
  }
  if (a.startedAt !== b.startedAt) return false
  if (a.activeItemIds.length !== b.activeItemIds.length) return false
  for (let i = 0; i < a.activeItemIds.length; i += 1) {
    if (a.activeItemIds[i] !== b.activeItemIds[i]) return false
  }
  return true
}

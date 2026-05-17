/**
 * Builds `OrchestrationCommand`s that mark in-flight reasoning-thinking activities as
 * completed when another provider stream/item takes over the visible tail surface.
 */
import type { OrchestrationCommand, OrchestrationThreadActivity } from '../../../shared/agent'
import type { ThreadReader } from './RuntimeOperationCompiler'

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

export function compileResolveReasoningThinkingForTurn(
  threadId: string,
  turnId: string | null | undefined,
  createdAt: string,
  readThread: ThreadReader
): OrchestrationCommand[] {
  const thread = readThread(threadId)
  const effectiveTurnId = turnId ?? thread.session?.activeTurnId ?? null
  if (!effectiveTurnId) return []

  const commands: OrchestrationCommand[] = []
  for (const activity of thread.activities) {
    if (activity.turnId && activity.turnId !== effectiveTurnId) continue
    if (!activity.id.startsWith('thinking:')) continue
    if (activity.resolved === true) continue
    if (readPayloadString(activity.payload, 'itemType') !== 'reasoning') continue

    const basePayload =
      typeof activity.payload === 'object' && activity.payload !== null
        ? { ...(activity.payload as Record<string, unknown>) }
        : {}

    commands.push({
      type: 'provider.activity.upsert',
      commandId: `runtime:reasoning-resolve:${activity.id}:${createdAt}:${commands.length}`,
      threadId,
      activity: mergeActivityPreserveCreatedAt(activity, {
        kind: 'task.completed',
        resolved: true,
        payload: {
          ...basePayload,
          itemType: 'reasoning',
          status: 'completed'
        },
        createdAt
      }),
      createdAt
    })
  }
  return commands
}

function mergeActivityPreserveCreatedAt(
  prev: OrchestrationThreadActivity,
  patch: Partial<OrchestrationThreadActivity>
): OrchestrationThreadActivity {
  return { ...prev, ...patch, createdAt: prev.createdAt }
}

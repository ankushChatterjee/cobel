/**
 * RuntimeApprovalCompiler
 *
 * Compiles `request.opened`, `request.resolved`, `user-input.requested`, and
 * `user-input.resolved` `ProviderRuntimeEvent`s into `OrchestrationCommand`s.
 */
import type { OrchestrationCommand, ProviderRuntimeEvent } from '../../../shared/agent'
import { readCanonicalFileEditChanges } from '../../../shared/fileEditChanges'
import type { ThreadReader } from './RuntimeOperationCompiler'
import { itemTypeForRequest } from './RuntimeToolCompiler'

export function compileApprovalEvent(
  event: Extract<ProviderRuntimeEvent, { type: 'request.opened' | 'request.resolved' }>,
  readThread: ThreadReader
): OrchestrationCommand[] {
  switch (event.type) {
    case 'request.opened':
      return compileRequestOpened(event, readThread)
    case 'request.resolved':
      return compileRequestResolved(event, readThread)
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

function compileRequestOpened(
  event: Extract<ProviderRuntimeEvent, { type: 'request.opened' }>,
  readThread: ThreadReader
): OrchestrationCommand[] {
  const commands: OrchestrationCommand[] = []
  const approvalSlotId = `approval:${event.requestId ?? event.eventId}`
  const thread = readThread(event.threadId)
  const existing = thread.activities.find((a) => a.id === approvalSlotId)
  if (existing?.resolved === true) return commands

  // Upsert pending tool activity for the associated tool call (if any)
  const toolCallId = event.payload.toolCallId
  if (toolCallId) {
    const itemType = itemTypeForRequest(event.payload.requestType)
    const toolId = `tool:${toolCallId}`
    const existingTool = thread.activities.find((a) => a.id === toolId)
    if (!existingTool || existingTool.kind !== 'tool.completed') {
      const title =
        event.payload.detail ?? existingTool?.summary ?? itemType.replaceAll('_', ' ')
      commands.push({
        type: 'provider.activity.upsert',
        commandId: `provider:${event.eventId}:approval-tool`,
        threadId: event.threadId,
        activity: {
          id: toolId,
          kind: existingTool?.kind === 'tool.started' ? 'tool.updated' : 'tool.started',
          tone: 'tool',
          summary: title,
          payload: {
            ...existingTool?.payload,
            itemType,
            status: readPayloadStr(existingTool?.payload, 'status') ?? 'inProgress',
            title,
            detail: event.payload.detail ?? readPayloadStr(existingTool?.payload, 'detail'),
            requestType: event.payload.requestType,
            args: event.payload.args
          },
          turnId: event.turnId ?? existingTool?.turnId ?? null,
          createdAt: event.createdAt
        },
        createdAt: event.createdAt
      })
    }
  }

  const approvalFileEdit = readCanonicalFileEditChanges(event.payload)
  commands.push({
    type: 'provider.activity.upsert',
    commandId: `provider:${event.eventId}:approval-request`,
    threadId: event.threadId,
    activity: {
      id: approvalSlotId,
      kind: 'approval.requested',
      tone: 'approval',
      summary: event.payload.detail ?? event.payload.requestType.replaceAll('_', ' '),
      payload: {
        requestType: event.payload.requestType,
        toolCallId: event.payload.toolCallId,
        args: event.payload.args,
        ...(approvalFileEdit.length > 0 ? { fileEditChanges: approvalFileEdit } : {})
      },
      turnId: event.turnId ?? null,
      resolved: false,
      createdAt: event.createdAt
    },
    createdAt: event.createdAt
  })

  return commands
}

function compileRequestResolved(
  event: Extract<ProviderRuntimeEvent, { type: 'request.resolved' }>,
  readThread: ThreadReader
): OrchestrationCommand[] {
  const thread = readThread(event.threadId)
  const existingApproval = findApprovalForResolution(event, thread)
  const resolvedApprovalId = existingApproval?.id ?? `approval:${event.requestId ?? event.eventId}`
  const resolvedTurnId = event.turnId ?? existingApproval?.turnId ?? null

  return [
    {
      type: 'provider.activity.upsert',
      commandId: `provider:${event.eventId}:approval-resolved`,
      threadId: event.threadId,
      activity: {
        id: resolvedApprovalId,
        kind: 'approval.resolved',
        tone: 'info',
        summary: existingApproval?.summary ?? `Approval ${event.payload.decision ?? 'resolved'}`,
        payload: {
          ...existingApproval?.payload,
          requestType:
            event.payload.requestType && event.payload.requestType !== 'unknown'
              ? event.payload.requestType
              : (readPayloadStr(existingApproval?.payload, 'requestType') ??
                event.payload.requestType),
          decision: event.payload.decision,
          resolution: event.payload.resolution
        },
        turnId: resolvedTurnId,
        resolved: true,
        createdAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

export function compileUserInputEvent(
  event: Extract<ProviderRuntimeEvent, { type: 'user-input.requested' | 'user-input.resolved' }>,
  _readThread: ThreadReader
): OrchestrationCommand[] {
  if (event.type === 'user-input.requested') {
    return [
      {
        type: 'provider.activity.upsert',
        commandId: `provider:${event.eventId}:user-input-requested`,
        threadId: event.threadId,
        activity: {
          id: `user-input:${event.requestId ?? event.eventId}`,
          kind: 'user-input.requested',
          tone: 'approval',
          summary: event.payload.questions[0]?.question ?? 'Input needed',
          payload: { questions: event.payload.questions },
          turnId: event.turnId ?? null,
          resolved: false,
          createdAt: event.createdAt
        },
        createdAt: event.createdAt
      }
    ]
  }

  return [
    {
      type: 'provider.activity.upsert',
      commandId: `provider:${event.eventId}:user-input-resolved`,
      threadId: event.threadId,
      activity: {
        id: `user-input:${event.requestId ?? event.eventId}`,
        kind: 'user-input.resolved',
        tone: 'info',
        summary: 'User input submitted',
        payload: { answers: event.payload.answers },
        turnId: event.turnId ?? null,
        resolved: true,
        createdAt: event.createdAt
      },
      createdAt: event.createdAt
    }
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findApprovalForResolution(
  event: Extract<ProviderRuntimeEvent, { type: 'request.resolved' }>,
  thread: ReturnType<ThreadReader>
): import('../../../shared/agent').OrchestrationThreadActivity | undefined {
  if (event.requestId) {
    const id = `approval:${event.requestId}`
    const exact = thread.activities.find((a) => a.id === id)
    if (exact) return exact
  }
  return thread.activities
    .filter(
      (a) =>
        a.kind === 'approval.requested' &&
        a.resolved !== true &&
        activityBelongsToTurn(a, event.turnId)
    )
    .at(-1)
}

function activityBelongsToTurn(
  activity: import('../../../shared/agent').OrchestrationThreadActivity,
  turnId: string | undefined
): boolean {
  return !turnId || !activity.turnId || activity.turnId === turnId
}

function readPayloadStr(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = payload?.[key]
  return typeof v === 'string' ? v : undefined
}

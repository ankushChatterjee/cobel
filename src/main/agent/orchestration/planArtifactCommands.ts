/**
 * Produce a `provider.message.upsert` that attaches the finalized proposed plan artifact
 * to the latest assistant message for the given turn — mirrors legacy `attachPlanArtifact`.
 */
import type { OrchestrationCommand, OrchestrationMessage, OrchestrationProposedPlan } from '../../../shared/agent'

export function compilePlanArtifactCommand(input: {
  threadId: string
  turnId: string
  createdAt: string
  nonce: string
  thread: {
    proposedPlans: OrchestrationProposedPlan[]
    messages: OrchestrationMessage[]
    session?: { activePlanId: string | null } | null
  }
}): OrchestrationCommand[] {
  const { threadId, turnId, createdAt, nonce, thread } = input

  const plan =
    [...thread.proposedPlans].reverse().find((p) => p.turnId === turnId && p.status === 'proposed') ??
    [...thread.proposedPlans].reverse().find((p) => p.turnId === turnId) ??
    null
  if (!plan) return []

  const existingMessage = [...thread.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.turnId === turnId)

  const attachments = upsertPlanAttachment(existingMessage?.attachments, plan)

  const messageUpsert = existingMessage
    ? ({
        ...existingMessage,
        attachments,
        streaming: false,
        updatedAt: createdAt
      } satisfies OrchestrationMessage)
    : ({
        id: `assistant:plan:${plan.id}`,
        role: 'assistant',
        text: '',
        attachments,
        turnId,
        streaming: false,
        createdAt,
        updatedAt: createdAt
      } satisfies OrchestrationMessage)

  return [
    {
      type: 'provider.message.upsert',
      commandId: `runtime:plan-artifact:${nonce}`,
      threadId,
      message: messageUpsert,
      createdAt
    }
  ]
}

function upsertPlanAttachment(
  attachments: OrchestrationMessage['attachments'],
  plan: OrchestrationProposedPlan
): OrchestrationMessage['attachments'] {
  const nextAttachment = {
    type: 'plan' as const,
    planId: plan.id,
    title: derivePlanTitle(plan.text),
    status: plan.status
  }
  const existing = attachments ?? []
  const withoutPlan = existing.filter((attachment) => attachment.type !== 'plan')
  return [...withoutPlan, nextAttachment]
}

function derivePlanTitle(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const heading = lines.find((line) => /^#{1,6}\s+/u.test(line))
  const title = heading ? heading.replace(/^#{1,6}\s+/u, '') : lines[0]
  return title?.trim() || 'Plan'
}

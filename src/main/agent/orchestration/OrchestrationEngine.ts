import { EventEmitter } from 'node:events'
import type {
  ChatAttachment,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
  RuntimeMode
} from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'

interface ThreadRecord {
  thread: OrchestrationThread
  sequence: number
}

export class OrchestrationEngine {
  private readonly threads = new Map<string, ThreadRecord>()
  private readonly emitter = new EventEmitter()
  private sequence = 0

  ensureThread(input: {
    threadId: string
    title?: string
    cwd?: string
    branch?: string
  }): OrchestrationThread {
    const existing = this.threads.get(input.threadId)
    if (existing) {
      if (input.cwd && existing.thread.cwd !== input.cwd) {
        existing.thread = { ...existing.thread, cwd: input.cwd, updatedAt: nowIso() }
      }
      return existing.thread
    }

    const now = nowIso()
    const thread: OrchestrationThread = {
      id: input.threadId,
      title: input.title ?? 'Chat title',
      cwd: input.cwd,
      branch: input.branch ?? 'main',
      messages: [],
      activities: [],
      proposedPlans: [],
      session: null,
      latestTurn: null,
      checkpoints: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    }
    this.threads.set(input.threadId, { thread, sequence: this.sequence })
    return thread
  }

  getThread(threadId: string): OrchestrationThread {
    return this.ensureThread({ threadId })
  }

  getSnapshot(threadId: string): { snapshotSequence: number; thread: OrchestrationThread } {
    const thread = this.ensureThread({ threadId })
    return {
      snapshotSequence: this.threads.get(threadId)?.sequence ?? this.sequence,
      thread
    }
  }

  resetThread(input: { threadId: string; cwd?: string; title?: string }): OrchestrationThread {
    const previous = this.ensureThread({ threadId: input.threadId })
    const now = nowIso()
    const thread: OrchestrationThread = {
      ...previous,
      title: input.title ?? 'Chat title',
      cwd: input.cwd ?? previous.cwd,
      messages: [],
      activities: [],
      proposedPlans: [],
      session: null,
      latestTurn: null,
      checkpoints: [],
      updatedAt: now,
      archivedAt: null
    }
    this.threads.set(input.threadId, { thread, sequence: this.sequence })
    this.apply({
      sequence: this.nextSequence(),
      type: 'thread.snapshot.changed',
      threadId: input.threadId,
      thread,
      createdAt: now
    })
    return thread
  }

  subscribeThread(
    threadId: string,
    listener: (item: OrchestrationThreadStreamItem) => void
  ): () => void {
    listener({ kind: 'snapshot', snapshot: this.getSnapshot(threadId) })

    const onEvent = (event: OrchestrationEvent): void => {
      if (event.threadId === threadId) listener({ kind: 'event', event })
    }
    this.emitter.on('event', onEvent)
    return () => this.emitter.off('event', onEvent)
  }

  appendUserMessage(input: {
    threadId: string
    commandId: string
    text: string
    attachments?: ChatAttachment[]
    createdAt: string
  }): OrchestrationMessage {
    const thread = this.ensureThread({
      threadId: input.threadId,
      title: firstLineTitle(input.text)
    })
    const sequence = this.nextSequence()
    const message: OrchestrationMessage = {
      id: `user:${input.commandId}`,
      role: 'user',
      text: input.text,
      attachments: input.attachments,
      turnId: null,
      streaming: false,
      sequence,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    }
    this.apply({
      sequence,
      type: 'thread.message-upserted',
      threadId: thread.id,
      message,
      createdAt: input.createdAt
    })
    return message
  }

  setSession(input: {
    threadId: string
    status: OrchestrationSession['status']
    providerName: OrchestrationSession['providerName']
    runtimeMode: RuntimeMode
    activeTurnId: string | null
    lastError: string | null
    createdAt?: string
  }): OrchestrationSession {
    this.ensureThread({ threadId: input.threadId })
    const now = input.createdAt ?? nowIso()
    const session: OrchestrationSession = {
      threadId: input.threadId,
      status: input.status,
      providerName: input.providerName,
      runtimeMode: input.runtimeMode,
      activeTurnId: input.activeTurnId,
      lastError: input.lastError,
      updatedAt: now
    }
    this.apply({
      sequence: this.nextSequence(),
      type: 'thread.session-set',
      threadId: input.threadId,
      session,
      createdAt: now
    })
    return session
  }

  upsertMessage(message: OrchestrationMessage, threadId: string): void {
    this.ensureThread({ threadId })
    const existing = this.threads
      .get(threadId)
      ?.thread.messages.find((candidate) => candidate.id === message.id)
    const eventSequence = this.nextSequence()
    const messageSequence = existing?.sequence ?? eventSequence
    this.apply({
      sequence: eventSequence,
      type: 'thread.message-upserted',
      threadId,
      message: { ...message, sequence: messageSequence },
      createdAt: message.updatedAt
    })
  }

  upsertActivity(activity: OrchestrationThreadActivity, threadId: string): void {
    this.ensureThread({ threadId })
    const existing = this.threads
      .get(threadId)
      ?.thread.activities.find((candidate) => candidate.id === activity.id)
    const eventSequence = this.nextSequence()
    const activitySequence = existing?.sequence ?? eventSequence
    this.apply({
      sequence: eventSequence,
      type: 'thread.activity-upserted',
      threadId,
      activity: { ...activity, sequence: activitySequence },
      createdAt: activity.createdAt
    })
  }

  upsertProposedPlan(proposedPlan: OrchestrationProposedPlan, threadId: string): void {
    this.ensureThread({ threadId })
    this.apply({
      sequence: this.nextSequence(),
      type: 'thread.proposed-plan-upserted',
      threadId,
      proposedPlan,
      createdAt: proposedPlan.updatedAt
    })
  }

  setLatestTurn(threadId: string, latestTurn: OrchestrationLatestTurn | null): void {
    this.ensureThread({ threadId })
    this.apply({
      sequence: this.nextSequence(),
      type: 'thread.latest-turn-set',
      threadId,
      latestTurn,
      createdAt: nowIso()
    })
  }

  private apply(event: OrchestrationEvent): void {
    const record = this.threads.get(event.threadId)
    if (!record) return
    logEvent('orchestration/event', event)
    record.thread = applyOrchestrationEvent(record.thread, event)
    record.sequence = event.sequence
    this.emitter.emit('event', event)
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function firstLineTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/u)[0]?.trim()
  if (!firstLine) return 'Chat title'
  return firstLine.length > 54 ? `${firstLine.slice(0, 51)}...` : firstLine
}

function logEvent(label: string, payload: unknown): void {
  console.log(`[gencode:${label}]`, payload)
}

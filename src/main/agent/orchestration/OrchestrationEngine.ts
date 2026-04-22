import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ChatAttachment,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationCheckpointSummary,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationShellEvent,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
  ProjectSummary,
  RuntimeMode,
  ThreadShellSummary
} from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'
import type { OrchestrationEventStore } from '../persistence/OrchestrationEventStore'
import type { ProjectionPipeline } from '../persistence/ProjectionPipeline'
import type { SnapshotQuery } from '../persistence/SnapshotQuery'

interface ThreadRecord {
  thread: OrchestrationThread
  sequence: number
}

export interface OrchestrationEngineOptions {
  eventStore?: OrchestrationEventStore
  projections?: ProjectionPipeline
  snapshots?: SnapshotQuery
}

export class OrchestrationEngine {
  private readonly threads = new Map<string, ThreadRecord>()
  private readonly emitter = new EventEmitter()
  private readonly shellEmitter = new EventEmitter()
  private sequence = 0

  private readonly eventStore?: OrchestrationEventStore
  private readonly projections?: ProjectionPipeline
  private readonly snapshots?: SnapshotQuery

  constructor(options: OrchestrationEngineOptions = {}) {
    this.eventStore = options.eventStore
    this.projections = options.projections
    this.snapshots = options.snapshots
  }

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

    // Try to load from persistence first
    if (this.snapshots) {
      const persisted = this.snapshots.getThreadDetail(input.threadId)
      if (persisted) {
        this.threads.set(input.threadId, { thread: persisted, sequence: this.sequence })
        return persisted
      }
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

  subscribeShell(listener: (event: OrchestrationShellEvent) => void): () => void {
    this.shellEmitter.on('shell', listener)
    return () => this.shellEmitter.off('shell', listener)
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
      createdAt: input.createdAt,
      commandId: input.commandId
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

  upsertCheckpoint(checkpoint: OrchestrationCheckpointSummary, threadId: string): void {
    this.ensureThread({ threadId })
    this.apply({
      sequence: this.nextSequence(),
      type: 'thread.turn-diff-completed',
      threadId,
      checkpoint,
      createdAt: checkpoint.completedAt
    })
  }

  revertThread(input: {
    threadId: string
    turnCount: number
    createdAt?: string
    commandId?: string
  }): void {
    const now = input.createdAt ?? nowIso()
    this.ensureThread({ threadId: input.threadId })
    this.apply({
      sequence: this.nextSequence(),
      type: 'thread.reverted',
      threadId: input.threadId,
      turnCount: input.turnCount,
      revertedAt: now,
      createdAt: now,
      commandId: input.commandId
    })
  }

  createThread(input: {
    threadId: string
    projectId: string
    title: string
    cwd?: string
    branch?: string
    commandId?: string
    createdAt?: string
  }): OrchestrationThread {
    const now = input.createdAt ?? nowIso()
    const thread: OrchestrationThread = {
      id: input.threadId,
      title: input.title,
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
    this.apply(
      {
        sequence: this.nextSequence(),
        type: 'thread.created',
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        cwd: input.cwd,
        branch: input.branch ?? 'main',
        createdAt: now,
        commandId: input.commandId
      },
      {
        aggregateKind: 'thread',
        streamId: input.threadId,
        payloadExtra: { projectId: input.projectId }
      }
    )
    return thread
  }

  renameThread(input: {
    threadId: string
    title: string
    commandId?: string
    createdAt?: string
  }): void {
    const record = this.threads.get(input.threadId)
    if (record) {
      record.thread = {
        ...record.thread,
        title: input.title,
        updatedAt: input.createdAt ?? nowIso()
      }
    }
    this.apply(
      {
        sequence: this.nextSequence(),
        type: 'thread.renamed',
        threadId: input.threadId,
        title: input.title,
        createdAt: input.createdAt ?? nowIso(),
        commandId: input.commandId
      },
      { aggregateKind: 'thread', streamId: input.threadId }
    )
  }

  archiveThread(input: { threadId: string; commandId?: string; createdAt?: string }): void {
    const now = input.createdAt ?? nowIso()
    const record = this.threads.get(input.threadId)
    if (record) {
      record.thread = { ...record.thread, archivedAt: now, updatedAt: now }
    }
    this.apply(
      {
        sequence: this.nextSequence(),
        type: 'thread.archived',
        threadId: input.threadId,
        createdAt: now,
        commandId: input.commandId
      },
      { aggregateKind: 'thread', streamId: input.threadId }
    )
  }

  deleteThread(input: { threadId: string; commandId?: string; createdAt?: string }): void {
    const now = input.createdAt ?? nowIso()
    this.threads.delete(input.threadId)
    this.apply(
      {
        sequence: this.nextSequence(),
        type: 'thread.deleted',
        threadId: input.threadId,
        createdAt: now,
        commandId: input.commandId
      },
      { aggregateKind: 'thread', streamId: input.threadId }
    )
    this.shellEmitter.emit('shell', {
      type: 'shell.thread-removed',
      threadId: input.threadId
    } satisfies OrchestrationShellEvent)
  }

  createProject(input: {
    projectId: string
    name: string
    path: string
    commandId?: string
    createdAt?: string
  }): void {
    const now = input.createdAt ?? nowIso()
    this.persistProjectEvent({
      eventType: 'project.created',
      streamId: input.projectId,
      payload: { projectId: input.projectId, name: input.name, path: input.path },
      occurredAt: now,
      commandId: input.commandId
    })
    const projectSummary: ProjectSummary = {
      id: input.projectId,
      name: input.name,
      path: input.path,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    }
    this.shellEmitter.emit('shell', {
      type: 'shell.project-upserted',
      project: projectSummary
    } satisfies OrchestrationShellEvent)
  }

  deleteProject(input: { projectId: string; commandId?: string; createdAt?: string }): void {
    const now = input.createdAt ?? nowIso()
    this.persistProjectEvent({
      eventType: 'project.deleted',
      streamId: input.projectId,
      payload: { projectId: input.projectId },
      occurredAt: now,
      commandId: input.commandId
    })
    this.shellEmitter.emit('shell', {
      type: 'shell.project-removed',
      projectId: input.projectId
    } satisfies OrchestrationShellEvent)
  }

  emitShellThreadUpserted(thread: ThreadShellSummary): void {
    this.shellEmitter.emit('shell', {
      type: 'shell.thread-upserted',
      thread
    } satisfies OrchestrationShellEvent)
  }

  private apply(
    event: OrchestrationEvent,
    storageHints?: {
      aggregateKind?: 'project' | 'thread'
      streamId?: string
      payloadExtra?: Record<string, unknown>
    }
  ): void {
    const record = 'threadId' in event ? this.threads.get(event.threadId) : undefined
    logEvent('orchestration/event', event)

    if (record) {
      record.thread = applyOrchestrationEvent(record.thread, event)
      record.sequence = event.sequence
    }

    // Persist to event store + projection in a single transaction
    if (this.eventStore && this.projections) {
      const aggregateKind = storageHints?.aggregateKind ?? 'thread'
      const streamId = storageHints?.streamId ?? ('threadId' in event ? event.threadId : '')
      const streamVersion = this.eventStore.getStreamVersion(aggregateKind, streamId) + 1
      const eventId = randomUUID()
      const payload = buildEventPayload(event, storageHints?.payloadExtra)

      const storedSeq = this.eventStore.append({
        eventId,
        aggregateKind,
        streamId,
        streamVersion,
        eventType: event.type,
        occurredAt: event.createdAt,
        commandId: event.commandId,
        actorKind: 'system',
        payload
      })

      this.projections.apply({
        sequence: storedSeq,
        eventId,
        aggregateKind,
        streamId,
        streamVersion,
        eventType: event.type,
        occurredAt: event.createdAt,
        commandId: event.commandId,
        actorKind: 'system',
        payload
      })
    }

    this.emitter.emit('event', event)

    // Emit shell thread-upserted for relevant thread events
    if ('threadId' in event) {
      this.maybeEmitShellThreadUpserted(event)
    }
  }

  private maybeEmitShellThreadUpserted(event: OrchestrationEvent): void {
    if (
      event.type === 'thread.created' ||
      event.type === 'thread.renamed' ||
      event.type === 'thread.session-set' ||
      event.type === 'thread.latest-turn-set' ||
      event.type === 'thread.message-upserted' ||
      event.type === 'thread.turn-diff-completed' ||
      event.type === 'thread.reverted'
    ) {
      const thread = this.threads.get(event.threadId)?.thread
      if (!thread) return
      const projectId = readProjectIdFromThread(thread, event)
      const summary: ThreadShellSummary = {
        id: thread.id,
        projectId,
        title: thread.title,
        cwd: thread.cwd,
        branch: thread.branch ?? 'main',
        latestTurnId: thread.latestTurn?.id ?? null,
        sessionStatus: thread.session?.status ?? 'idle',
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt
      }
      this.shellEmitter.emit('shell', {
        type: 'shell.thread-upserted',
        thread: summary
      } satisfies OrchestrationShellEvent)
    }
  }

  private persistProjectEvent(input: {
    eventType: string
    streamId: string
    payload: unknown
    occurredAt: string
    commandId?: string
  }): void {
    if (!this.eventStore || !this.projections) return
    const streamVersion = this.eventStore.getStreamVersion('project', input.streamId) + 1
    const eventId = randomUUID()
    const storedSeq = this.eventStore.append({
      eventId,
      aggregateKind: 'project',
      streamId: input.streamId,
      streamVersion,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
      actorKind: 'system',
      payload: input.payload
    })
    this.projections.apply({
      sequence: storedSeq,
      eventId,
      aggregateKind: 'project',
      streamId: input.streamId,
      streamVersion,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
      actorKind: 'system',
      payload: input.payload
    })
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }
}

function buildEventPayload(
  event: OrchestrationEvent,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if ('thread' in event) base['thread'] = event.thread
  if ('session' in event) base['session'] = event.session
  if ('message' in event) base['message'] = event.message
  if ('activity' in event) base['activity'] = event.activity
  if ('proposedPlan' in event) base['proposedPlan'] = event.proposedPlan
  if ('latestTurn' in event) base['latestTurn'] = event.latestTurn
  if ('checkpoint' in event) base['checkpoint'] = event.checkpoint
  if ('turnCount' in event) base['turnCount'] = event.turnCount
  if ('revertedAt' in event) base['revertedAt'] = event.revertedAt
  if ('title' in event) base['title'] = event.title
  if ('projectId' in event) base['projectId'] = event.projectId
  if ('cwd' in event) base['cwd'] = event.cwd
  if ('branch' in event) base['branch'] = event.branch
  if (extra) Object.assign(base, extra)
  return base
}

function readProjectIdFromThread(thread: OrchestrationThread, event: OrchestrationEvent): string {
  if (event.type === 'thread.created' && 'projectId' in event) return event.projectId
  // Try to get projectId from the thread's id convention (project:xxx:chat:yyy)
  const match = /^project:([^:]+):/.exec(thread.id)
  return match?.[1] ?? ''
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
  console.log(`[cobel:${label}]`, payload)
}

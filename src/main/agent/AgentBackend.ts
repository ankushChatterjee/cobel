import type {
  ClientOrchestrationCommand,
  CheckpointDiffRequest,
  CheckpointDiffResult,
  CheckpointWorktreeDiffRequest,
  CheckpointWorktreeDiffResult,
  DispatchResult,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
  ProviderId,
  ProviderSummary,
  RespondToApprovalInput,
  RespondToUserInputInput,
  StopSessionInput,
  WorkspaceDiffRequest,
  WorkspaceDiffResult
} from '../../shared/agent'
import {
  canReplaceThreadTitle,
  DEFAULT_THREAD_TITLE,
  sanitizeThreadTitle
} from '../../shared/threadTitle'
import type { Database } from './persistence/Sqlite'
import { OrchestrationEngine } from './orchestration/OrchestrationEngine'
import { ProviderRuntimeIngestion } from './orchestration/ProviderRuntimeIngestion'
import { CodexAdapter } from './provider/codex/CodexAdapter'
import { OpenCodeAdapter } from './provider/opencode/OpenCodeAdapter'
import { ProviderService } from './provider/ProviderService'
import { FakeProviderAdapter } from './provider/fake/FakeProviderAdapter'
import { OrchestrationEventStore } from './persistence/OrchestrationEventStore'
import { ProjectionPipeline } from './persistence/ProjectionPipeline'
import { ProviderSessionDirectory } from './persistence/ProviderSessionDirectory'
import { SnapshotQuery } from './persistence/SnapshotQuery'
import { CheckpointReactor } from './checkpointing/CheckpointReactor'
import { CheckpointStore } from './checkpointing/CheckpointStore'

export class AgentBackend {
  readonly engine: OrchestrationEngine
  readonly providers: ProviderService
  readonly ingestion: ProviderRuntimeIngestion
  readonly checkpointReactor: CheckpointReactor
  private readonly directory: ProviderSessionDirectory
  private readonly snapshots: SnapshotQuery
  private readonly checkpointStore: CheckpointStore
  private readonly pendingThreadNaming = new Set<Promise<void>>()
  private readonly initialization: Promise<void>

  constructor(options: { useFakeProvider?: boolean; db?: Database } = {}) {
    if (options.db) {
      const eventStore = new OrchestrationEventStore(options.db)
      const snapshots = new SnapshotQuery(options.db)
      const projections = new ProjectionPipeline(options.db, eventStore)
      projections.bootstrap()
      this.directory = new ProviderSessionDirectory(options.db)
      this.snapshots = snapshots
      this.engine = new OrchestrationEngine({ eventStore, projections, snapshots })
    } else {
      // In-memory fallback (tests without DB, legacy mode)
      this.snapshots = createNullSnapshotQuery()
      this.directory = createNullDirectory()
      this.engine = new OrchestrationEngine()
    }

    this.clearRestartStaleUserInputs()

    this.providers = new ProviderService()
    this.ingestion = new ProviderRuntimeIngestion(this.engine)
    this.checkpointStore = new CheckpointStore()
    this.checkpointReactor = new CheckpointReactor(
      this.engine,
      this.ingestion,
      this.checkpointStore
    )
    this.providers.register(
      options.useFakeProvider ? new FakeProviderAdapter() : new CodexAdapter()
    )
    if (!options.useFakeProvider) {
      this.providers.register(new OpenCodeAdapter())
    }
    this.providers.subscribe((event) => {
      this.ingestion.enqueue(event)
      this.checkpointReactor.enqueue(event)
    })
    this.initialization = this.providers.initialize()
  }

  async listProviders(): Promise<ProviderSummary[]> {
    await this.initialization
    return this.providers.listProviders()
  }

  async listModelCatalog() {
    await this.initialization
    return this.providers.listModelCatalog()
  }

  async initialize(): Promise<void> {
    await this.initialization
  }

  getShellSnapshot(): OrchestrationShellSnapshot {
    return this.snapshots.getShellSnapshot()
  }

  subscribeShell(listener: (item: OrchestrationShellStreamItem) => void): () => void {
    listener({ kind: 'snapshot', snapshot: this.getShellSnapshot() })
    return this.engine.subscribeShell((event) => listener({ kind: 'event', event }))
  }

  subscribeThread(
    input: { threadId: string },
    listener: (item: OrchestrationThreadStreamItem) => void
  ): () => void {
    return this.engine.subscribeThread(input.threadId, listener)
  }

  getThreadSnapshot(threadId: string): OrchestrationThreadStreamItem {
    return { kind: 'snapshot', snapshot: this.engine.getSnapshot(threadId) }
  }

  async dispatchCommand(input: ClientOrchestrationCommand): Promise<DispatchResult> {
    assertCommand(input)
    switch (input.type) {
      case 'project.create': {
        this.engine.createProject({
          projectId: input.projectId,
          name: input.name,
          path: input.path,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: '' }
      }

      case 'project.delete': {
        this.engine.deleteProject({
          projectId: input.projectId,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: '' }
      }

      case 'thread.create': {
        const title = sanitizeThreadTitle(input.title)
        this.engine.createThread({
          threadId: input.threadId,
          projectId: input.projectId,
          title,
          cwd: input.cwd,
          branch: input.branch,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
      }

      case 'thread.rename': {
        const title = sanitizeThreadTitle(input.title)
        this.engine.renameThread({
          threadId: input.threadId,
          title,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
      }

      case 'thread.archive': {
        this.engine.archiveThread({
          threadId: input.threadId,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
      }

      case 'thread.delete': {
        const thread = this.engine.getThread(input.threadId)
        if (thread.session?.providerName) {
          await this.providers.stopSession(thread.session.providerName, {
            threadId: input.threadId
          })
        }
        this.directory.clear(input.threadId)
        this.engine.deleteThread({
          threadId: input.threadId,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
      }

      case 'thread.turn.start': {
        this.engine.ensureThread({ threadId: input.threadId, cwd: input.cwd })
        const threadBeforeTurn = this.engine.getThread(input.threadId)
        const lockedProvider =
          threadBeforeTurn.session?.providerName ??
          this.directory.get(input.threadId)?.provider
        if (lockedProvider && input.provider !== lockedProvider) {
          throw new Error(
            `This thread is locked to provider "${lockedProvider}". Cannot use "${input.provider}".`
          )
        }
        this.seedThreadTitle({
          threadId: input.threadId,
          titleSeed: input.titleSeed,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        this.engine.appendUserMessage({
          threadId: input.threadId,
          commandId: input.commandId,
          text: input.input,
          attachments: input.attachments,
          createdAt: input.createdAt
        })
        this.engine.setSession({
          threadId: input.threadId,
          status: 'starting',
          providerName: input.provider,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          model: sanitizeOptionalString(input.model),
          effort: sanitizeOptionalEffort(input.effort),
          activeTurnId: null,
          activePlanId: sanitizeOptionalString(input.targetPlanId) ?? null,
          lastError: null,
          createdAt: input.createdAt
        })
        this.engine.setActiveTurn({
          threadId: input.threadId,
          activeTurn: {
            turnId: `pending:${input.commandId}`,
            phase: 'queued',
            activeItemIds: [],
            visibleIndicator: 'exploring',
            startedAt: input.createdAt,
            updatedAt: input.createdAt
          },
          createdAt: input.createdAt
        })
        try {
        const resumeCursor = this.directory.getResumeCursor(input.threadId)
        await this.providers.startSession({
          provider: input.provider,
          threadId: input.threadId,
          cwd: input.cwd,
          model: sanitizeOptionalString(input.model),
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          resumeCursor
        })
        await this.checkpointReactor.ensureBaseline({
          threadId: input.threadId,
          cwd: input.cwd ?? this.engine.getThread(input.threadId).cwd
        })
        const result = await this.providers.sendTurn({
          provider: input.provider,
          threadId: input.threadId,
          input: input.input,
          attachments: input.attachments,
          model: sanitizeOptionalString(input.model),
          effort: sanitizeOptionalEffort(input.effort),
          interactionMode: input.interactionMode
        })
        if (result.resumeCursor) {
          this.directory.upsert(input.threadId, {
            provider: input.provider,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            status: 'running',
            resumeCursor: result.resumeCursor
          })
        }
        {
          const nowIso = new Date().toISOString()
          const cur = this.engine.getThread(input.threadId).activeTurn
          if (cur?.phase === 'queued') {
            this.engine.setActiveTurn({
              threadId: input.threadId,
              activeTurn: {
                ...cur,
                turnId: result.turnId,
                updatedAt: nowIso
              },
              createdAt: nowIso
            })
          }
        }
        this.trackThreadNaming(this.autoRenameThreadFromFirstTurn({
          threadId: input.threadId,
          input: input.input,
          provider: input.provider,
          cwd: input.cwd,
          model: sanitizeOptionalString(input.model),
          titleSeed: input.titleSeed,
          commandId: input.commandId,
          createdAt: input.createdAt
        }))
        return {
          accepted: true,
          commandId: input.commandId,
          threadId: input.threadId,
          turnId: result.turnId
        }
        } catch (err) {
          this.engine.setActiveTurn({
            threadId: input.threadId,
            activeTurn: null,
            createdAt: new Date().toISOString()
          })
          throw err
        }
      }

      case 'thread.session.stop':
        await this.stopSession({ threadId: input.threadId })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }

      case 'thread.checkpoint.revert':
        await this.revertCheckpoint(input)
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }

      case 'thread.checkpoint.commit':
        await this.commitCheckpoint(input)
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
    }
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.providers.interruptTurn(this.providerForThread(input.threadId), input)
  }

  async respondToApproval(input: RespondToApprovalInput): Promise<void> {
    const provider = await this.ensureProviderSessionForThread(input.threadId)
    await this.providers.respondToApproval(provider, input)
  }

  async respondToUserInput(input: RespondToUserInputInput): Promise<void> {
    const provider = await this.ensureProviderSessionForThread(input.threadId)
    await this.providers.respondToUserInput(provider, input)
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    await this.providers.stopSession(this.providerForThread(input.threadId), input)
  }

  async clearThread(input: { threadId: string }): Promise<void> {
    const thread = this.engine.getThread(input.threadId)
    if (thread.session?.providerName) {
      await this.providers.stopSession(thread.session.providerName, { threadId: input.threadId })
    }
    this.directory.clear(input.threadId)
    this.engine.resetThread({ threadId: input.threadId, cwd: thread.cwd })
  }

  async getCheckpointDiff(input: CheckpointDiffRequest): Promise<CheckpointDiffResult> {
    const thread = this.engine.getThread(input.threadId)
    if (!thread.cwd) throw new Error('No workspace is attached to this thread.')
    if (input.fromTurnCount < 0 || input.toTurnCount < 0) {
      throw new Error('Checkpoint turn counts must be non-negative.')
    }
    if (input.toTurnCount < input.fromTurnCount) {
      throw new Error('The checkpoint diff range is invalid.')
    }
    const result = await this.checkpointStore.diffCheckpoints(
      thread.cwd,
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount
    )
    return { ...input, ...result }
  }

  async getCheckpointWorktreeDiff(
    input: CheckpointWorktreeDiffRequest
  ): Promise<CheckpointWorktreeDiffResult> {
    const thread = this.engine.getThread(input.threadId)
    if (!thread.cwd) throw new Error('No workspace is attached to this thread.')
    if (input.fromTurnCount < 0) {
      throw new Error('Checkpoint turn counts must be non-negative.')
    }
    const result = await this.checkpointStore.diffCheckpointToWorktree(
      thread.cwd,
      input.threadId,
      input.fromTurnCount
    )
    return { ...input, ...result }
  }

  async getWorkspaceDiff(input: WorkspaceDiffRequest): Promise<WorkspaceDiffResult> {
    const cwd = input.cwd.trim()
    if (!cwd) throw new Error('A workspace path is required.')
    const result = await this.checkpointStore.diffWorkspace(cwd)
    return { cwd, ...result }
  }

  async drain(): Promise<void> {
    await this.ingestion.drain()
    await this.checkpointReactor.drain()
    if (this.pendingThreadNaming.size > 0) {
      await Promise.all([...this.pendingThreadNaming])
    }
  }

  /** Release provider child processes before the Electron app exits. */
  async prepareQuit(): Promise<void> {
    await this.providers.disposeOpenCodeSessions()
  }

  private clearRestartStaleUserInputs(): void {
    for (const shellThread of this.snapshots.getShellSnapshot().threads) {
      const thread = this.engine.getThread(shellThread.id)
      for (const activity of thread.activities) {
        if (activity.kind !== 'user-input.requested' || activity.resolved === true) continue
        this.engine.upsertActivity(
          {
            ...activity,
            kind: 'user-input.resolved',
            tone: 'info',
            summary: `${activity.summary} (cleared on app restart)`,
            resolved: true,
            createdAt: activity.createdAt
          },
          thread.id
        )
      }
    }
  }

  private providerForThread(threadId: string): ProviderId {
    return this.engine.getThread(threadId).session?.providerName ?? 'codex'
  }

  private async ensureProviderSessionForThread(threadId: string): Promise<ProviderId> {
    const thread = this.engine.getThread(threadId)
    const binding = this.directory.get(threadId)
    const provider = thread.session?.providerName ?? binding?.provider ?? 'codex'
    const runtimeMode = thread.session?.runtimeMode ?? binding?.runtimeMode ?? 'auto-accept-edits'
    const interactionMode = thread.session?.interactionMode ?? binding?.interactionMode ?? 'default'
    await this.providers.startSession({
      provider,
      threadId,
      cwd: thread.cwd,
      model: thread.session?.model,
      runtimeMode,
      interactionMode,
      resumeCursor: binding?.resumeCursor
    })
    return provider
  }

  private seedThreadTitle(input: {
    threadId: string
    titleSeed?: string
    commandId: string
    createdAt: string
  }): void {
    if (typeof input.titleSeed !== 'string' || input.titleSeed.trim().length === 0) return
    const thread = this.engine.getThread(input.threadId)
    const seed = sanitizeThreadTitle(input.titleSeed)
    if (!canReplaceThreadTitle(thread.title, seed)) return
    if (thread.title === seed) return
    this.engine.renameThread({
      threadId: input.threadId,
      title: seed,
      commandId: input.commandId,
      createdAt: input.createdAt
    })
  }

  private async autoRenameThreadFromFirstTurn(input: {
    threadId: string
    input: string
    provider: ProviderId
    cwd?: string
    model?: string
    titleSeed?: string
    commandId: string
    createdAt: string
  }): Promise<void> {
    const thread = this.engine.getThread(input.threadId)
    const isFirstTurn = thread.messages.filter((message) => message.role === 'user').length === 1
    if (!isFirstTurn) return

    try {
      await Promise.resolve()
      const generatedTitle = await this.providers.generateThreadTitle({
        provider: input.provider,
        cwd: input.cwd,
        input: input.input,
        model: input.model
      })
      if (!generatedTitle || generatedTitle === DEFAULT_THREAD_TITLE) return
      const latestThread = this.engine.getThread(input.threadId)
      if (!canReplaceThreadTitle(latestThread.title, input.titleSeed)) return
      if (latestThread.title === generatedTitle) return
      this.engine.renameThread({
        threadId: input.threadId,
        title: generatedTitle,
        commandId: `${input.commandId}:auto-title`,
        createdAt: input.createdAt
      })
    } catch (error) {
      console.warn('[cobel:thread-naming] failed to generate title', {
        threadId: input.threadId,
        error
      })
    }
  }

  private trackThreadNaming(task: Promise<void>): void {
    this.pendingThreadNaming.add(task)
    void task.finally(() => {
      this.pendingThreadNaming.delete(task)
    })
  }

  private async revertCheckpoint(
    input: Extract<ClientOrchestrationCommand, { type: 'thread.checkpoint.revert' }>
  ): Promise<void> {
    const thread = this.engine.getThread(input.threadId)
    if (
      thread.session?.activeTurnId ||
      thread.session?.status === 'running' ||
      thread.session?.status === 'starting'
    ) {
      throw new Error('Interrupt the current turn before reverting checkpoints.')
    }
    if (!thread.cwd) throw new Error('No workspace is attached to this thread.')
    if (!Number.isInteger(input.turnCount) || input.turnCount < 0) {
      throw new Error('Revert checkpoint turn count is invalid.')
    }
    const latestTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0
    )
    if (input.turnCount > latestTurnCount) {
      throw new Error('Cannot revert to a future checkpoint.')
    }

    await this.checkpointStore.restoreCheckpoint(thread.cwd, input.threadId, input.turnCount)
  }

  private async commitCheckpoint(
    input: Extract<ClientOrchestrationCommand, { type: 'thread.checkpoint.commit' }>
  ): Promise<void> {
    const thread = this.engine.getThread(input.threadId)
    if (
      thread.session?.activeTurnId ||
      thread.session?.status === 'running' ||
      thread.session?.status === 'starting'
    ) {
      throw new Error('Interrupt the current turn before committing changes.')
    }
    if (!thread.cwd) throw new Error('No workspace is attached to this thread.')
    const message = input.message.trim()
    if (!message) throw new Error('Commit message is required.')
    await this.checkpointStore.commitWorktree(thread.cwd, message)
    await this.checkpointStore.captureCheckpoint(thread.cwd, input.threadId, 0)
  }
}

function assertCommand(input: ClientOrchestrationCommand): void {
  if (!input || typeof input !== 'object') throw new Error('Command must be an object.')
  if (!input.commandId) throw new Error('Command is missing commandId.')
  if (input.type === 'thread.turn.start') {
    if (input.provider !== 'codex' && input.provider !== 'opencode') {
      throw new Error(`Unsupported provider: ${input.provider}`)
    }
    if (typeof input.input !== 'string' || input.input.trim().length === 0) {
      throw new Error('Prompt input is required.')
    }
    if (input.titleSeed !== undefined && typeof input.titleSeed !== 'string') {
      throw new Error('Thread title seed must be a string when provided.')
    }
    if (input.targetPlanId !== undefined && typeof input.targetPlanId !== 'string') {
      throw new Error('Target plan id must be a string when provided.')
    }
  }
  if (input.type === 'thread.checkpoint.commit' && input.message.trim().length === 0) {
    throw new Error('Commit message is required.')
  }
}

function sanitizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function sanitizeOptionalEffort(
  value: unknown
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh' | undefined {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max' ||
    value === 'xhigh'
    ? value
    : undefined
}

// Null implementations for in-memory mode (no DB)
function createNullSnapshotQuery(): SnapshotQuery {
  return {
    getShellSnapshot: () => ({ projects: [], threads: [] }),
    getThreadDetail: () => null
  } as unknown as SnapshotQuery
}

function createNullDirectory(): ProviderSessionDirectory {
  return {
    get: () => null,
    getResumeCursor: () => undefined,
    upsert: () => {},
    clear: () => {}
  } as unknown as ProviderSessionDirectory
}

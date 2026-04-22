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
  StopSessionInput
} from '../../shared/agent'
import type { ModelInfo } from './provider/codex/codex-api-types'
import type { Database } from './persistence/Sqlite'
import { OrchestrationEngine } from './orchestration/OrchestrationEngine'
import { ProviderRuntimeIngestion } from './orchestration/ProviderRuntimeIngestion'
import { CodexAdapter } from './provider/codex/CodexAdapter'
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
    this.providers.subscribe((event) => {
      this.ingestion.enqueue(event)
      this.checkpointReactor.enqueue(event)
    })
  }

  async listProviders(): Promise<ProviderSummary[]> {
    return this.providers.listProviders()
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.providers.listModels('codex')
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
        this.engine.createThread({
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          cwd: input.cwd,
          branch: input.branch,
          commandId: input.commandId,
          createdAt: input.createdAt
        })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
      }

      case 'thread.rename': {
        this.engine.renameThread({
          threadId: input.threadId,
          title: input.title,
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
          activeTurnId: null,
          lastError: null,
          createdAt: input.createdAt
        })
        const resumeCursor = this.directory.getResumeCursor(input.threadId)
        await this.providers.startSession({
          provider: input.provider,
          threadId: input.threadId,
          cwd: input.cwd,
          model: sanitizeOptionalString(input.model),
          runtimeMode: input.runtimeMode,
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
          model: sanitizeOptionalString(input.model)
        })
        if (result.resumeCursor) {
          this.directory.upsert(input.threadId, {
            provider: input.provider,
            runtimeMode: input.runtimeMode,
            status: 'running',
            resumeCursor: result.resumeCursor
          })
        }
        return {
          accepted: true,
          commandId: input.commandId,
          threadId: input.threadId,
          turnId: result.turnId
        }
      }

      case 'thread.session.stop':
        await this.stopSession({ threadId: input.threadId })
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }

      case 'thread.checkpoint.revert':
        await this.revertCheckpoint(input)
        return { accepted: true, commandId: input.commandId, threadId: input.threadId }
    }
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.providers.interruptTurn(this.providerForThread(input.threadId), input)
  }

  async respondToApproval(input: RespondToApprovalInput): Promise<void> {
    await this.providers.respondToApproval(this.providerForThread(input.threadId), input)
  }

  async respondToUserInput(input: RespondToUserInputInput): Promise<void> {
    await this.providers.respondToUserInput(this.providerForThread(input.threadId), input)
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

  async drain(): Promise<void> {
    await this.ingestion.drain()
    await this.checkpointReactor.drain()
  }

  private providerForThread(threadId: string): ProviderId {
    return this.engine.getThread(threadId).session?.providerName ?? 'codex'
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
}

function assertCommand(input: ClientOrchestrationCommand): void {
  if (!input || typeof input !== 'object') throw new Error('Command must be an object.')
  if (!input.commandId) throw new Error('Command is missing commandId.')
  if (input.type === 'thread.turn.start') {
    if (input.provider !== 'codex') throw new Error(`Unsupported provider: ${input.provider}`)
    if (typeof input.input !== 'string' || input.input.trim().length === 0) {
      throw new Error('Prompt input is required.')
    }
  }
}

function sanitizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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

import type { OrchestrationCheckpointSummary, ProviderRuntimeEvent } from '../../../shared/agent'
import type { OrchestrationEngine } from '../orchestration/OrchestrationEngine'
import type { ProviderRuntimeIngestion } from '../orchestration/ProviderRuntimeIngestion'
import { CheckpointStore } from './CheckpointStore'

export class CheckpointReactor {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly engine: OrchestrationEngine,
    private readonly ingestion: ProviderRuntimeIngestion,
    private readonly store = new CheckpointStore()
  ) {}

  enqueue(event: ProviderRuntimeEvent): void {
    if (event.type !== 'turn.completed') return
    this.queue = this.queue
      .then(() => this.captureCompletedTurn(event))
      .catch((error) => {
        console.error('[cobel:checkpoint-reactor]', error)
      })
  }

  async drain(): Promise<void> {
    await this.queue
  }

  async ensureBaseline(input: { threadId: string; cwd?: string }): Promise<void> {
    const { cwd } = input
    if (!cwd) return
    if (!(await this.store.isGitRepository(cwd))) return
    const thread = this.engine.getThread(input.threadId)
    const turnCount = latestCheckpointTurnCount(thread.checkpoints)
    if (await this.store.hasCheckpoint(cwd, input.threadId, turnCount)) return
    await this.store.captureCheckpoint(cwd, input.threadId, turnCount)
  }

  private async captureCompletedTurn(
    event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>
  ): Promise<void> {
    if (!event.turnId) return
    await this.ingestion.drain()

    const thread = this.engine.getThread(event.threadId)
    const cwd = thread.cwd
    const currentTurnCount = latestCheckpointTurnCount(thread.checkpoints)
    const nextTurnCount = currentTurnCount + 1
    const assistantMessageId = [...thread.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.turnId === event.turnId)?.id

    if (!cwd) {
      this.engine.upsertCheckpoint(
        this.errorCheckpoint({
          threadId: event.threadId,
          turnId: event.turnId,
          assistantMessageId,
          checkpointTurnCount: nextTurnCount,
          completedAt: event.createdAt,
          message: 'No workspace is attached to this thread.'
        }),
        event.threadId
      )
      return
    }

    if (!(await this.store.isGitRepository(cwd))) {
      this.engine.upsertCheckpoint(
        this.errorCheckpoint({
          threadId: event.threadId,
          turnId: event.turnId,
          assistantMessageId,
          checkpointTurnCount: nextTurnCount,
          completedAt: event.createdAt,
          message: 'Diff review requires a Git workspace.'
        }),
        event.threadId
      )
      return
    }

    try {
      const hasBaseline = await this.store.hasCheckpoint(cwd, event.threadId, currentTurnCount)
      await this.store.captureCheckpoint(cwd, event.threadId, nextTurnCount)
      if (!hasBaseline) {
        throw new Error('The pre-turn filesystem checkpoint is unavailable.')
      }

      const files = await this.store.summarizeDiff(
        cwd,
        event.threadId,
        currentTurnCount,
        nextTurnCount
      )
      this.engine.upsertCheckpoint(
        {
          id: `checkpoint:${event.threadId}:${event.turnId}`,
          turnId: event.turnId,
          assistantMessageId,
          checkpointTurnCount: nextTurnCount,
          status: event.payload.state === 'completed' ? 'ready' : 'error',
          files,
          completedAt: event.createdAt,
          errorMessage:
            event.payload.state === 'completed'
              ? undefined
              : (event.payload.errorMessage ?? event.payload.stopReason ?? event.payload.state)
        },
        event.threadId
      )
    } catch (error) {
      this.engine.upsertCheckpoint(
        this.errorCheckpoint({
          threadId: event.threadId,
          turnId: event.turnId,
          assistantMessageId,
          checkpointTurnCount: nextTurnCount,
          completedAt: event.createdAt,
          message: error instanceof Error ? error.message : String(error)
        }),
        event.threadId
      )
    }
  }

  private errorCheckpoint(input: {
    threadId: string
    turnId: string
    assistantMessageId?: string
    checkpointTurnCount: number
    completedAt: string
    message: string
  }): OrchestrationCheckpointSummary {
    return {
      id: `checkpoint:${input.threadId}:${input.turnId}`,
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      checkpointTurnCount: input.checkpointTurnCount,
      status: 'error',
      files: [],
      completedAt: input.completedAt,
      errorMessage: input.message
    }
  }
}

function latestCheckpointTurnCount(checkpoints: OrchestrationCheckpointSummary[]): number {
  return checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0
  )
}

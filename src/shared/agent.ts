export type ProviderId = 'codex' | 'opencode'

export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'full-access'
export type InteractionMode = 'default' | 'plan'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'

export type ProviderSessionStatus = 'connecting' | 'ready' | 'running' | 'error' | 'closed'

export type RuntimeSessionState = 'starting' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error'

export type RuntimeItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined'

export type RuntimeContentStreamKind =
  | 'assistant_text'
  | 'reasoning_text'
  | 'reasoning_summary_text'
  | 'plan_text'
  | 'command_output'
  | 'file_change_output'
  | 'unknown'

export type CanonicalItemType =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'plan'
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'dynamic_tool_call'
  | 'collab_agent_tool_call'
  | 'web_search'
  | 'image_view'
  | 'review_entered'
  | 'review_exited'
  | 'context_compaction'
  | 'error'
  | 'unknown'

export type CanonicalRequestType =
  | 'command_execution_approval'
  | 'file_read_approval'
  | 'file_change_approval'
  | 'apply_patch_approval'
  | 'exec_command_approval'
  | 'tool_user_input'
  | 'dynamic_tool_call'
  | 'auth_tokens_refresh'
  | 'unknown'

export type ProviderApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface ProviderSummary {
  id: ProviderId
  name: string
  status: 'available' | 'missing' | 'error'
  detail?: string
}

export interface ProviderSession {
  provider: ProviderId
  status: ProviderSessionStatus
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
  cwd?: string
  model?: string
  threadId: string
  resumeCursor?: unknown
  activeTurnId?: string
  createdAt: string
  updatedAt: string
  lastError?: string
}

export interface UserInputOption {
  label: string
  description?: string
}

export interface UserInputQuestion {
  id: string
  header?: string
  question: string
  options?: UserInputOption[]
}

export interface RuntimeEventBase {
  eventId: string
  provider: ProviderId
  threadId: string
  turnId?: string
  itemId?: string
  requestId?: string
  createdAt: string
  providerRefs?: {
    providerTurnId?: string
    providerItemId?: string
    providerRequestId?: string
  }
  raw?: {
    source:
      | 'codex.app-server.notification'
      | 'codex.app-server.request'
      | 'fake.provider'
      | 'opencode.sdk'
    method?: string
    payload: unknown
  }
}

export type ProviderRuntimeEvent =
  | (RuntimeEventBase & {
      type: 'session.state.changed'
      payload: { state: RuntimeSessionState; reason?: string }
    })
  | (RuntimeEventBase & {
      type: 'thread.started'
      payload: { providerThreadId: string }
    })
  | (RuntimeEventBase & {
      type: 'turn.started'
      payload: { model?: string; effort?: string }
    })
  | (RuntimeEventBase & {
      type: 'turn.completed'
      payload: {
        state: 'completed' | 'failed' | 'cancelled' | 'interrupted'
        stopReason?: string
        errorMessage?: string
        usage?: unknown
      }
    })
  | (RuntimeEventBase & {
      type: 'content.delta'
      payload: {
        streamKind: RuntimeContentStreamKind
        delta: string
        contentIndex?: number
        summaryIndex?: number
      }
    })
  | (RuntimeEventBase & {
      type: 'item.started' | 'item.updated' | 'item.completed'
      payload: {
        itemType: CanonicalItemType
        status?: RuntimeItemStatus
        title?: string
        detail?: string
        data?: unknown
      }
    })
  | (RuntimeEventBase & {
      type: 'request.opened'
      payload: {
        requestType: CanonicalRequestType
        detail?: string
        args?: unknown
      }
    })
  | (RuntimeEventBase & {
      type: 'request.resolved'
      payload: {
        requestType: CanonicalRequestType
        decision?: string
        resolution?: unknown
      }
    })
  | (RuntimeEventBase & {
      type: 'user-input.requested'
      payload: { questions: UserInputQuestion[] }
    })
  | (RuntimeEventBase & {
      type: 'user-input.resolved'
      payload: { answers: Record<string, unknown> }
    })
  | (RuntimeEventBase & {
      type: 'runtime.error' | 'runtime.warning'
      payload: { message: string; detail?: unknown }
    })

export interface ChatAttachment {
  type: 'image'
  url: string
}

export interface OrchestrationMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ChatAttachment[]
  turnId: string | null
  streaming: boolean
  sequence?: number
  createdAt: string
  updatedAt: string
}

export interface OrchestrationThreadActivity {
  id: string
  kind:
    | 'tool.started'
    | 'tool.updated'
    | 'tool.completed'
    | 'approval.requested'
    | 'approval.resolved'
    | 'user-input.requested'
    | 'user-input.resolved'
    | 'task.started'
    | 'task.progress'
    | 'task.completed'
    | 'runtime.warning'
    | 'runtime.error'
    | 'context-window.updated'
  tone: 'thinking' | 'tool' | 'info' | 'approval' | 'error'
  summary: string
  payload?: Record<string, unknown>
  turnId: string | null
  sequence?: number
  resolved?: boolean
  createdAt: string
}

export interface OrchestrationProposedPlan {
  id: string
  turnId: string
  text: string
  status: 'streaming' | 'proposed' | 'accepted' | 'declined'
  createdAt: string
  updatedAt: string
}

export type CheckpointFileKind = 'added' | 'modified' | 'deleted' | 'renamed'

export type CheckpointStatus = 'ready' | 'missing' | 'error'

export interface CheckpointFileChange {
  path: string
  oldPath?: string
  kind: CheckpointFileKind
  additions: number
  deletions: number
  binary?: boolean
}

export interface OrchestrationCheckpointSummary {
  id: string
  turnId: string
  assistantMessageId?: string
  checkpointTurnCount: number
  status: CheckpointStatus
  files: CheckpointFileChange[]
  completedAt: string
  errorMessage?: string
}

export interface CheckpointDiffRequest {
  threadId: string
  fromTurnCount: number
  toTurnCount: number
}

export interface CheckpointDiffResult {
  threadId: string
  fromTurnCount: number
  toTurnCount: number
  diff: string
  truncated: boolean
}

export interface CheckpointWorktreeDiffRequest {
  threadId: string
  fromTurnCount: number
}

export interface CheckpointWorktreeDiffResult {
  threadId: string
  fromTurnCount: number
  diff: string
  files: CheckpointFileChange[]
  truncated: boolean
}

export interface OrchestrationSession {
  threadId: string
  status: 'idle' | 'starting' | 'running' | 'ready' | 'interrupted' | 'stopped' | 'error'
  providerName: ProviderId | null
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
  effort?: ReasoningEffort
  activeTurnId: string | null
  activePlanId: string | null
  lastError: string | null
  updatedAt: string
}

export interface OrchestrationLatestTurn {
  id: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  completedAt: string | null
}

export interface OrchestrationThread {
  id: string
  title: string
  cwd?: string
  branch?: string
  messages: OrchestrationMessage[]
  activities: OrchestrationThreadActivity[]
  proposedPlans: OrchestrationProposedPlan[]
  session: OrchestrationSession | null
  latestTurn: OrchestrationLatestTurn | null
  checkpoints: OrchestrationCheckpointSummary[]
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface OrchestrationEventMeta {
  eventId?: string
  streamVersion?: number
  commandId?: string
  actorKind?: string
}

export type OrchestrationEvent =
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.snapshot.changed'
      threadId: string
      thread: OrchestrationThread
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.session-set'
      threadId: string
      session: OrchestrationSession | null
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.message-upserted'
      threadId: string
      message: OrchestrationMessage
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.activity-upserted'
      threadId: string
      activity: OrchestrationThreadActivity
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.proposed-plan-upserted'
      threadId: string
      proposedPlan: OrchestrationProposedPlan
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.latest-turn-set'
      threadId: string
      latestTurn: OrchestrationLatestTurn | null
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.turn-diff-completed'
      threadId: string
      checkpoint: OrchestrationCheckpointSummary
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.reverted'
      threadId: string
      turnCount: number
      revertedAt: string
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.created'
      threadId: string
      projectId: string
      title: string
      cwd?: string
      branch?: string
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.renamed'
      threadId: string
      title: string
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.archived'
      threadId: string
      createdAt: string
    })
  | (OrchestrationEventMeta & {
      sequence: number
      type: 'thread.deleted'
      threadId: string
      createdAt: string
    })

export type OrchestrationThreadStreamItem =
  | {
      kind: 'snapshot'
      snapshot: {
        snapshotSequence: number
        thread: OrchestrationThread
      }
    }
  | {
      kind: 'event'
      event: OrchestrationEvent
    }

export type ClientOrchestrationCommand =
  | {
      type: 'thread.turn.start'
      commandId: string
      threadId: string
      provider: ProviderId
      input: string
      titleSeed?: string
      attachments?: ChatAttachment[]
      cwd?: string
      model?: string
      effort?: ReasoningEffort
      runtimeMode: RuntimeMode
      interactionMode: InteractionMode
      targetPlanId?: string
      createdAt: string
    }
  | {
      type: 'thread.session.stop'
      commandId: string
      threadId: string
      createdAt: string
    }
  | {
      type: 'thread.checkpoint.revert'
      commandId: string
      threadId: string
      turnCount: number
      createdAt: string
    }
  | {
      type: 'thread.checkpoint.commit'
      commandId: string
      threadId: string
      message: string
      createdAt: string
    }
  | {
      type: 'project.create'
      commandId: string
      projectId: string
      name: string
      path: string
      createdAt: string
    }
  | {
      type: 'project.delete'
      commandId: string
      projectId: string
      createdAt: string
    }
  | {
      type: 'thread.create'
      commandId: string
      threadId: string
      projectId: string
      title: string
      cwd?: string
      branch?: string
      createdAt: string
    }
  | {
      type: 'thread.rename'
      commandId: string
      threadId: string
      title: string
      createdAt: string
    }
  | {
      type: 'thread.archive'
      commandId: string
      threadId: string
      createdAt: string
    }
  | {
      type: 'thread.delete'
      commandId: string
      threadId: string
      createdAt: string
    }

export interface DispatchResult {
  accepted: boolean
  commandId: string
  threadId: string
  turnId?: string
}

export interface InterruptTurnInput {
  threadId: string
  turnId?: string
}

export interface RespondToApprovalInput {
  threadId: string
  requestId: string
  decision: ProviderApprovalDecision
}

export interface RespondToUserInputInput {
  threadId: string
  requestId: string
  answers: Record<string, unknown>
}

export interface StopSessionInput {
  threadId: string
}

export interface OpenWorkspaceFolderResult {
  path: string
  name: string
}

export interface ModelInfo {
  id: string
  name?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  /** App-level provider (codex vs opencode). */
  providerId?: ProviderId
  /** For OpenCode: upstream id from the model slug (e.g. anthropic in anthropic/claude-3). */
  upstreamVendor?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: ReasoningEffort
    description?: string
  }>
  defaultReasoningEffort?: ReasoningEffort
  /**
   * OpenCode: maps composer `reasoningEffort` (derived from each `Model.variants` **key**) to the
   * exact `variant` string passed to the SDK (same key string OpenCode expects).
   */
  openCodeVariantByEffort?: Partial<Record<ReasoningEffort, string>>
}

export interface ModelCatalog {
  providers: ProviderSummary[]
  modelsByProvider: Partial<Record<ProviderId, ModelInfo[]>>
}

export interface ProjectSummary {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface ThreadShellSummary {
  id: string
  projectId: string
  title: string
  cwd?: string
  branch: string
  latestTurnId: string | null
  sessionStatus: OrchestrationSession['status']
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface OrchestrationShellSnapshot {
  projects: ProjectSummary[]
  threads: ThreadShellSummary[]
}

export type OrchestrationShellEvent =
  | { type: 'shell.project-upserted'; project: ProjectSummary }
  | { type: 'shell.project-removed'; projectId: string }
  | { type: 'shell.thread-upserted'; thread: ThreadShellSummary }
  | { type: 'shell.thread-removed'; threadId: string }

export type OrchestrationShellStreamItem =
  | { kind: 'snapshot'; snapshot: OrchestrationShellSnapshot }
  | { kind: 'event'; event: OrchestrationShellEvent }

export interface AgentApi {
  dispatchCommand(input: ClientOrchestrationCommand): Promise<DispatchResult>
  subscribeThread(
    input: { threadId: string },
    listener: (item: OrchestrationThreadStreamItem) => void
  ): () => void
  subscribeShell(listener: (item: OrchestrationShellStreamItem) => void): () => void
  getShellSnapshot(): Promise<OrchestrationShellSnapshot>
  interruptTurn(input: InterruptTurnInput): Promise<void>
  respondToApproval(input: RespondToApprovalInput): Promise<void>
  respondToUserInput(input: RespondToUserInputInput): Promise<void>
  stopSession(input: StopSessionInput): Promise<void>
  listProviders(): Promise<ProviderSummary[]>
  listModelCatalog(): Promise<ModelCatalog>
  clearThread(input: { threadId: string }): Promise<void>
  getCheckpointDiff(input: CheckpointDiffRequest): Promise<CheckpointDiffResult>
  getCheckpointWorktreeDiff(
    input: CheckpointWorktreeDiffRequest
  ): Promise<CheckpointWorktreeDiffResult>
  openWorkspaceFolder(): Promise<OpenWorkspaceFolderResult | null>
  revealPath(input: { path: string }): Promise<void>
}

export const DEFAULT_THREAD_ID = 'local:main'

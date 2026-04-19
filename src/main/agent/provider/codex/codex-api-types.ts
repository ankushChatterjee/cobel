/**
 * Codex app-server TypeScript API types.
 * Generated from: codex app-server generate-ts --out DIR
 * These types reflect the exact wire format used by the Codex JSON-RPC protocol.
 */

// ─── Status enums ────────────────────────────────────────────────────────────

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'
export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined'
export type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined'
export type McpToolCallStatus = 'inProgress' | 'completed' | 'failed'
export type DynamicToolCallStatus = 'inProgress' | 'completed' | 'failed'
export type CommandExecutionSource =
  | 'agent'
  | 'userShell'
  | 'unifiedExecStartup'
  | 'unifiedExecInteraction'

// ─── Sub-types ───────────────────────────────────────────────────────────────

export interface FileUpdateChange {
  path: string
  kind: 'create' | 'edit' | 'delete'
  diff: string
}

export interface CommandAction {
  command?: string
  path?: string
  type?: string
}

// ─── ThreadItem — the full tagged union from the generated schema ─────────────

export type ThreadItem =
  | { type: 'userMessage'; id: string; content: unknown[] }
  | {
      type: 'agentMessage'
      id: string
      text: string
      phase: string | null
      memoryCitation: unknown | null
    }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution'
      id: string
      /** Full command string (e.g. "ls -la /tmp") */
      command: string
      cwd: string
      processId: string | null
      source: CommandExecutionSource
      status: CommandExecutionStatus
      commandActions: CommandAction[]
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | {
      type: 'fileChange'
      id: string
      changes: FileUpdateChange[]
      status: PatchApplyStatus
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: McpToolCallStatus
      arguments: unknown
      result: unknown | null
      error: unknown | null
      durationMs: number | null
    }
  | {
      type: 'dynamicToolCall'
      id: string
      tool: string
      arguments: unknown
      status: DynamicToolCallStatus
      contentItems: unknown[] | null
      success: boolean | null
      durationMs: number | null
    }
  | { type: 'webSearch'; id: string; query: string; action: unknown | null }
  | { type: 'imageView'; id: string; path: string }
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string }
  | {
      type: 'collabAgentToolCall'
      id: string
      tool: string
      status: string
      senderThreadId: string
    }

// ─── Turn ────────────────────────────────────────────────────────────────────

export interface TurnError {
  message: string
  codexErrorInfo?: unknown
  additionalDetails?: unknown
}

export interface Turn {
  id: string
  items: ThreadItem[]
  status: TurnStatus
  error: TurnError | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface TurnStartedNotification {
  threadId: string
  turn: Turn
}

export interface TurnCompletedNotification {
  threadId: string
  turn: Turn
}

export interface ItemStartedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface ItemCompletedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface AgentMessageDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface CommandExecutionOutputDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ReasoningSummaryTextDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
  summaryIndex: number
}

export interface ReasoningTextDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
  contentIndex: number
}

export interface FileChangeOutputDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface PlanDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ServerRequestResolvedNotification {
  threadId: string
  requestId: string
}

// ─── Server Requests ─────────────────────────────────────────────────────────

export interface CommandExecutionRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  approvalId?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
  commandActions?: CommandAction[] | null
  availableDecisions?: string[] | null
}

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
}

export interface ToolRequestUserInputQuestion {
  id: string
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
}

export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  questions: ToolRequestUserInputQuestion[]
}

// ─── Responses ───────────────────────────────────────────────────────────────

export interface TurnStartResponse {
  turn: Turn
}

export interface ThreadStartResponse {
  thread: { id: string; preview: string; modelProvider: string; createdAt: number }
}

export interface ThreadResumeResponse {
  thread: { id: string }
}

export interface ModelInfo {
  id: string
  name?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
}

export interface ModelListResponse {
  models?: ModelInfo[]
  data?: Array<
    ModelInfo & {
      model?: string
      displayName?: string
    }
  >
}

import type { Database } from 'better-sqlite3'
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationLatestTurn,
  OrchestrationCheckpointSummary
} from '../../../shared/agent'
import type { ProjectSummary, ThreadShellSummary } from '../../../shared/agent'

interface MessageRow {
  message_id: string
  thread_id: string
  turn_id: string | null
  role: string
  text: string
  attachments_json: string | null
  is_streaming: number
  sequence: number | null
  created_at: string
  updated_at: string
}

interface ActivityRow {
  activity_id: string
  thread_id: string
  kind: string
  tone: string
  summary: string
  payload_json: string | null
  turn_id: string | null
  sequence: number | null
  resolved: number
  created_at: string
}

interface PlanRow {
  plan_id: string
  thread_id: string
  turn_id: string
  text: string
  status: string
  created_at: string
  updated_at: string
}

interface SessionRow {
  thread_id: string
  status: string
  provider_name: string
  runtime_mode: string
  interaction_mode: string
  effort: string | null
  active_turn_id: string | null
  active_plan_id: string | null
  last_error: string | null
  updated_at: string
}

interface LatestTurnRow {
  thread_id: string
  turn_id: string
  status: string
  started_at: string
  completed_at: string | null
}

interface CheckpointRow {
  checkpoint_id: string
  thread_id: string
  turn_id: string
  assistant_message_id: string | null
  checkpoint_turn_count: number
  status: string
  files_json: string
  completed_at: string
  error_message: string | null
}

interface ThreadRow {
  thread_id: string
  project_id: string
  title: string
  cwd: string | null
  branch: string | null
  latest_turn_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  deleted_at: string | null
}

interface ProjectRow {
  project_id: string
  name: string
  path: string
  created_at: string
  updated_at: string
  archived_at: string | null
  deleted_at: string | null
}

export class SnapshotQuery {
  constructor(private readonly db: Database) {}

  getShellSnapshot(): { projects: ProjectSummary[]; threads: ThreadShellSummary[] } {
    const projects = (
      this.db
        .prepare(
          `SELECT * FROM projection_projects WHERE deleted_at IS NULL ORDER BY created_at ASC`
        )
        .all() as ProjectRow[]
    ).map(projectRowToSummary)

    const threads = (
      this.db
        .prepare(
          `SELECT t.thread_id, t.project_id, t.title, t.cwd, t.branch, t.latest_turn_id, t.created_at, t.updated_at, t.archived_at, t.deleted_at,
                  s.status AS session_status
           FROM projection_threads t
           LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
           WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC`
        )
        .all() as Array<ThreadRow & { session_status?: string }>
    ).map(threadRowToShellSummary)

    return { projects, threads }
  }

  getThreadDetail(threadId: string): OrchestrationThread | null {
    const threadRow = this.db
      .prepare(`SELECT * FROM projection_threads WHERE thread_id = ? AND deleted_at IS NULL`)
      .get(threadId) as ThreadRow | undefined

    if (!threadRow) return null

    const messages = (
      this.db
        .prepare(
          `SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY sequence ASC, created_at ASC`
        )
        .all(threadId) as MessageRow[]
    ).map(messageRowToMessage)

    const activities = (
      this.db
        .prepare(
          `SELECT * FROM projection_thread_activities WHERE thread_id = ? ORDER BY sequence ASC, created_at ASC`
        )
        .all(threadId) as ActivityRow[]
    ).map(activityRowToActivity)

    const proposedPlans = (
      this.db
        .prepare(
          `SELECT * FROM projection_thread_proposed_plans WHERE thread_id = ? ORDER BY created_at ASC`
        )
        .all(threadId) as PlanRow[]
    ).map(planRowToPlan)

    const sessionRow = this.db
      .prepare(`SELECT * FROM projection_thread_sessions WHERE thread_id = ?`)
      .get(threadId) as SessionRow | undefined

    const latestTurnRow = this.db
      .prepare(`SELECT * FROM projection_latest_turns WHERE thread_id = ?`)
      .get(threadId) as LatestTurnRow | undefined

    const session: OrchestrationSession | null = sessionRow ? sessionRowToSession(sessionRow) : null

    const latestTurn: OrchestrationLatestTurn | null = latestTurnRow
      ? latestTurnRowToTurn(latestTurnRow)
      : null

    const checkpoints = (
      this.db
        .prepare(
          `SELECT * FROM projection_thread_checkpoints WHERE thread_id = ? ORDER BY checkpoint_turn_count ASC`
        )
        .all(threadId) as CheckpointRow[]
    ).map(checkpointRowToCheckpoint)

    return {
      id: threadRow.thread_id,
      title: threadRow.title,
      cwd: threadRow.cwd ?? undefined,
      branch: threadRow.branch ?? 'main',
      messages,
      activities,
      proposedPlans,
      session,
      latestTurn,
      checkpoints,
      createdAt: threadRow.created_at,
      updatedAt: threadRow.updated_at,
      archivedAt: threadRow.archived_at ?? null
    }
  }
}

function projectRowToSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.project_id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null
  }
}

function threadRowToShellSummary(row: ThreadRow & { session_status?: string }): ThreadShellSummary {
  return {
    id: row.thread_id,
    projectId: row.project_id,
    title: row.title,
    cwd: row.cwd ?? undefined,
    branch: row.branch ?? 'main',
    latestTurnId: row.latest_turn_id ?? null,
    sessionStatus: (row.session_status ?? 'idle') as OrchestrationSession['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null
  }
}

function messageRowToMessage(row: MessageRow): OrchestrationMessage {
  return {
    id: row.message_id,
    role: row.role as 'user' | 'assistant' | 'system',
    text: row.text,
    attachments: row.attachments_json ? tryParse(row.attachments_json) : undefined,
    turnId: row.turn_id ?? null,
    streaming: row.is_streaming === 1,
    sequence: row.sequence ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function activityRowToActivity(row: ActivityRow): OrchestrationThreadActivity {
  return {
    id: row.activity_id,
    kind: row.kind as OrchestrationThreadActivity['kind'],
    tone: row.tone as OrchestrationThreadActivity['tone'],
    summary: row.summary,
    payload: row.payload_json ? tryParse(row.payload_json) : undefined,
    turnId: row.turn_id ?? null,
    sequence: row.sequence ?? undefined,
    resolved: row.resolved === 1,
    createdAt: row.created_at
  }
}

function planRowToPlan(row: PlanRow): OrchestrationProposedPlan {
  return {
    id: row.plan_id,
    turnId: row.turn_id,
    text: row.text,
    status: row.status as OrchestrationProposedPlan['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function sessionRowToSession(row: SessionRow): OrchestrationSession {
  return {
    threadId: row.thread_id,
    status: row.status as OrchestrationSession['status'],
    providerName: (row.provider_name as 'codex') ?? null,
    runtimeMode: row.runtime_mode as OrchestrationSession['runtimeMode'],
    interactionMode: row.interaction_mode as OrchestrationSession['interactionMode'],
    effort: (row.effort as OrchestrationSession['effort']) ?? undefined,
    activeTurnId: row.active_turn_id ?? null,
    activePlanId: row.active_plan_id ?? null,
    lastError: row.last_error ?? null,
    updatedAt: row.updated_at
  }
}

function latestTurnRowToTurn(row: LatestTurnRow): OrchestrationLatestTurn {
  return {
    id: row.turn_id,
    status: row.status as OrchestrationLatestTurn['status'],
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null
  }
}

function checkpointRowToCheckpoint(row: CheckpointRow): OrchestrationCheckpointSummary {
  return {
    id: row.checkpoint_id,
    turnId: row.turn_id,
    assistantMessageId: row.assistant_message_id ?? undefined,
    checkpointTurnCount: row.checkpoint_turn_count,
    status: row.status as OrchestrationCheckpointSummary['status'],
    files: row.files_json ? tryParse(row.files_json) : [],
    completedAt: row.completed_at,
    errorMessage: row.error_message ?? undefined
  }
}

function tryParse<T>(json: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return {} as T
  }
}

import type { Database } from 'better-sqlite3'
import type { StoredOrchestrationEvent } from './OrchestrationEventStore'
import type { OrchestrationEventStore } from './OrchestrationEventStore'
import { DEFAULT_THREAD_TITLE } from '../../../shared/threadTitle'

interface ProjectionStateRow {
  projector: string
  last_applied_sequence: number
  updated_at: string
}

type KnownEvent = StoredOrchestrationEvent & { payload: Record<string, unknown> }

export class ProjectionPipeline {
  private readonly getCursor: ReturnType<Database['prepare']>
  private readonly upsertCursor: ReturnType<Database['prepare']>

  constructor(
    private readonly db: Database,
    private readonly eventStore: OrchestrationEventStore
  ) {
    this.getCursor = db.prepare(
      'SELECT last_applied_sequence FROM projection_state WHERE projector = ?'
    )
    this.upsertCursor = db.prepare(`
      INSERT INTO projection_state(projector, last_applied_sequence, updated_at)
      VALUES(@projector, @seq, @now)
      ON CONFLICT(projector) DO UPDATE SET last_applied_sequence = @seq, updated_at = @now
    `)
  }

  bootstrap(): void {
    const cursor = this.getLastAppliedSequence()
    const missed = this.eventStore.readAfter(cursor)
    if (missed.length === 0) return
    this.db.transaction(() => {
      for (const event of missed) {
        this.applyInternal(event)
      }
      const last = missed[missed.length - 1]
      if (last?.sequence !== undefined) this.saveSequence(last.sequence)
    })()
  }

  apply(event: StoredOrchestrationEvent): void {
    this.applyInternal(event)
    if (event.sequence !== undefined) this.saveSequence(event.sequence)
  }

  private applyInternal(event: StoredOrchestrationEvent): void {
    const payload = asRecord(event.payload)
    const e: KnownEvent = { ...event, payload }

    switch (event.eventType) {
      case 'project.created':
        this.upsertProject(e)
        break
      case 'project.deleted':
        this.softDeleteProject(e)
        break
      case 'thread.created':
        this.upsertThread(e)
        break
      case 'thread.renamed':
        this.updateThreadTitle(e)
        break
      case 'thread.archived':
        this.archiveThread(e)
        break
      case 'thread.deleted':
        this.softDeleteThread(e)
        break
      case 'thread.snapshot.changed':
        this.applySnapshot(e)
        break
      case 'thread.session-set':
        this.applySessionSet(e)
        break
      case 'thread.message-upserted':
        this.applyMessageUpserted(e)
        break
      case 'thread.activity-upserted':
        this.applyActivityUpserted(e)
        break
      case 'thread.proposed-plan-upserted':
        this.applyProposedPlanUpserted(e)
        break
      case 'thread.latest-turn-set':
        this.applyLatestTurnSet(e)
        break
      case 'thread.turn-diff-completed':
        this.applyCheckpointUpserted(e)
        break
      case 'thread.reverted':
        this.applyThreadReverted(e)
        break
      default:
        break
    }
  }

  private upsertProject(e: KnownEvent): void {
    this.db
      .prepare(
        `
        INSERT INTO projection_projects(project_id, name, path, created_at, updated_at)
        VALUES(@project_id, @name, @path, @created_at, @updated_at)
        ON CONFLICT(project_id) DO UPDATE SET
          name = @name, path = @path, updated_at = @updated_at, deleted_at = NULL, archived_at = NULL
      `
      )
      .run({
        project_id: str(e.payload['projectId']) ?? e.streamId,
        name: str(e.payload['name']) ?? 'Project',
        path: str(e.payload['path']) ?? '',
        created_at: e.occurredAt,
        updated_at: e.occurredAt
      })
  }

  private softDeleteProject(e: KnownEvent): void {
    this.db
      .prepare(`UPDATE projection_projects SET deleted_at = ? WHERE project_id = ?`)
      .run(e.occurredAt, str(e.payload['projectId']) ?? e.streamId)
  }

  private upsertThread(e: KnownEvent): void {
    this.db
      .prepare(
        `
        INSERT INTO projection_threads(thread_id, project_id, title, cwd, branch, created_at, updated_at)
        VALUES(@thread_id, @project_id, @title, @cwd, @branch, @created_at, @updated_at)
        ON CONFLICT(thread_id) DO UPDATE SET
          title = @title, cwd = @cwd, updated_at = @updated_at, deleted_at = NULL, archived_at = NULL
      `
      )
      .run({
        thread_id: str(e.payload['threadId']) ?? e.streamId,
        project_id: str(e.payload['projectId']) ?? '',
        title: str(e.payload['title']) ?? DEFAULT_THREAD_TITLE,
        cwd: str(e.payload['cwd']) ?? null,
        branch: str(e.payload['branch']) ?? 'main',
        created_at: e.occurredAt,
        updated_at: e.occurredAt
      })
  }

  private updateThreadTitle(e: KnownEvent): void {
    this.db
      .prepare(`UPDATE projection_threads SET title = ?, updated_at = ? WHERE thread_id = ?`)
      .run(str(e.payload['title']) ?? '', e.occurredAt, e.streamId)
  }

  private archiveThread(e: KnownEvent): void {
    this.db
      .prepare(`UPDATE projection_threads SET archived_at = ?, updated_at = ? WHERE thread_id = ?`)
      .run(e.occurredAt, e.occurredAt, e.streamId)
  }

  private softDeleteThread(e: KnownEvent): void {
    this.db
      .prepare(`UPDATE projection_threads SET deleted_at = ?, updated_at = ? WHERE thread_id = ?`)
      .run(e.occurredAt, e.occurredAt, e.streamId)
  }

  private applySnapshot(e: KnownEvent): void {
    const thread = e.payload['thread']
    if (!thread || typeof thread !== 'object') return
    const t = thread as Record<string, unknown>
    this.db
      .prepare(
        `
        UPDATE projection_threads
        SET title = ?, cwd = ?, branch = ?, updated_at = ?
        WHERE thread_id = ?
      `
      )
      .run(
        str(t['title']) ?? DEFAULT_THREAD_TITLE,
        str(t['cwd']) ?? null,
        str(t['branch']) ?? 'main',
        e.occurredAt,
        e.streamId
      )
  }

  private applySessionSet(e: KnownEvent): void {
    const session = asRecord(e.payload['session'])
    this.db
      .prepare(
        `
        INSERT INTO projection_thread_sessions(thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at)
        VALUES(@thread_id, @status, @provider_name, @runtime_mode, @active_turn_id, @last_error, @updated_at)
        ON CONFLICT(thread_id) DO UPDATE SET
          status = @status,
          provider_name = @provider_name,
          runtime_mode = @runtime_mode,
          active_turn_id = @active_turn_id,
          last_error = @last_error,
          updated_at = @updated_at
      `
      )
      .run({
        thread_id: e.streamId,
        status: str(session['status']) ?? str(e.payload['status']) ?? 'idle',
        provider_name: str(session['providerName']) ?? str(e.payload['providerName']) ?? 'codex',
        runtime_mode:
          str(session['runtimeMode']) ?? str(e.payload['runtimeMode']) ?? 'auto-accept-edits',
        active_turn_id: str(session['activeTurnId']) ?? str(e.payload['activeTurnId']) ?? null,
        last_error: str(session['lastError']) ?? str(e.payload['lastError']) ?? null,
        updated_at: e.occurredAt
      })
    this.db
      .prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`)
      .run(e.occurredAt, e.streamId)
  }

  private applyMessageUpserted(e: KnownEvent): void {
    const message = asRecord(e.payload['message'])
    const messageId = str(message['id'])
    if (!messageId) return
    this.db
      .prepare(
        `
        INSERT INTO projection_thread_messages(message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, sequence, created_at, updated_at)
        VALUES(@message_id, @thread_id, @turn_id, @role, @text, @attachments_json, @is_streaming, @sequence, @created_at, @updated_at)
        ON CONFLICT(message_id) DO UPDATE SET
          text = @text,
          is_streaming = @is_streaming,
          attachments_json = @attachments_json,
          sequence = @sequence,
          updated_at = @updated_at
      `
      )
      .run({
        message_id: messageId,
        thread_id: e.streamId,
        turn_id: str(message['turnId']) ?? null,
        role: str(message['role']) ?? 'user',
        text: str(message['text']) ?? '',
        attachments_json: message['attachments'] ? JSON.stringify(message['attachments']) : null,
        is_streaming: message['streaming'] ? 1 : 0,
        sequence: typeof message['sequence'] === 'number' ? message['sequence'] : null,
        created_at: str(message['createdAt']) ?? e.occurredAt,
        updated_at: str(message['updatedAt']) ?? e.occurredAt
      })
    this.db
      .prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`)
      .run(e.occurredAt, e.streamId)
  }

  private applyActivityUpserted(e: KnownEvent): void {
    const activity = asRecord(e.payload['activity'])
    const activityId = str(activity['id'])
    if (!activityId) return
    this.db
      .prepare(
        `
        INSERT INTO projection_thread_activities(activity_id, thread_id, kind, tone, summary, payload_json, turn_id, sequence, resolved, created_at)
        VALUES(@activity_id, @thread_id, @kind, @tone, @summary, @payload_json, @turn_id, @sequence, @resolved, @created_at)
        ON CONFLICT(activity_id) DO UPDATE SET
          kind = @kind,
          tone = @tone,
          summary = @summary,
          payload_json = @payload_json,
          turn_id = @turn_id,
          sequence = @sequence,
          resolved = @resolved
      `
      )
      .run({
        activity_id: activityId,
        thread_id: e.streamId,
        kind: str(activity['kind']) ?? 'tool.started',
        tone: str(activity['tone']) ?? 'tool',
        summary: str(activity['summary']) ?? '',
        payload_json: activity['payload'] ? JSON.stringify(activity['payload']) : null,
        turn_id: str(activity['turnId']) ?? null,
        sequence: typeof activity['sequence'] === 'number' ? activity['sequence'] : null,
        resolved: activity['resolved'] ? 1 : 0,
        created_at: str(activity['createdAt']) ?? e.occurredAt
      })
  }

  private applyProposedPlanUpserted(e: KnownEvent): void {
    const plan = asRecord(e.payload['proposedPlan'])
    const planId = str(plan['id'])
    if (!planId) return
    this.db
      .prepare(
        `
        INSERT INTO projection_thread_proposed_plans(plan_id, thread_id, turn_id, text, status, created_at, updated_at)
        VALUES(@plan_id, @thread_id, @turn_id, @text, @status, @created_at, @updated_at)
        ON CONFLICT(plan_id) DO UPDATE SET
          text = @text, status = @status, updated_at = @updated_at
      `
      )
      .run({
        plan_id: planId,
        thread_id: e.streamId,
        turn_id: str(plan['turnId']) ?? '',
        text: str(plan['text']) ?? '',
        status: str(plan['status']) ?? 'proposed',
        created_at: str(plan['createdAt']) ?? e.occurredAt,
        updated_at: str(plan['updatedAt']) ?? e.occurredAt
      })
  }

  private applyLatestTurnSet(e: KnownEvent): void {
    const latestTurn = e.payload['latestTurn']
    if (!latestTurn || typeof latestTurn !== 'object') {
      this.db.prepare(`DELETE FROM projection_latest_turns WHERE thread_id = ?`).run(e.streamId)
      return
    }
    const turn = latestTurn as Record<string, unknown>
    const turnId = str(turn['id'])
    if (!turnId) return
    this.db
      .prepare(
        `
        INSERT INTO projection_latest_turns(thread_id, turn_id, status, started_at, completed_at)
        VALUES(@thread_id, @turn_id, @status, @started_at, @completed_at)
        ON CONFLICT(thread_id) DO UPDATE SET
          turn_id = @turn_id, status = @status, started_at = @started_at, completed_at = @completed_at
      `
      )
      .run({
        thread_id: e.streamId,
        turn_id: turnId,
        status: str(turn['status']) ?? 'running',
        started_at: str(turn['startedAt']) ?? e.occurredAt,
        completed_at: str(turn['completedAt']) ?? null
      })
    this.db
      .prepare(
        `UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?`
      )
      .run(turnId, e.occurredAt, e.streamId)
  }

  private applyCheckpointUpserted(e: KnownEvent): void {
    const checkpoint = asRecord(e.payload['checkpoint'])
    const checkpointId = str(checkpoint['id'])
    const turnId = str(checkpoint['turnId'])
    if (!checkpointId || !turnId) return

    const incomingStatus = str(checkpoint['status']) ?? 'missing'
    const existing = this.db
      .prepare(
        `SELECT status FROM projection_thread_checkpoints WHERE thread_id = ? AND turn_id = ?`
      )
      .get(e.streamId, turnId) as { status: string } | undefined
    if (existing && existing.status !== 'missing' && incomingStatus === 'missing') return

    const completedAt = str(checkpoint['completedAt']) ?? e.occurredAt
    this.db
      .prepare(
        `
        INSERT INTO projection_thread_checkpoints(checkpoint_id, thread_id, turn_id, assistant_message_id, checkpoint_turn_count, status, files_json, completed_at, error_message)
        VALUES(@checkpoint_id, @thread_id, @turn_id, @assistant_message_id, @checkpoint_turn_count, @status, @files_json, @completed_at, @error_message)
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
          checkpoint_id = @checkpoint_id,
          assistant_message_id = @assistant_message_id,
          checkpoint_turn_count = @checkpoint_turn_count,
          status = @status,
          files_json = @files_json,
          completed_at = @completed_at,
          error_message = @error_message
      `
      )
      .run({
        checkpoint_id: checkpointId,
        thread_id: e.streamId,
        turn_id: turnId,
        assistant_message_id: str(checkpoint['assistantMessageId']) ?? null,
        checkpoint_turn_count:
          typeof checkpoint['checkpointTurnCount'] === 'number'
            ? checkpoint['checkpointTurnCount']
            : 0,
        status: incomingStatus,
        files_json: JSON.stringify(Array.isArray(checkpoint['files']) ? checkpoint['files'] : []),
        completed_at: completedAt,
        error_message: str(checkpoint['errorMessage']) ?? null
      })
    this.db
      .prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`)
      .run(completedAt, e.streamId)
  }

  private applyThreadReverted(e: KnownEvent): void {
    const turnCount =
      typeof e.payload['turnCount'] === 'number'
        ? e.payload['turnCount']
        : Number(e.payload['turnCount'])
    if (!Number.isFinite(turnCount)) return

    const retainedRows = this.db
      .prepare(
        `SELECT turn_id FROM projection_thread_checkpoints WHERE thread_id = ? AND checkpoint_turn_count <= ?`
      )
      .all(e.streamId, turnCount) as Array<{ turn_id: string }>
    const retainedTurnIds = retainedRows.map((row) => row.turn_id).filter(Boolean)
    const placeholders = retainedTurnIds.map(() => '?').join(',')
    const notInClause = retainedTurnIds.length > 0 ? `AND turn_id NOT IN (${placeholders})` : ''
    const args = [e.streamId, ...retainedTurnIds]

    this.db
      .prepare(
        `DELETE FROM projection_thread_messages WHERE thread_id = ? AND turn_id IS NOT NULL ${notInClause}`
      )
      .run(...args)
    this.db
      .prepare(
        `DELETE FROM projection_thread_activities WHERE thread_id = ? AND turn_id IS NOT NULL ${notInClause}`
      )
      .run(...args)
    this.db
      .prepare(
        `DELETE FROM projection_thread_proposed_plans WHERE thread_id = ? AND turn_id IS NOT NULL ${notInClause}`
      )
      .run(...args)
    this.db
      .prepare(
        `DELETE FROM projection_thread_checkpoints WHERE thread_id = ? AND checkpoint_turn_count > ?`
      )
      .run(e.streamId, turnCount)

    const latest = this.db
      .prepare(
        `SELECT turn_id, status, completed_at FROM projection_thread_checkpoints WHERE thread_id = ? ORDER BY checkpoint_turn_count DESC LIMIT 1`
      )
      .get(e.streamId) as { turn_id: string; status: string; completed_at: string } | undefined
    if (latest) {
      this.db
        .prepare(
          `
          INSERT INTO projection_latest_turns(thread_id, turn_id, status, started_at, completed_at)
          VALUES(@thread_id, @turn_id, @status, @started_at, @completed_at)
          ON CONFLICT(thread_id) DO UPDATE SET
            turn_id = @turn_id, status = @status, started_at = @started_at, completed_at = @completed_at
        `
        )
        .run({
          thread_id: e.streamId,
          turn_id: latest.turn_id,
          status: latest.status === 'error' ? 'failed' : 'completed',
          started_at: latest.completed_at,
          completed_at: latest.completed_at
        })
      this.db
        .prepare(`UPDATE projection_threads SET latest_turn_id = ? WHERE thread_id = ?`)
        .run(latest.turn_id, e.streamId)
    } else {
      this.db.prepare(`DELETE FROM projection_latest_turns WHERE thread_id = ?`).run(e.streamId)
      this.db
        .prepare(`UPDATE projection_threads SET latest_turn_id = NULL WHERE thread_id = ?`)
        .run(e.streamId)
    }

    this.db
      .prepare(
        `UPDATE projection_thread_sessions SET status = 'ready', active_turn_id = NULL, updated_at = ? WHERE thread_id = ?`
      )
      .run(e.occurredAt, e.streamId)
    this.db
      .prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`)
      .run(e.occurredAt, e.streamId)
  }

  private getLastAppliedSequence(): number {
    const row = this.getCursor.get('main') as ProjectionStateRow | undefined
    return row?.last_applied_sequence ?? 0
  }

  private saveSequence(sequence: number): void {
    this.upsertCursor.run({ projector: 'main', seq: sequence, now: new Date().toISOString() })
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

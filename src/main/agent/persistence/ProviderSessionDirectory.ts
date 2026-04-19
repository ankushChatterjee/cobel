import type { Database } from 'better-sqlite3'
import type { ProviderId, RuntimeMode } from '../../../shared/agent'

export interface ProviderSessionBinding {
  provider: ProviderId
  runtimeMode: RuntimeMode
  status: string
  resumeCursor?: unknown
  runtimePayload?: unknown
}

interface ProviderSessionRuntimeRow {
  thread_id: string
  provider_name: string
  runtime_mode: string
  status: string
  last_seen_at: string
  resume_cursor_json: string | null
  runtime_payload_json: string | null
}

export class ProviderSessionDirectory {
  private readonly upsertRow: ReturnType<Database['prepare']>
  private readonly selectRow: ReturnType<Database['prepare']>
  private readonly deleteRow: ReturnType<Database['prepare']>

  constructor(db: Database) {
    this.upsertRow = db.prepare(`
      INSERT INTO provider_session_runtime(thread_id, provider_name, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
      VALUES(@thread_id, @provider_name, @runtime_mode, @status, @last_seen_at, @resume_cursor_json, @runtime_payload_json)
      ON CONFLICT(thread_id) DO UPDATE SET
        provider_name = @provider_name,
        runtime_mode = @runtime_mode,
        status = @status,
        last_seen_at = @last_seen_at,
        resume_cursor_json = @resume_cursor_json,
        runtime_payload_json = @runtime_payload_json
    `)
    this.selectRow = db.prepare(
      `SELECT * FROM provider_session_runtime WHERE thread_id = ?`
    )
    this.deleteRow = db.prepare(
      `DELETE FROM provider_session_runtime WHERE thread_id = ?`
    )
  }

  get(threadId: string): ProviderSessionBinding | null {
    const row = this.selectRow.get(threadId) as ProviderSessionRuntimeRow | undefined
    if (!row) return null
    return {
      provider: row.provider_name as ProviderId,
      runtimeMode: row.runtime_mode as RuntimeMode,
      status: row.status,
      resumeCursor: row.resume_cursor_json ? tryParse(row.resume_cursor_json) : undefined,
      runtimePayload: row.runtime_payload_json ? tryParse(row.runtime_payload_json) : undefined
    }
  }

  getResumeCursor(threadId: string): unknown {
    return this.get(threadId)?.resumeCursor ?? undefined
  }

  upsert(
    threadId: string,
    binding: ProviderSessionBinding
  ): void {
    this.upsertRow.run({
      thread_id: threadId,
      provider_name: binding.provider,
      runtime_mode: binding.runtimeMode,
      status: binding.status,
      last_seen_at: new Date().toISOString(),
      resume_cursor_json: binding.resumeCursor !== undefined ? JSON.stringify(binding.resumeCursor) : null,
      runtime_payload_json: binding.runtimePayload !== undefined ? JSON.stringify(binding.runtimePayload) : null
    })
  }

  clear(threadId: string): void {
    this.deleteRow.run(threadId)
  }
}

function tryParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

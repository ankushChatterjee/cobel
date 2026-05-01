import type { Database } from 'better-sqlite3'

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001_bootstrap',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        correlation_id TEXT,
        actor_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_stream_version
        ON orchestration_events(aggregate_kind, stream_id, stream_version);

      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        accepted_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_state (
        projector TEXT PRIMARY KEY,
        last_applied_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        branch TEXT,
        latest_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
        ON projection_threads(project_id);

      CREATE TABLE IF NOT EXISTS projection_thread_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT,
        is_streaming INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_id
        ON projection_thread_messages(thread_id, sequence);

      CREATE TABLE IF NOT EXISTS projection_thread_activities (
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tone TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        turn_id TEXT,
        sequence INTEGER,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_id
        ON projection_thread_activities(thread_id, sequence);

      CREATE TABLE IF NOT EXISTS projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        runtime_mode TEXT NOT NULL,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
        plan_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_id
        ON projection_thread_proposed_plans(thread_id);

      CREATE TABLE IF NOT EXISTS projection_turns (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        state TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(thread_id, turn_id)
      );

      CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_id
        ON projection_turns(thread_id);

      CREATE TABLE IF NOT EXISTS projection_latest_turns (
        thread_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        runtime_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resume_cursor_json TEXT,
        runtime_payload_json TEXT
      );
    `
  },
  {
    name: '002_checkpoint_summaries',
    sql: `
      CREATE TABLE IF NOT EXISTS projection_thread_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        assistant_message_id TEXT,
        checkpoint_turn_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        files_json TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error_message TEXT,
        UNIQUE(thread_id, turn_id),
        UNIQUE(thread_id, checkpoint_turn_count)
      );

      CREATE INDEX IF NOT EXISTS idx_projection_thread_checkpoints_thread_id
        ON projection_thread_checkpoints(thread_id, checkpoint_turn_count);
    `
  },
  {
    name: '003_session_effort',
    sql: `
      ALTER TABLE projection_thread_sessions ADD COLUMN effort TEXT;
    `
  },
  {
    name: '004_interaction_mode',
    sql: `
      ALTER TABLE projection_thread_sessions ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE provider_session_runtime ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default';
    `
  },
  {
    name: '005_active_plan_id',
    sql: `
      ALTER TABLE projection_thread_sessions ADD COLUMN active_plan_id TEXT;
    `
  },
  {
    name: '006_session_model',
    sql: `
      ALTER TABLE projection_thread_sessions ADD COLUMN model TEXT;
    `
  },
  {
    name: '007_thread_todo_lists',
    sql: `
      CREATE TABLE IF NOT EXISTS projection_thread_todo_lists (
        todo_list_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT,
        explanation TEXT,
        items_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projection_thread_todo_lists_thread_id
        ON projection_thread_todo_lists(thread_id, updated_at);
    `
  }
]

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES(?,?)').run(
        migration.name,
        new Date().toISOString()
      )
    })()
  }
}

import type { Database } from 'better-sqlite3'

export interface StoredOrchestrationEvent {
  sequence?: number
  eventId: string
  aggregateKind: 'project' | 'thread'
  streamId: string
  streamVersion: number
  eventType: string
  occurredAt: string
  commandId?: string
  correlationId?: string
  actorKind: string
  payload: unknown
  metadata?: unknown
}

interface EventRow {
  sequence: number
  event_id: string
  aggregate_kind: string
  stream_id: string
  stream_version: number
  event_type: string
  occurred_at: string
  command_id: string | null
  correlation_id: string | null
  actor_kind: string
  payload_json: string
  metadata_json: string
}

interface CommandReceiptRow {
  command_id: string
  accepted_sequence: number
  created_at: string
}

export class OrchestrationEventStore {
  private readonly insertEvent: ReturnType<Database['prepare']>
  private readonly selectStreamVersion: ReturnType<Database['prepare']>
  private readonly selectAfter: ReturnType<Database['prepare']>
  private readonly insertReceipt: ReturnType<Database['prepare']>
  private readonly selectReceipt: ReturnType<Database['prepare']>

  constructor(private readonly db: Database) {
    this.insertEvent = db.prepare(`
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, correlation_id, actor_kind, payload_json, metadata_json)
      VALUES
        (@event_id, @aggregate_kind, @stream_id, @stream_version, @event_type, @occurred_at, @command_id, @correlation_id, @actor_kind, @payload_json, @metadata_json)
    `)
    this.selectStreamVersion = db.prepare(`
      SELECT COALESCE(MAX(stream_version), 0) AS v
      FROM orchestration_events
      WHERE aggregate_kind = @kind AND stream_id = @id
    `)
    this.selectAfter = db.prepare(`
      SELECT * FROM orchestration_events WHERE sequence > ? ORDER BY sequence ASC
    `)
    this.insertReceipt = db.prepare(`
      INSERT OR IGNORE INTO command_receipts(command_id, accepted_sequence, created_at)
      VALUES(@command_id, @accepted_sequence, @created_at)
    `)
    this.selectReceipt = db.prepare(`
      SELECT * FROM command_receipts WHERE command_id = ?
    `)
  }

  getStreamVersion(aggregateKind: 'project' | 'thread', streamId: string): number {
    const row = this.selectStreamVersion.get({ kind: aggregateKind, id: streamId }) as { v: number }
    return row.v
  }

  append(event: StoredOrchestrationEvent): number {
    const result = this.insertEvent.run({
      event_id: event.eventId,
      aggregate_kind: event.aggregateKind,
      stream_id: event.streamId,
      stream_version: event.streamVersion,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
      command_id: event.commandId ?? null,
      correlation_id: event.correlationId ?? null,
      actor_kind: event.actorKind,
      payload_json: JSON.stringify(event.payload),
      metadata_json: JSON.stringify(event.metadata ?? {})
    })
    return Number(result.lastInsertRowid)
  }

  appendBatch(events: StoredOrchestrationEvent[]): number[] {
    const sequences: number[] = []
    const txn = this.db.transaction(() => {
      for (const event of events) {
        sequences.push(this.append(event))
      }
    })
    txn()
    return sequences
  }

  readAfter(sequence: number): StoredOrchestrationEvent[] {
    const rows = this.selectAfter.all(sequence) as EventRow[]
    return rows.map(rowToEvent)
  }

  getCommandReceipt(commandId: string): { acceptedSequence: number; createdAt: string } | null {
    const row = this.selectReceipt.get(commandId) as CommandReceiptRow | undefined
    if (!row) return null
    return { acceptedSequence: row.accepted_sequence, createdAt: row.created_at }
  }

  writeCommandReceipt(commandId: string, acceptedSequence: number): void {
    this.insertReceipt.run({
      command_id: commandId,
      accepted_sequence: acceptedSequence,
      created_at: new Date().toISOString()
    })
  }
}

function rowToEvent(row: EventRow): StoredOrchestrationEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    aggregateKind: row.aggregate_kind as 'project' | 'thread',
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    commandId: row.command_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    actorKind: row.actor_kind,
    payload: tryParse(row.payload_json),
    metadata: tryParse(row.metadata_json)
  }
}

function tryParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

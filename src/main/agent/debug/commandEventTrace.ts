import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type TraceCandidate = {
  activityId?: string | null
  command?: string | null
  itemId?: string | null
  itemType?: string | null
  method?: string | null
  streamKind?: string | null
  summary?: string | null
  title?: string | null
}

const FILTER_IDS = new Set(
  (process.env.TRACE_COMMAND_EVENT_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)

const FILTER_TEXT = process.env.TRACE_COMMAND_EVENT_MATCH?.trim().toLowerCase() ?? ''

function traceEnabled(): boolean {
  const explicitPath = process.env.TRACE_COMMAND_EVENTS_PATH?.trim()
  if (explicitPath) return true
  const value = process.env.TRACE_COMMAND_EVENTS?.trim()
  if (!value) return false
  const lower = value.toLowerCase()
  return lower !== '0' && lower !== 'false' && lower !== 'no' && lower !== 'off'
}

function tracePath(): string {
  const explicit = process.env.TRACE_COMMAND_EVENTS_PATH?.trim()
  if (explicit) return explicit
  return join(tmpdir(), `gencode-command-events-${process.pid}.jsonl`)
}

export function shouldTraceCommandEvent(candidate: TraceCandidate): boolean {
  if (!traceEnabled()) return false

  const looksLikeCommand =
    candidate.itemType === 'command_execution' ||
    candidate.streamKind === 'command_output' ||
    candidate.method?.includes('commandExecution') === true

  if (!looksLikeCommand) return false

  if (FILTER_IDS.size > 0) {
    const ids = [candidate.itemId, candidate.activityId]
    if (!ids.some((value) => value && FILTER_IDS.has(value))) return false
  }

  if (FILTER_TEXT) {
    const haystacks = [
      candidate.title,
      candidate.summary,
      candidate.command,
      candidate.method,
      candidate.itemId,
      candidate.activityId
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase())
    if (!haystacks.some((value) => value.includes(FILTER_TEXT))) return false
  }

  return true
}

export function traceCommandEvent(stage: string, payload: TraceCandidate & Record<string, unknown>): void {
  if (!shouldTraceCommandEvent(payload)) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    stage,
    ...payload
  })
  void appendFile(tracePath(), `${line}\n`, 'utf8').catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[TRACE_COMMAND_EVENTS] append failed:', message)
  })
}

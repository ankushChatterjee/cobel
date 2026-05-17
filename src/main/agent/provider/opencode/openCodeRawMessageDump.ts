import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dumpWriteQueue = Promise.resolve()

/** Only the live subscribe path remains; adapter.dispatch was removed. */
export type OpenCodeRawDumpSource = 'sdk.subscribe'

function dumpOpenCodeMessagesEnabled(): boolean {
  const v = process.env.DUMP_OPENCODE_MESSAGES?.trim()
  if (!v) return false
  const lower = v.toLowerCase()
  if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false
  return true
}

function resolveDumpFilePath(): string {
  const explicit = process.env.DUMP_OPENCODE_MESSAGES_PATH?.trim()
  if (explicit) return explicit
  return join(tmpdir(), `gencode-opencode-raw-${process.pid}.jsonl`)
}

/**
 * Appends one line of JSON per OpenCode subscribe event.
 * Enabled when `DUMP_OPENCODE_MESSAGES` is set to a truthy value (e.g. `1`, `true`);
 * disabled for `0`, `false`, `no`, `off`. Optional `DUMP_OPENCODE_MESSAGES_PATH` overrides the output file.
 */
export function dumpOpenCodeRawMessage(
  raw: unknown,
  context: { threadId: string; source: OpenCodeRawDumpSource }
): void {
  if (!dumpOpenCodeMessagesEnabled()) return
  let serialized: string
  try {
    serialized = JSON.stringify({
      ts: new Date().toISOString(),
      threadId: context.threadId,
      source: context.source,
      raw
    })
  } catch {
    serialized = JSON.stringify({
      ts: new Date().toISOString(),
      threadId: context.threadId,
      source: context.source,
      raw: '[unserializable OpenCode event]'
    })
  }
  dumpWriteQueue = dumpWriteQueue
    .then(() => appendFile(resolveDumpFilePath(), `${serialized}\n`, 'utf8'))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[DUMP_OPENCODE_MESSAGES] append failed:', msg)
    })
}

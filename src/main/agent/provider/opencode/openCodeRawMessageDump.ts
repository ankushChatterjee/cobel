import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * Appends one line of JSON per raw OpenCode SDK event from `client.event.subscribe()`.
 * Enabled when `DUMP_OPENCODE_MESSAGES` is set to a truthy value (e.g. `1`, `true`);
 * disabled for `0`, `false`, `no`, `off`. Optional `DUMP_OPENCODE_MESSAGES_PATH` overrides the output file.
 */
export function dumpOpenCodeSubscribeRawMessage(raw: unknown, context: { threadId: string }): void {
  if (!dumpOpenCodeMessagesEnabled()) return
  let serialized: string
  try {
    serialized = JSON.stringify({
      ts: new Date().toISOString(),
      threadId: context.threadId,
      raw
    })
  } catch {
    serialized = JSON.stringify({
      ts: new Date().toISOString(),
      threadId: context.threadId,
      raw: '[unserializable OpenCode event]'
    })
  }
  void appendFile(resolveDumpFilePath(), `${serialized}\n`, 'utf8').catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DUMP_OPENCODE_MESSAGES] append failed:', msg)
  })
}

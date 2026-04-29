import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function dumpCodexMessagesEnabled(): boolean {
  const explicitPath = process.env.DUMP_CODEX_MESSAGES_PATH?.trim()
  if (explicitPath) return true
  const v = process.env.DUMP_CODEX_MESSAGES?.trim()
  if (!v) return false
  const lower = v.toLowerCase()
  if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false
  return true
}

function resolveDumpFilePath(): string {
  const explicit = process.env.DUMP_CODEX_MESSAGES_PATH?.trim()
  if (explicit) return explicit
  return join(tmpdir(), `gencode-codex-raw-${process.pid}.jsonl`)
}

/**
 * Appends one line of JSON per raw stdout line emitted by `codex app-server`.
 * Enabled when `DUMP_CODEX_MESSAGES` is truthy (for example `1`, `true`, `yes`, `on`).
 * `DUMP_CODEX_MESSAGES_PATH` alone also enables dumping and overrides the output file path.
 */
export function dumpCodexRawStdoutLine(line: string, context: { threadId: string }): void {
  if (!dumpCodexMessagesEnabled()) return
  let raw: unknown = line
  try {
    raw = JSON.parse(line)
  } catch {
    // Keep the original line when Codex emits non-JSON output unexpectedly.
  }

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
      raw: '[unserializable Codex event]'
    })
  }

  void appendFile(resolveDumpFilePath(), `${serialized}\n`, 'utf8').catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DUMP_CODEX_MESSAGES] append failed:', msg)
  })
}

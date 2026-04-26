/**
 * Canonical file-edit preview for transcript tool rows and approvals (all providers).
 */

export interface FileEditChange {
  readonly path: string
  readonly diff: string
}

const NEST_KEYS = ['args', 'item', 'toolCall', 'tool_call', 'call', 'fileChange', 'data'] as const

function trimDiff(value: unknown): string {
  return typeof value === 'string' ? value.trimEnd() : ''
}

/** Reads `payload.fileEditChanges` when adapters / ingestion attach the canonical list. */
export function readCanonicalFileEditChanges(payload: unknown): FileEditChange[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as Record<string, unknown>)['fileEditChanges']
  if (!Array.isArray(raw)) return []
  const out: FileEditChange[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const path = typeof o.path === 'string' ? o.path : ''
    const diff = trimDiff(o.diff)
    if (path && diff) out.push({ path, diff })
  }
  return out
}

/**
 * Walks nested Codex-style payloads (`changes[].diff`, optional `path`) for backwards compatibility.
 */
export function discoverLegacyCodexFileEditChanges(input: unknown): FileEditChange[] {
  const seen = new WeakSet<object>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  while (queue.length > 0) {
    const { value, depth } = queue.shift() as { value: unknown; depth: number }
    if (!value || typeof value !== 'object') continue
    if (seen.has(value)) continue
    seen.add(value)
    const record = value as Record<string, unknown>
    const changes = record['changes']
    if (
      Array.isArray(changes) &&
      changes.some(
        (c) =>
          Boolean(c) &&
          typeof c === 'object' &&
          trimDiff((c as Record<string, unknown>).diff).length > 0
      )
    ) {
      const out: FileEditChange[] = []
      for (const c of changes) {
        if (!c || typeof c !== 'object') continue
        const ch = c as Record<string, unknown>
        const diff = trimDiff(ch.diff)
        if (!diff) continue
        const path = typeof ch.path === 'string' && ch.path ? ch.path : 'file changes'
        out.push({ path, diff })
      }
      return out
    }
    if (depth >= 5) continue
    for (const key of NEST_KEYS) {
      if (key in record) queue.push({ value: record[key], depth: depth + 1 })
    }
  }
  return []
}

export function fileEditChangesFromUnknownPayload(payload: unknown): FileEditChange[] | undefined {
  const found = discoverLegacyCodexFileEditChanges(payload)
  return found.length > 0 ? found : undefined
}

/** OpenCode tool `state.metadata` / permission `metadata` (and related fields). */
export function fileEditChangesFromOpenCodeMetadata(
  metadata: unknown,
  filePathFallbacks: readonly string[]
): FileEditChange[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const m = metadata as Record<string, unknown>
  let diffStr = trimDiff(m.diff)
  if (!diffStr && m.filediff && typeof m.filediff === 'object') {
    const fd = m.filediff as Record<string, unknown>
    diffStr = trimDiff(fd.patch)
  }
  if (!diffStr) return undefined

  const input = m.input
  let pathFromInput = ''
  if (input && typeof input === 'object') {
    const fp = (input as Record<string, unknown>).filePath
    if (typeof fp === 'string' && fp.trim()) pathFromInput = fp
  }
  let pathFromFilediff = ''
  if (m.filediff && typeof m.filediff === 'object') {
    const fd = m.filediff as Record<string, unknown>
    if (typeof fd.file === 'string' && fd.file.trim()) pathFromFilediff = fd.file
  }
  const path =
    pathFromInput ||
    pathFromFilediff ||
    filePathFallbacks.find((p) => typeof p === 'string' && p.trim().length > 0) ||
    ''
  if (!path) return undefined
  return [{ path, diff: diffStr }]
}

export function mergeFileEditChanges(
  incoming: FileEditChange[] | undefined,
  previous: FileEditChange[] | undefined
): FileEditChange[] | undefined {
  if (incoming && incoming.length > 0) return incoming
  if (previous && previous.length > 0) return previous
  return undefined
}

export function fileEditChangesToPreview(
  changes: readonly FileEditChange[]
): { diff: string; title: string } | null {
  const nonEmpty = changes.filter((c) => c.diff.length > 0)
  if (nonEmpty.length === 0) return null
  const paths = nonEmpty.map((c) => c.path).filter(Boolean)
  const firstPath = paths[0] ?? 'file changes'
  return {
    diff: nonEmpty.map((c) => c.diff).join('\n'),
    title: paths.length > 1 ? `${firstPath} +${paths.length - 1}` : firstPath
  }
}

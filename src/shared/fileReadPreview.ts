/**
 * Canonical file-read preview for tool transcript rows (any provider may attach).
 */

export interface FileReadPreview {
  readonly path: string
  readonly content: string
  readonly resourceType?: string
  readonly truncated?: boolean
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Reads `payload.fileReadPreview` when adapters attach the canonical object. */
export function readCanonicalFileReadPreview(payload: unknown): FileReadPreview | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const raw = (payload as Record<string, unknown>)['fileReadPreview']
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const path = isNonEmptyString(o.path) ? o.path.trim() : ''
  const content = typeof o.content === 'string' ? o.content : ''
  if (!path && !content.trim()) return undefined
  const resourceType = isNonEmptyString(o.resourceType) ? o.resourceType.trim() : undefined
  const truncated = typeof o.truncated === 'boolean' ? o.truncated : undefined
  return { path: path || '(file)', content, resourceType, truncated }
}

export function mergeFileReadPreview(
  incoming: FileReadPreview | undefined,
  previous: FileReadPreview | undefined
): FileReadPreview | undefined {
  if (!incoming && !previous) return undefined
  const inc = incoming
  const prev = previous
  if (!inc) return prev
  if (!prev) return inc
  const path = inc.path.trim() || prev.path.trim() || '(file)'
  const content =
    inc.content.length >= prev.content.length && inc.content.trim().length > 0
      ? inc.content
      : prev.content.length > 0
        ? prev.content
        : inc.content
  return {
    path,
    content,
    resourceType: inc.resourceType ?? prev.resourceType,
    truncated: inc.truncated ?? prev.truncated
  }
}

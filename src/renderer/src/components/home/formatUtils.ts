export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatWorkDuration(ms: number | null): string {
  if (ms === null) return 'a moment'
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function formatThreadLastUsed(value: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''

  const elapsedMs = Math.max(0, Date.now() - timestamp)
  if (elapsedMs < 60_000) return 'now'
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m`
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h`
  if (elapsedMs < 604_800_000) return `${Math.floor(elapsedMs / 86_400_000)}d`

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(timestamp)
  )
}

export function formatPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload.data ?? payload, null, 2)
  } catch {
    return String(payload)
  }
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  )
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

export function sanitizeDisplayedError(message: string): string {
  let normalized = stripAnsi(message).trim().replace(/\s+/g, ' ')
  normalized = normalized.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  normalized = normalized.replace(/^Error:\s*/i, '')
  if (/^No active Codex session for thread:/i.test(normalized)) {
    return 'Codex session ended. Send your message again to start a fresh session.'
  }
  return normalized
}

export function errorMessageForDisplay(error: unknown): string {
  return sanitizeDisplayedError(error instanceof Error ? error.message : String(error))
}

export function readOpenProjectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('No handler registered')) {
    return 'Project picker is not registered in the running desktop process. Fully restart bun run dev.'
  }
  return message
}

export function languageFromClassName(className: string | undefined): string | null {
  const match = /language-([^\s]+)/u.exec(className ?? '')
  return match?.[1]?.toLowerCase() ?? null
}

export function normalizeHighlightLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'console':
    case 'shell':
    case 'shellsession':
    case 'sh':
    case 'zsh':
      return 'bash'
    case 'tsx':
    case 'typescript':
      return 'ts'
    case 'jsx':
    case 'javascript':
      return 'js'
    case 'html':
    case 'xml':
      return 'xml'
    case 'plaintext':
    case 'text':
    case 'txt':
      return 'plaintext'
    default:
      return language.toLowerCase()
  }
}

export function inferCodeLanguage(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) return 'plaintext'

  if (
    /^(import|export)\s/mu.test(trimmed) ||
    /\b(type|interface|enum)\s+\w+/u.test(trimmed) ||
    /:\s*(string|number|boolean|unknown|Promise<|Array<|\w+\[\])/u.test(trimmed) ||
    /\bReact\.JSX\.Element\b/u.test(trimmed)
  ) {
    return 'ts'
  }

  if (
    /\b(function|const|let|var)\s+\w+/u.test(trimmed) ||
    /\b(console\.log|document\.|window\.)/u.test(trimmed)
  ) {
    return 'js'
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // Keep checking other lightweight signals.
    }
  }

  if (/^(bun|npm|pnpm|yarn|git|cd|ls|mkdir|rm|cp|mv|export)\b/mu.test(trimmed)) return 'bash'

  return 'plaintext'
}

import { homedir } from 'node:os'
import { join } from 'node:path'

const sep = process.platform === 'win32' ? ';' : ':'

function dedupePreserveOrder(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * Finder/Dock-launched macOS apps inherit a minimal PATH from launchd, unlike
 * `electron-vite dev` from a shell. Prepend common locations so Homebrew/user
 * CLIs (e.g. `codex`) resolve the same as in Terminal.
 */
function prependCliPathSegments(): void {
  if (process.platform === 'win32') return

  const home = homedir()
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin')
  }
  if (process.platform === 'linux') {
    candidates.push('/usr/local/bin', '/usr/bin', '/bin')
  }
  candidates.push(join(home, '.local', 'bin'))

  const existing = (process.env.PATH ?? '').split(sep).filter(Boolean)
  const existingSet = new Set(existing)
  const prefix = candidates.filter((p) => !existingSet.has(p))
  if (prefix.length === 0) return
  process.env.PATH = dedupePreserveOrder([...prefix, ...existing]).join(sep)
}

prependCliPathSegments()

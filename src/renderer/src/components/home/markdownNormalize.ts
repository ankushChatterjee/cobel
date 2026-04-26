/**
 * GFM tables require the header separator row to have the same number of
 * columns as the header row. Models often emit too few |---| segments, which
 * makes remark treat the block as a plain paragraph (so tables "don't render").
 */

function countGfmTableColumns(line: string): number {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return 0
  return t.split('|').length - 2
}

function isGfmTableDelimiterLine(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return false
  const cells = t.split('|').slice(1, -1)
  if (cells.length < 1) return false
  return cells.every((c) => /^[ \t]*:?-{3,}:?[ \t]*$/u.test(c))
}

function buildGfmAlignmentRow(columnCount: number): string {
  if (columnCount < 1) return ''
  return `|${Array.from({ length: columnCount }, () => ' --- ').join('|')}|`
}

/** GFM/CM fence line: optional indent, 3+ backticks or tildes, then rest of line (e.g. language). */
function isFencedCodeBoundaryLine(line: string): boolean {
  return /^\s*(`{3,}|~{3,})/.test(line)
}

/**
 * Re-aligns a malformed GFM table delimiter (second row) to match the
 * previous row’s column count when the previous row looks like a GFM line and
 * the current row looks like a delimiter.
 *
 * Only runs **outside** ` ``` / ~~~ ` fenced code blocks so we do not mutate
 * table-shaped examples in code. May still misfire on contrived `|`-prefixed
 * non-table lines followed by a delimiter line in prose; that is rare in chat.
 */
export function normalizeGfmTableDelimiters(text: string): string {
  const lines = text.split('\n')
  let inFencedCode = false
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    if (isFencedCodeBoundaryLine(line)) {
      inFencedCode = !inFencedCode
    }
    if (inFencedCode) continue

    const next = lines[i + 1]!
    if (!isGfmTableDelimiterLine(next)) continue
    const cRow = countGfmTableColumns(line)
    const cNext = countGfmTableColumns(next)
    if (cRow < 1 || cRow === cNext) continue
    if (cNext < 1) continue
    lines[i + 1] = buildGfmAlignmentRow(cRow)
  }
  return lines.join('\n')
}

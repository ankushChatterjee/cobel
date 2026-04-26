import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { normalizeGfmTableDelimiters } from './markdownNormalize'

function hasTableNode(text: string): boolean {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text)
  return JSON.stringify(tree).includes('"type":"table"')
}

describe('normalizeGfmTableDelimiters', () => {
  it('repairs delimiter column count to match a wide header so GFM parsing yields a table', () => {
    const raw =
      '| # | A | B | C | D | E | F | G |\n' +
      '|---|---|---|---|\n' +
      '| 1 | a | b | c | d | e | f | g |\n'

    expect(hasTableNode(raw)).toBe(false)
    const fixed = normalizeGfmTableDelimiters(raw)
    expect(hasTableNode(fixed)).toBe(true)
    expect(fixed).toContain(' --- ')
  })

  it('leaves well-formed GFM tables unchanged (still parses as table)', () => {
    const good =
      '| a | b |\n' +
      '| --- | --- |\n' +
      '| 1 | 2 |\n'

    expect(hasTableNode(good)).toBe(true)
    expect(normalizeGfmTableDelimiters(good).trimEnd()).toBe(good.trimEnd())
  })

  it('does not rewrite table-like lines inside fenced code (avoids false positives)', () => {
    const inside = [
      '```',
      '| # | A | B | C | D | E | F | G |',
      '|---|---|---|---|',
      'bad example row',
      '```'
    ].join('\n')

    expect(normalizeGfmTableDelimiters(inside)).toBe(inside)
  })
})

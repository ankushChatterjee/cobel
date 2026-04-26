import { describe, expect, it } from 'vitest'
import { mergeFileReadPreview, readCanonicalFileReadPreview } from './fileReadPreview'

describe('readCanonicalFileReadPreview', () => {
  it('returns undefined for empty or invalid payloads', () => {
    expect(readCanonicalFileReadPreview(undefined)).toBeUndefined()
    expect(readCanonicalFileReadPreview({})).toBeUndefined()
    expect(readCanonicalFileReadPreview({ fileReadPreview: { path: '', content: '' } })).toBeUndefined()
  })

  it('reads valid preview', () => {
    expect(
      readCanonicalFileReadPreview({
        fileReadPreview: { path: '/a/b.ts', content: 'hello', resourceType: 'file', truncated: true }
      })
    ).toEqual({
      path: '/a/b.ts',
      content: 'hello',
      resourceType: 'file',
      truncated: true
    })
  })
})

describe('mergeFileReadPreview', () => {
  it('prefers longer content when merging', () => {
    const a = { path: '/x.ts', content: 'short' }
    const b = { path: '/x.ts', content: 'short but longer' }
    expect(mergeFileReadPreview(b, a)).toEqual(b)
    expect(mergeFileReadPreview(a, b)).toEqual(b)
  })

  it('falls back to previous when incoming is undefined', () => {
    const prev = { path: '/p.ts', content: 'x' }
    expect(mergeFileReadPreview(undefined, prev)).toEqual(prev)
  })
})

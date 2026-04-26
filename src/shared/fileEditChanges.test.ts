import { describe, expect, it } from 'vitest'
import {
  discoverLegacyCodexFileEditChanges,
  fileEditChangesFromOpenCodeMetadata,
  fileEditChangesFromUnknownPayload,
  mergeFileEditChanges,
  readCanonicalFileEditChanges
} from './fileEditChanges'

describe('readCanonicalFileEditChanges', () => {
  it('reads fileEditChanges from payload', () => {
    const fe = readCanonicalFileEditChanges({
      fileEditChanges: [{ path: '/a.ts', diff: 'diff --git a/a\n' }]
    })
    expect(fe).toEqual([{ path: '/a.ts', diff: 'diff --git a/a' }])
  })

  it('returns empty when missing or invalid', () => {
    expect(readCanonicalFileEditChanges({})).toEqual([])
    expect(readCanonicalFileEditChanges({ fileEditChanges: [{ path: '', diff: 'x' }] })).toEqual([])
  })
})

describe('discoverLegacyCodexFileEditChanges', () => {
  it('finds nested changes[].diff', () => {
    const payload = {
      item: {
        type: 'fileChange',
        changes: [{ path: 'src/x.ts', diff: 'diff --git a/x\n', kind: 'edit' }]
      }
    }
    expect(discoverLegacyCodexFileEditChanges(payload)).toEqual([
      { path: 'src/x.ts', diff: 'diff --git a/x' }
    ])
  })
})

describe('fileEditChangesFromUnknownPayload', () => {
  it('returns undefined when no changes', () => {
    expect(fileEditChangesFromUnknownPayload({ foo: 1 })).toBeUndefined()
  })
})

describe('fileEditChangesFromOpenCodeMetadata', () => {
  it('extracts diff and path from metadata + input', () => {
    const meta = {
      input: { filePath: '/p.ts' },
      diff: 'Index: p\n',
      filediff: { file: '/p.ts', patch: 'ignored when diff set' }
    }
    expect(fileEditChangesFromOpenCodeMetadata(meta, [])).toEqual([{ path: '/p.ts', diff: 'Index: p' }])
  })

  it('uses patch when diff missing', () => {
    const meta = {
      input: { filePath: '/q.ts' },
      filediff: { file: '/q.ts', patch: 'patch text\n' }
    }
    expect(fileEditChangesFromOpenCodeMetadata(meta, [])).toEqual([{ path: '/q.ts', diff: 'patch text' }])
  })

  it('uses pattern fallback for path', () => {
    const meta = { diff: 'd\n' }
    expect(fileEditChangesFromOpenCodeMetadata(meta, ['/fallback.ts'])).toEqual([
      { path: '/fallback.ts', diff: 'd' }
    ])
  })
})

describe('mergeFileEditChanges', () => {
  it('prefers incoming over previous', () => {
    const a = [{ path: '/a', diff: 'new' }]
    const b = [{ path: '/a', diff: 'old' }]
    expect(mergeFileEditChanges(a, b)).toEqual(a)
  })

  it('falls back to previous', () => {
    const prev = [{ path: '/a', diff: 'old' }]
    expect(mergeFileEditChanges(undefined, prev)).toEqual(prev)
    expect(mergeFileEditChanges([], prev)).toEqual(prev)
  })
})

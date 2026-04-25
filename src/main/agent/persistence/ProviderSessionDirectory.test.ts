import { describe, it, expect, beforeEach } from 'vitest'
import { openInMemoryDatabase } from './Sqlite'
import { ProviderSessionDirectory } from './ProviderSessionDirectory'
import type { Database } from './Sqlite'

let db: Database
let directory: ProviderSessionDirectory

beforeEach(() => {
  db = openInMemoryDatabase()
  directory = new ProviderSessionDirectory(db)
})

describe('ProviderSessionDirectory', () => {
  it('returns null for unknown thread', () => {
    expect(directory.get('nonexistent')).toBeNull()
    expect(directory.getResumeCursor('nonexistent')).toBeUndefined()
  })

  it('upserts and retrieves a binding with resume cursor', () => {
    directory.upsert('thread-1', {
      provider: 'codex',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      status: 'running',
      resumeCursor: { threadId: 'codex-thread-abc' }
    })
    const binding = directory.get('thread-1')
    expect(binding).not.toBeNull()
    expect(binding!.provider).toBe('codex')
    expect(binding!.runtimeMode).toBe('auto-accept-edits')
    expect(binding!.status).toBe('running')
    expect(binding!.resumeCursor).toEqual({ threadId: 'codex-thread-abc' })
  })

  it('getResumeCursor returns the nested threadId', () => {
    directory.upsert('thread-2', {
      provider: 'codex',
      runtimeMode: 'full-access',
      interactionMode: 'default',
      status: 'ready',
      resumeCursor: { threadId: 'codex-xyz' }
    })
    expect(directory.getResumeCursor('thread-2')).toEqual({ threadId: 'codex-xyz' })
  })

  it('overwrites the binding on upsert', () => {
    directory.upsert('thread-3', {
      provider: 'codex',
      runtimeMode: 'approval-required',
      interactionMode: 'default',
      status: 'ready',
      resumeCursor: { threadId: 'old-id' }
    })
    directory.upsert('thread-3', {
      provider: 'codex',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'plan',
      status: 'running',
      resumeCursor: { threadId: 'new-id' }
    })
    const cursor = directory.getResumeCursor('thread-3')
    expect((cursor as { threadId: string } | undefined)?.threadId).toBe('new-id')
  })

  it('clears the binding', () => {
    directory.upsert('thread-4', {
      provider: 'codex',
      runtimeMode: 'auto-accept-edits',
      interactionMode: 'default',
      status: 'running',
      resumeCursor: { threadId: 'some-id' }
    })
    directory.clear('thread-4')
    expect(directory.get('thread-4')).toBeNull()
  })

  it('handles undefined resumeCursor gracefully', () => {
    directory.upsert('thread-5', {
      provider: 'codex',
      runtimeMode: 'full-access',
      interactionMode: 'default',
      status: 'closed'
    })
    expect(directory.get('thread-5')?.resumeCursor).toBeUndefined()
  })
})

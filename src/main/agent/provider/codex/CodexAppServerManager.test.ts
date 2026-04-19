import { describe, expect, it } from 'vitest'
import {
  buildCodexInitializeParams,
  mapCodexRuntimeMode,
  readProviderThreadId
} from './CodexAppServerManager'

describe('buildCodexInitializeParams', () => {
  it('sends client info and experimental api capability required by codex app-server', () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: 'gencode_desktop',
        title: 'Gencode Desktop',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    })
  })
})

describe('mapCodexRuntimeMode', () => {
  it('maps app runtime modes to Codex approval and sandbox settings', () => {
    expect(mapCodexRuntimeMode('approval-required')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only'
    })
    expect(mapCodexRuntimeMode('auto-accept-edits')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    })
    expect(mapCodexRuntimeMode('full-access')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })
  })
})

describe('readProviderThreadId', () => {
  it('reads the current Codex app-server nested thread id response', () => {
    expect(
      readProviderThreadId({
        thread: {
          id: '019da517-a973-7730-8697-6a7904ae775b'
        }
      })
    ).toBe('019da517-a973-7730-8697-6a7904ae775b')
  })

  it('keeps compatibility with top-level thread id response shapes', () => {
    expect(readProviderThreadId({ threadId: 'urn:uuid:top-level-thread-id' })).toBe(
      'urn:uuid:top-level-thread-id'
    )
    expect(readProviderThreadId({ id: 'top-level-id' })).toBe('top-level-id')
  })
})

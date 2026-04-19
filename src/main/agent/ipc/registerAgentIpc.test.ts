import { describe, expect, it } from 'vitest'
import type { WebFrameMain } from 'electron'
import { isTrustedFrame } from './registerAgentIpc'

describe('isTrustedFrame', () => {
  it('accepts file and localhost frames', () => {
    expect(isTrustedFrame(frame('file:///app/index.html'))).toBe(true)
    expect(isTrustedFrame(frame('http://localhost:5173/'))).toBe(true)
    expect(isTrustedFrame(frame('http://127.0.0.1:5173/'))).toBe(true)
  })

  it('rejects remote and invalid frames', () => {
    expect(isTrustedFrame(frame('https://example.com'))).toBe(false)
    expect(isTrustedFrame(frame('about:blank'))).toBe(false)
    expect(isTrustedFrame(null)).toBe(false)
  })
})

function frame(url: string): WebFrameMain {
  return { url } as WebFrameMain
}

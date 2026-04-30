import { beforeEach, describe, expect, it, vi } from 'vitest'

const promptMock = vi.fn()
const createMock = vi.fn()
const deleteMock = vi.fn()
const closeMock = vi.fn()

vi.mock('./opencodeRuntime', () => ({
  buildOpenCodePermissionRules: vi.fn(() => [{ permission: '*', pattern: '*', action: 'ask' }]),
  connectToOpenCodeServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:7777',
    external: false,
    close: closeMock
  })),
  createOpenCodeSdkClient: vi.fn(() => ({
    session: {
      create: createMock,
      prompt: promptMock,
      delete: deleteMock
    }
  })),
  inventoryToModelInfos: vi.fn(() => [{ id: 'anthropic/claude-sonnet-4', providerId: 'opencode' }]),
  loadOpenCodeInventory: vi.fn(async () => ({})),
  parseOpenCodeModelSlug: vi.fn((slug: string | null | undefined) => {
    if (!slug) return null
    const [providerID, modelID] = slug.split('/')
    return providerID && modelID ? { providerID, modelID } : null
  }),
  readOpenCodeConfigFromEnv: vi.fn(() => ({ binaryPath: 'opencode', serverUrl: '', serverPassword: '' })),
  resolveOpenCodeBinaryPath: vi.fn((value: string) => value),
  appendOpenCodeAssistantTextDelta: vi.fn(),
  mergeOpenCodeAssistantText: vi.fn(),
  openCodeQuestionId: vi.fn(),
  readOpencodeResumeSessionId: vi.fn(),
  runOpenCodeCommand: vi.fn(),
  toOpenCodeFileParts: vi.fn(() => []),
  toOpenCodePermissionReply: vi.fn(),
  toOpenCodeQuestionAnswers: vi.fn()
}))

import { OpenCodeAdapter } from './OpenCodeAdapter'

describe('OpenCodeAdapter.generateThreadTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createMock.mockResolvedValue({ data: { id: 'session:title' } })
    deleteMock.mockResolvedValue({})
    closeMock.mockReset()
  })

  it('does not request structured output when the provider marks it unsupported', async () => {
    promptMock.mockResolvedValue({
      data: {
        info: {},
        parts: [{ type: 'text', text: '{"title":"Provider Layer"}' }]
      }
    })
    const adapter = new OpenCodeAdapter()

    const title = await adapter.generateThreadTitle({
      cwd: '/tmp/project',
      input: 'Please build the provider layer',
      model: 'anthropic/claude-sonnet-4',
      useStructuredOutput: false
    })

    expect(title).toBe('Provider Layer')
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session:title',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        parts: expect.any(Array)
      })
    )
    expect(promptMock.mock.calls[0]?.[0]).not.toHaveProperty('format')
    expect(deleteMock).toHaveBeenCalledWith({ sessionID: 'session:title' })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('passes the JSON schema when structured output is enabled', async () => {
    promptMock.mockResolvedValue({
      data: {
        info: { structured: { title: 'Sidebar Layout' } },
        parts: []
      }
    })
    const adapter = new OpenCodeAdapter()

    const title = await adapter.generateThreadTitle({
      cwd: '/tmp/project',
      input: 'Please refactor the sidebar layout',
      model: 'anthropic/claude-sonnet-4',
      useStructuredOutput: true
    })

    expect(title).toBe('Sidebar Layout')
    expect(promptMock.mock.calls[0]?.[0]).toHaveProperty('format')
  })
})

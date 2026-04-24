import { describe, expect, it } from 'vitest'
import {
  buildCodexInitializeParams,
  buildThreadTitleTurnParams,
  mapCodexRuntimeMode,
  parseCodexStderr,
  parseModelList,
  readProviderThreadId
} from './CodexAppServerManager'
import { THREAD_TITLE_OUTPUT_SCHEMA } from '../../../../shared/threadTitle'

describe('buildCodexInitializeParams', () => {
  it('sends client info and experimental api capability required by codex app-server', () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: 'cobel_desktop',
        title: 'cobel Desktop',
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

describe('parseModelList', () => {
  it('reads the current Codex app-server model/list data response', () => {
    expect(
      parseModelList({
        data: [
          {
            id: 'gpt-5.3-codex',
            model: 'gpt-5.3-codex',
            displayName: 'gpt-5.3-codex',
            description: 'Latest frontier agentic coding model.',
            hidden: false,
            isDefault: true
          }
        ],
        nextCursor: null
      })
    ).toEqual([
      {
        id: 'gpt-5.3-codex',
        name: 'gpt-5.3-codex',
        description: 'Latest frontier agentic coding model.',
        hidden: false,
        isDefault: true
      }
    ])
  })

  it('keeps compatibility with the older models response shape', () => {
    expect(parseModelList({ models: [{ id: 'gpt-5.1-codex', name: 'GPT 5.1 Codex' }] })).toEqual([
      { id: 'gpt-5.1-codex', name: 'GPT 5.1 Codex' }
    ])
  })
})

describe('buildThreadTitleTurnParams', () => {
  it('adds outputSchema when the provider supports structured output', () => {
    expect(
      buildThreadTitleTurnParams({
        providerThreadId: 'thread-1',
        input: 'Fix the sidebar',
        model: 'gpt-5.4',
        useStructuredOutput: true
      })
    ).toEqual(
      expect.objectContaining({
        threadId: 'thread-1',
        model: 'gpt-5.4',
        outputSchema: THREAD_TITLE_OUTPUT_SCHEMA
      })
    )
  })

  it('omits outputSchema when falling back to plain text generation', () => {
    expect(
      buildThreadTitleTurnParams({
        providerThreadId: 'thread-1',
        input: 'Fix the sidebar',
        useStructuredOutput: false
      })
    ).not.toHaveProperty('outputSchema')
  })
})

describe('parseCodexStderr', () => {
  it('ignores structured Codex warn logs from stderr', () => {
    expect(
      parseCodexStderr(
        JSON.stringify({
          timestamp: '2026-04-19T16:41:16.894244Z',
          level: 'WARN',
          fields: {
            message: 'ignoring interface.defaultPrompt: prompt must be at most 128 characters'
          },
          target: 'codex_core::plugins::manifest'
        })
      )
    ).toEqual([
      {
        level: 'ignore',
        message: 'ignoring interface.defaultPrompt: prompt must be at most 128 characters'
      }
    ])
  })

  it('emits structured Codex error logs as runtime errors', () => {
    expect(
      parseCodexStderr(
        JSON.stringify({
          level: 'ERROR',
          fields: { message: 'app-server failed' },
          target: 'codex_core::app_server'
        })
      )
    ).toEqual([
      {
        level: 'error',
        message: 'app-server failed',
        detail: {
          level: 'ERROR',
          fields: { message: 'app-server failed' },
          target: 'codex_core::app_server'
        }
      }
    ])
  })

  it('strips ANSI tracing output and extracts the error field', () => {
    expect(
      parseCodexStderr(
        '\u001b[2m2026-04-21T16:16:01.946777Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::tools::router\u001b[0m\u001b[2m:\u001b[0m \u001b[3merror\u001b[0m\u001b[2m=\u001b[0mexec_command failed for `/bin/zsh -lc "nl -ba src/ai/agent.ts | sed -n \'1,260p\'"`: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: No such file or directory (os error 2)\\")" }'
      )
    ).toEqual([
      {
        level: 'error',
        message:
          'exec_command failed for `/bin/zsh -lc "nl -ba src/ai/agent.ts | sed -n \'1,260p\'"`: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: No such file or directory (os error 2)\\")" }',
        detail: {
          raw: '2026-04-21T16:16:01.946777Z ERROR codex_core::tools::router: error=exec_command failed for `/bin/zsh -lc "nl -ba src/ai/agent.ts | sed -n \'1,260p\'"`: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: No such file or directory (os error 2)\\")" }'
        }
      }
    ])
  })

  it('classifies repeated local MCP transport refusals as a warning', () => {
    expect(
      parseCodexStderr(
        '2026-04-21T16:31:40.213832Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Request, url: "http://127.0.0.1:29979/mcp", source: hyper_util::client::legacy::Error(Connect, ConnectError("tcp connect error", 127.0.0.1:29979, Os { code: 61, kind: ConnectionRefused, message: "Connection refused" })) }))'
      )
    ).toEqual([
      {
        level: 'warning',
        message: 'MCP transport unavailable: local MCP server connection was refused.',
        detail: {
          raw: '2026-04-21T16:31:40.213832Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Request, url: "http://127.0.0.1:29979/mcp", source: hyper_util::client::legacy::Error(Connect, ConnectError("tcp connect error", 127.0.0.1:29979, Os { code: 61, kind: ConnectionRefused, message: "Connection refused" })) }))'
        },
        key: 'rmcp-transport-connection-refused'
      }
    ])
  })

  it('classifies collapsed local MCP transport refusals as a warning', () => {
    expect(
      parseCodexStderr(
        'worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Request, url: "http://127.0.0.1:29979/mcp", source: hyper_util::client::legacy::Error(Connect, ConnectError("tcp connect error", 127.0.0.1:29979, Os { code: 61, kind: ConnectionRefused, message: "Connection refused" })) }))'
      )
    ).toEqual([
      {
        level: 'warning',
        message: 'MCP transport unavailable: local MCP server connection was refused.',
        detail: {
          raw: 'worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Request, url: "http://127.0.0.1:29979/mcp", source: hyper_util::client::legacy::Error(Connect, ConnectError("tcp connect error", 127.0.0.1:29979, Os { code: 61, kind: ConnectionRefused, message: "Connection refused" })) }))'
        },
        key: 'rmcp-transport-connection-refused'
      }
    ])
  })

  it('keeps unstructured stderr visible as a runtime error', () => {
    expect(parseCodexStderr('something broke')).toEqual([
      { level: 'error', message: 'something broke' }
    ])
  })

  it('keeps multiline tool errors in a single runtime error entry', () => {
    expect(
      parseCodexStderr(`apply_patch verification failed: Failed to find expected lines in /tmp/SqlEditor.tsx:
useEffect(() => {
const onKeyDown = (event: KeyboardEvent) => {
if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
event.preventDefault();
setIsSearchOpen(true);
return;
}
if (event.key === "Escape" && isSearchOpen) {`)
    ).toEqual([
      {
        level: 'error',
        message: `apply_patch verification failed: Failed to find expected lines in /tmp/SqlEditor.tsx:
useEffect(() => {
const onKeyDown = (event: KeyboardEvent) => {
if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
event.preventDefault();
setIsSearchOpen(true);
return;
}
if (event.key === "Escape" && isSearchOpen) {`
      }
    ])
  })
})

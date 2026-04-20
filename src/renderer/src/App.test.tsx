import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationThreadStreamItem } from '../../shared/agent'
import { createAppRouter } from './router'
import { resetAgentApiMock } from './test/setup'

describe('renderer app', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetAgentApiMock()
  })

  it('renders the home route', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('heading', { name: /open a project/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/no projects open/i)).toHaveTextContent(/no projects open/i)
    expect(screen.getAllByRole('button', { name: /add project/i })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /open folder/i })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /ask codex/i })).toBeInTheDocument()
    expect(screen.getByText(/codex-cli 0\.121\.0/i)).toBeInTheDocument()
  })

  it('dispatches a turn command from the composer', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    const composer = await screen.findByRole('textbox', { name: /ask codex/i })
    await user.type(composer, 'Build the provider layer')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(window.agentApi.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thread.turn.start',
        provider: 'codex',
        input: 'Build the provider layer',
        cwd: '/Users/ankush/codespace/gencode',
        runtimeMode: 'auto-accept-edits'
      })
    )
    const transcript = await screen.findByLabelText(/conversation transcript/i)
    expect(within(transcript).getByText('Build the provider layer')).toBeInTheDocument()
  })

  it('keeps live events that arrive before the initial snapshot resolves', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'event',
        event: {
          sequence: 1,
          type: 'thread.message-upserted',
          threadId: _input.threadId,
          message: {
            id: 'assistant:live',
            role: 'assistant',
            text: 'Streaming response',
            turnId: 'turn-1',
            streaming: true,
            sequence: 1,
            createdAt: '2026-04-19T00:00:01.000Z',
            updatedAt: '2026-04-19T00:00:01.000Z'
          },
          createdAt: '2026-04-19T00:00:01.000Z'
        }
      })
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 0,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:00.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    expect(await screen.findByText('Streaming response')).toBeInTheDocument()
  })

  it('renders inline expandable tool rows in transcript order', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 3,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [
              {
                id: 'user:cmd-1',
                role: 'user',
                text: 'Run tests',
                turnId: null,
                streaming: false,
                sequence: 1,
                createdAt: '2026-04-19T00:00:00.000Z',
                updatedAt: '2026-04-19T00:00:00.000Z'
              }
            ],
            activities: [
              {
                id: 'tool:item-1',
                kind: 'tool.completed',
                tone: 'tool',
                summary: 'terminal',
                payload: {
                  itemType: 'command_execution',
                  title: 'terminal',
                  detail: 'bun test',
                  status: 'completed',
                  output: 'pass\n'
                },
                turnId: 'turn-1',
                sequence: 2,
                createdAt: '2026-04-19T00:00:01.000Z'
              }
            ],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:01.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    expect(await screen.findByText('Run tests')).toBeInTheDocument()
    const toolRow = await screen.findByRole('button', { name: /terminal/i })
    expect(toolRow).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toolRow)
    expect(await screen.findByText('bun test')).toBeInTheDocument()
    expect(screen.getByText(/pass/)).toBeInTheDocument()
  })

  it('orders restored transcript rows by timestamp when event sequences reset', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 2,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [
              {
                id: 'user:old',
                role: 'user',
                text: 'How can this app be made faster?',
                turnId: null,
                streaming: false,
                sequence: 80,
                createdAt: '2026-04-19T12:14:00.000Z',
                updatedAt: '2026-04-19T12:14:00.000Z'
              },
              {
                id: 'assistant:old',
                role: 'assistant',
                text: 'I will inspect performance levers first.',
                turnId: 'turn-old',
                streaming: false,
                sequence: 120,
                createdAt: '2026-04-19T12:15:00.000Z',
                updatedAt: '2026-04-19T12:15:00.000Z'
              },
              {
                id: 'user:new',
                role: 'user',
                text: 'What build system does this app use?',
                turnId: null,
                streaming: false,
                sequence: 1,
                createdAt: '2026-04-19T19:04:00.000Z',
                updatedAt: '2026-04-19T19:04:00.000Z'
              },
              {
                id: 'assistant:new',
                role: 'assistant',
                text: 'I am checking the project files.',
                turnId: 'turn-new',
                streaming: false,
                sequence: 2,
                createdAt: '2026-04-19T19:05:00.000Z',
                updatedAt: '2026-04-19T19:05:00.000Z'
              }
            ],
            activities: [],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T12:14:00.000Z',
            updatedAt: '2026-04-19T19:05:00.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    const transcript = await screen.findByLabelText(/conversation transcript/i)
    const text = transcript.textContent ?? ''
    expect(text.indexOf('How can this app be made faster?')).toBeLessThan(
      text.indexOf('I will inspect performance levers first.')
    )
    expect(text.indexOf('I will inspect performance levers first.')).toBeLessThan(
      text.indexOf('What build system does this app use?')
    )
    expect(text.indexOf('What build system does this app use?')).toBeLessThan(
      text.indexOf('I am checking the project files.')
    )
  })

  it('renders completed payload status even when a live tool row is still marked updated', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 2,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [
              {
                id: 'tool:item-1',
                kind: 'tool.updated',
                tone: 'tool',
                summary: 'terminal',
                payload: {
                  itemType: 'command_execution',
                  title: 'terminal',
                  detail: 'bun test',
                  status: 'completed'
                },
                turnId: 'turn-1',
                sequence: 1,
                createdAt: '2026-04-19T00:00:01.000Z'
              }
            ],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:01.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    const toolRow = await screen.findByRole('button', { name: /terminal/i })
    expect(within(toolRow).getByText(/completed/i)).toBeInTheDocument()
  })

  it('renders completed tool kind as completed even if an older payload says running', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 2,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [
              {
                id: 'tool:item-1',
                kind: 'tool.completed',
                tone: 'tool',
                summary: 'terminal',
                payload: {
                  itemType: 'command_execution',
                  title: 'terminal',
                  detail: 'bun test',
                  status: 'inProgress'
                },
                turnId: 'turn-1',
                sequence: 1,
                createdAt: '2026-04-19T00:00:01.000Z'
              }
            ],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:01.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    const toolRow = await screen.findByRole('button', { name: /terminal/i })
    expect(within(toolRow).getByText(/completed/i)).toBeInTheDocument()
    expect(within(toolRow).queryByText(/running/i)).not.toBeInTheDocument()
  })

  it('applies live activity updates in StrictMode without dropping later completion events', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    let listener: ((item: OrchestrationThreadStreamItem) => void) | null = null
    let subscribedThreadId = ''
    window.agentApi.subscribeThread = vi.fn((_input, next) => {
      subscribedThreadId = _input.threadId
      listener = next
      next({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 0,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:00.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    )

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    expect(listener).not.toBeNull()
    act(() => {
      listener?.({
        kind: 'event',
        event: {
          sequence: 1,
          type: 'thread.activity-upserted',
          threadId: subscribedThreadId,
          activity: {
            id: 'tool:item-1',
            kind: 'tool.updated',
            tone: 'tool',
            summary: 'terminal',
            payload: {
              itemType: 'command_execution',
              title: 'terminal',
              detail: 'sed -n 1,220p src/App.tsx',
              status: 'inProgress'
            },
            turnId: 'turn-1',
            sequence: 1,
            createdAt: '2026-04-19T00:00:01.000Z'
          },
          createdAt: '2026-04-19T00:00:01.000Z'
        }
      })
    })

    const runningToolRow = await screen.findByRole('button', { name: /terminal/i })
    expect(within(runningToolRow).getByText(/running/i)).toBeInTheDocument()

    act(() => {
      listener?.({
        kind: 'event',
        event: {
          sequence: 2,
          type: 'thread.activity-upserted',
          threadId: subscribedThreadId,
          activity: {
            id: 'tool:item-1',
            kind: 'tool.completed',
            tone: 'tool',
            summary: 'terminal',
            payload: {
              itemType: 'command_execution',
              title: 'terminal',
              detail: 'sed -n 1,220p src/App.tsx',
              status: 'completed'
            },
            turnId: 'turn-1',
            sequence: 1,
            createdAt: '2026-04-19T00:00:01.000Z'
          },
          createdAt: '2026-04-19T00:00:02.000Z'
        }
      })
    })

    const completedToolRow = await screen.findByRole('button', { name: /terminal/i })
    expect(within(completedToolRow).getByText(/completed/i)).toBeInTheDocument()
    expect(within(completedToolRow).queryByText(/running/i)).not.toBeInTheDocument()
  })

  it('shows active thinking and hides completed thinking rows', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 3,
          thread: {
            id: _input.threadId,
            title: 'Chat title',
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [
              {
                id: 'thinking:active',
                kind: 'task.started',
                tone: 'thinking',
                summary: 'Thinking',
                payload: { status: 'inProgress' },
                turnId: 'turn-1',
                sequence: 1,
                resolved: false,
                createdAt: '2026-04-19T00:00:00.000Z'
              },
              {
                id: 'thinking:done',
                kind: 'task.completed',
                tone: 'thinking',
                summary: 'Thinking',
                payload: { status: 'completed' },
                turnId: 'turn-1',
                sequence: 2,
                resolved: true,
                createdAt: '2026-04-19T00:00:01.000Z'
              }
            ],
            proposedPlans: [],
            session: null,
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:01.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    expect(await screen.findByLabelText('Thinking')).toBeInTheDocument()
    expect(screen.getAllByText('thinking…')).toHaveLength(1)
    expect(screen.queryByLabelText('Thought')).not.toBeInTheDocument()
  })

  it('opens projects and clears the active chat from controls', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])
    expect(window.agentApi.openWorkspaceFolder).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /gencode/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /clear chat/i }))
    expect(window.agentApi.clearThread).toHaveBeenCalledWith({
      threadId: expect.stringMatching(/^project:/)
    })
  })
})

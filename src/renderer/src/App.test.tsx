import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelCatalog,
  ModelInfo,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem
} from '../../shared/agent'
import { DEFAULT_THREAD_TITLE } from '../../shared/threadTitle'
import { createAppRouter } from './router'
import { createTestThread, resetAgentApiMock } from './test/setup'

function mockThreadSnapshotWithActivities(activities: OrchestrationThreadActivity[]): void {
  window.agentApi.subscribeThread = vi.fn((_input, listener) => {
    listener({
      kind: 'snapshot',
      snapshot: {
        snapshotSequence: 1,
        thread: {
          id: _input.threadId,
          title: DEFAULT_THREAD_TITLE,
          cwd: '/Users/ankush/codespace/gencode',
          branch: 'main',
          messages: [],
          activities,
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
}

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
    expect(screen.getAllByRole('button', { name: /add project/i })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /open folder/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /ask codex/i })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: /welcome/i })).getByText(/^Cobel$/i)).toBeInTheDocument()
    expect(screen.getByText(/codex-cli 0\.121\.0/i)).toBeInTheDocument()
    expect(screen.getByText(/not installed/i)).toBeInTheDocument()
  })

  it('defaults to Write permissions and keeps Full access selectable', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    const runtimeSelect = (await screen.findByLabelText(/^runtime mode$/i)) as HTMLSelectElement
    const optionValues = Array.from(runtimeSelect.options).map((option) => option.value)

    expect(runtimeSelect).toHaveValue('auto-accept-edits')
    expect(optionValues).toContain('full-access')
  })

  it('can switch to Plan mode and dispatch a turn with interactionMode plan', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    const planButton = await screen.findByRole('button', { name: /^plan$/i })
    await user.click(planButton)
    expect(planButton).toHaveAttribute('aria-pressed', 'true')

    const composer = await screen.findByRole('textbox', { name: /ask codex/i })
    await user.type(composer, 'Plan the implementation')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(window.agentApi.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thread.turn.start',
        input: 'Plan the implementation',
        runtimeMode: 'auto-accept-edits',
        interactionMode: 'plan'
      })
    )
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
        titleSeed: 'Build the provider layer',
        cwd: '/Users/ankush/codespace/gencode',
        effort: 'medium',
        runtimeMode: 'auto-accept-edits',
        interactionMode: 'default'
      })
    )
    expect(window.agentApi.dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thread.rename' })
    )
    const transcript = await screen.findByLabelText(/conversation transcript/i)
    expect(within(transcript).getByText('Build the provider layer')).toBeInTheDocument()
    expect(screen.getByLabelText('Thinking')).toBeInTheDocument()
    expect(screen.getByText('thinking…')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Build the provider layer' })).toBeInTheDocument()
  })

  it('reuses the active plan tab when sending plan feedback', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 1,
          thread: createTestThread({
            id: _input.threadId,
            proposedPlans: [
              {
                id: `plan:${_input.threadId}:turn:turn-plan-1`,
                turnId: 'turn-plan-1',
                text: '# Alpha plan\n\nShip the first version.',
                status: 'proposed',
                createdAt: '2026-04-19T00:00:00.000Z',
                updatedAt: '2026-04-19T00:00:00.000Z'
              }
            ],
            latestTurn: {
              id: 'turn-plan-1',
              status: 'completed',
              startedAt: '2026-04-19T00:00:00.000Z',
              completedAt: '2026-04-19T00:00:01.000Z'
            },
            session: {
              threadId: _input.threadId,
              status: 'ready',
              providerName: 'codex',
              runtimeMode: 'auto-accept-edits',
              interactionMode: 'default',
              effort: 'medium',
              activeTurnId: null,
              activePlanId: null,
              lastError: null,
              updatedAt: '2026-04-19T00:00:01.000Z'
            }
          })
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    await screen.findByRole('tab', { name: 'Alpha plan' })
    await user.click(screen.getByRole('tab', { name: 'Alpha plan' }))

    const planModeButton = within(
      screen.getByRole('group', { name: /interaction mode/i })
    ).getByRole('button', { name: /^plan$/i })
    await user.click(planModeButton)

    const composer = await screen.findByRole('textbox', { name: /ask codex/i })
    await user.type(composer, 'Tighten the rollout and add migration notes.')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(window.agentApi.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thread.turn.start',
        interactionMode: 'plan',
        targetPlanId: expect.stringMatching(/^plan:.*:turn:turn-plan-1$/)
      })
    )
  })

  it('persists model and runtime mode per thread', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    const models: ModelInfo[] = [
      {
        id: 'gpt-5.4-mini',
        providerId: 'codex',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'medium' }],
        defaultReasoningEffort: 'minimal'
      },
      {
        id: 'gpt-5.4',
        providerId: 'codex',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'low'
      }
    ]
    window.agentApi.listModelCatalog = vi.fn(async (): Promise<ModelCatalog> => ({
      providers: [
        { id: 'codex', name: 'Codex', status: 'available', detail: 'ok' },
        { id: 'opencode', name: 'OpenCode', status: 'missing', detail: '' }
      ],
      modelsByProvider: { codex: models, opencode: [] }
    }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    const runtimeSelect = (await screen.findByLabelText(/^runtime mode$/i)) as HTMLSelectElement
    const modelSelect = (await screen.findByLabelText(/model/i)) as HTMLSelectElement
    const effortSelect = (await screen.findByLabelText(/effort/i)) as HTMLSelectElement

    expect(runtimeSelect.value).toBe('auto-accept-edits')
    await waitFor(() => {
      expect(modelSelect.value).toBe('gpt-5.4-mini')
      expect(effortSelect.value).toBe('minimal')
    })

    await user.selectOptions(runtimeSelect, 'full-access')
    await user.selectOptions(modelSelect, 'gpt-5.4')
    await waitFor(() => {
      expect(effortSelect.value).toBe('low')
    })
    await user.selectOptions(effortSelect, 'high')

    const sidebarNewButton = document.querySelector<HTMLButtonElement>('.project-new-thread')
    expect(sidebarNewButton).not.toBeNull()
    await user.click(sidebarNewButton as HTMLButtonElement)

    const runtimeSelectAfterNew = (await screen.findByLabelText(/^runtime mode$/i)) as HTMLSelectElement
    const modelSelectAfterNew = (await screen.findByLabelText(/model/i)) as HTMLSelectElement
    const effortSelectAfterNew = (await screen.findByLabelText(/effort/i)) as HTMLSelectElement

    await waitFor(() => {
      expect(runtimeSelectAfterNew.value).toBe('auto-accept-edits')
      expect(modelSelectAfterNew.value).toBe('gpt-5.4-mini')
      expect(effortSelectAfterNew.value).toBe('minimal')
    })

    const threadButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.thread-list .thread-link')
    ).filter((button) => !button.classList.contains('new-thread'))
    expect(threadButtons).toHaveLength(2)

    await user.click(threadButtons[1])

    const runtimeSelectAfterReturn = (await screen.findByLabelText(/^runtime mode$/i)) as HTMLSelectElement
    const modelSelectAfterReturn = (await screen.findByLabelText(/model/i)) as HTMLSelectElement
    const effortSelectAfterReturn = (await screen.findByLabelText(/effort/i)) as HTMLSelectElement

    await waitFor(() => {
      expect(runtimeSelectAfterReturn.value).toBe('full-access')
      expect(modelSelectAfterReturn.value).toBe('gpt-5.4')
      expect(effortSelectAfterReturn.value).toBe('high')
    })
  })

  it('opens the model selector with Cmd+Shift+M and supports keyboard selection', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.listModelCatalog = vi.fn(async (): Promise<ModelCatalog> => ({
      providers: [
        { id: 'codex', name: 'Codex', status: 'available', detail: 'ok' },
        { id: 'opencode', name: 'OpenCode', status: 'missing', detail: '' }
      ],
      modelsByProvider: {
        codex: [
          { id: 'gpt-5.4-mini', providerId: 'codex', isDefault: true },
          { id: 'gpt-5.4', providerId: 'codex' },
          { id: 'gpt-5.3-codex', providerId: 'codex' }
        ],
        opencode: []
      }
    }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    const modelSelect = (await screen.findByLabelText(/model/i)) as HTMLSelectElement
    await waitFor(() => {
      expect(modelSelect).not.toBeDisabled()
      expect(modelSelect.value).toBe('gpt-5.4-mini')
    })

    fireEvent.keyDown(window, { key: 'm', metaKey: true, shiftKey: true })

    const listbox = await screen.findByRole('listbox')
    expect(screen.getByText('⌘⇧M')).toBeInTheDocument()
    await waitFor(() => {
      expect(within(listbox).getByRole('option', { name: /gpt 5\.4 mini/i })).toHaveFocus()
    })

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(within(listbox).getByRole('option', { name: /gpt 5\.4$/i })).toHaveFocus()
    })

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })

    await waitFor(() => {
      expect(modelSelect.value).toBe('gpt-5.4')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
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
            title: DEFAULT_THREAD_TITLE,
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

  it('renders assistant markdown with lists, task items, and highlighted fenced code', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 1,
          thread: {
            id: _input.threadId,
            title: DEFAULT_THREAD_TITLE,
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [
              {
                id: 'assistant:markdown',
                role: 'assistant',
                text: 'Here is **bold text**.\n\n- First item\n- Second item\n\n1. Ordered item\n2. Next ordered item\n\n- [x] Finished task\n- [ ] Open task\n\n```ts\nconst answer = 42\n```',
                turnId: 'turn-1',
                streaming: false,
                sequence: 1,
                createdAt: '2026-04-19T00:00:01.000Z',
                updatedAt: '2026-04-19T00:00:02.000Z'
              }
            ],
            activities: [],
            proposedPlans: [],
            session: null,
            latestTurn: {
              id: 'turn-1',
              status: 'completed',
              startedAt: '2026-04-19T00:00:00.000Z',
              completedAt: '2026-04-19T00:00:03.000Z'
            },
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

    expect((await screen.findByText('bold text')).tagName).toBe('STRONG')
    const unorderedList = screen.getByText('First item').closest('ul')
    const orderedList = screen.getByText('Ordered item').closest('ol')
    expect(unorderedList).toBeInTheDocument()
    expect(orderedList).toBeInTheDocument()
    expect(getComputedStyle(unorderedList!).listStyleType).toBe('disc')
    expect(getComputedStyle(orderedList!).listStyleType).toBe('decimal')
    const taskCheckboxes = screen.getAllByRole('checkbox')
    expect(taskCheckboxes).toHaveLength(2)
    expect(taskCheckboxes[0]).toBeChecked()
    expect(taskCheckboxes[1]).not.toBeChecked()
    expect(screen.getByText('Finished task')).toBeInTheDocument()
    expect(screen.getByText('Open task')).toBeInTheDocument()
    expect(screen.getByText('worked for')).toBeInTheDocument()
    expect(screen.getByText('1s')).toBeInTheDocument()
    expect(screen.queryByText('3s')).not.toBeInTheDocument()
    await waitFor(() => {
      const codeBlock = document.querySelector('.markdown-code-block.highlighted')
      expect(codeBlock).toHaveTextContent('const answer = 42')
    })
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
            title: DEFAULT_THREAD_TITLE,
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

  it('renders a matching runtime and session error once inline', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 3,
          thread: {
            id: _input.threadId,
            title: DEFAULT_THREAD_TITLE,
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [
              {
                id: 'runtime.error:event-1',
                kind: 'runtime.error',
                tone: 'error',
                summary:
                  'exec_command failed for `/bin/zsh -lc "nl -ba src/ai/agent.ts | sed -n \'1,260p\'"`: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: No such file or directory (os error 2)\\")" }',
                payload: {
                  detail: {
                    raw: '\u001b[31mERROR\u001b[0m error=exec_command failed'
                  }
                },
                turnId: 'turn-1',
                sequence: 1,
                createdAt: '2026-04-19T00:00:01.000Z'
              }
            ],
            proposedPlans: [],
            session: {
              threadId: _input.threadId,
              status: 'error',
              providerName: 'codex',
              runtimeMode: 'auto-accept-edits',
              interactionMode: 'default',
              activeTurnId: null,
              lastError:
                'exec_command failed for `/bin/zsh -lc "nl -ba src/ai/agent.ts | sed -n \'1,260p\'"`: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: No such file or directory (os error 2)\\")" }',
              updatedAt: '2026-04-19T00:00:02.000Z'
            },
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:02.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    expect(await screen.findByText(/exec_command failed/)).toBeInTheDocument()
    expect(screen.queryByText(/codex returned an error/i)).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('[31m')
    expect(document.body.textContent).not.toContain('\u001b')
  })

  it('renders session errors without matching runtime activity at the bottom', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 1,
          thread: {
            id: _input.threadId,
            title: DEFAULT_THREAD_TITLE,
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [],
            proposedPlans: [],
            session: {
              threadId: _input.threadId,
              status: 'error',
              providerName: 'codex',
              runtimeMode: 'auto-accept-edits',
              interactionMode: 'default',
              activeTurnId: null,
              lastError: 'Codex CLI is not available.',
              updatedAt: '2026-04-19T00:00:02.000Z'
            },
            latestTurn: null,
            checkpoints: [],
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:02.000Z',
            archivedAt: null
          }
        }
      })
      return vi.fn()
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await userEvent.click(openFolderButtons[0])

    expect(await screen.findByText('Codex CLI is not available.')).toBeInTheDocument()
    expect(screen.queryByText(/codex returned an error/i)).not.toBeInTheDocument()
  })

  it('does not show Electron IPC boilerplate for command errors', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    const dispatchCommand = vi.mocked(window.agentApi.dispatchCommand)
    const defaultDispatchCommand = dispatchCommand.getMockImplementation()
    dispatchCommand.mockImplementation(async (input) => {
      if (input.type === 'thread.turn.start') {
        throw new Error(
          "Error invoking remote method 'agent:dispatch-command': Error: No active Codex session for thread: project:users-ankush-codespace-gencode:chat:abc"
        )
      }
      return (
        defaultDispatchCommand?.(input) ?? {
          accepted: true,
          commandId: input.commandId,
          threadId: 'threadId' in input ? input.threadId : '',
          turnId: 'turn:test'
        }
      )
    })

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    const composer = await screen.findByRole('textbox', { name: /ask codex/i })
    await user.type(composer, 'Run tests')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(
      await screen.findByText(
        'Codex session ended. Send your message again to start a fresh session.'
      )
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Error invoking remote method')
    expect(document.body).not.toHaveTextContent('agent:dispatch-command')
    expect(document.body).not.toHaveTextContent('project:users-ankush-codespace-gencode')
  })

  it('renders runtime warnings with an icon instead of a text label', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.subscribeThread = vi.fn((_input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 1,
          thread: {
            id: _input.threadId,
            title: DEFAULT_THREAD_TITLE,
            cwd: '/Users/ankush/codespace/gencode',
            branch: 'main',
            messages: [],
            activities: [
              {
                id: 'runtime.warning:event-1',
                kind: 'runtime.warning',
                tone: 'info',
                summary: 'MCP transport unavailable: local MCP server connection was refused.',
                payload: {},
                turnId: null,
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

    expect(await screen.findByLabelText('Warning')).toBeInTheDocument()
    expect(
      screen.getByText('MCP transport unavailable: local MCP server connection was refused.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/^warning$/i)).not.toBeInTheDocument()
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
            title: DEFAULT_THREAD_TITLE,
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
            title: DEFAULT_THREAD_TITLE,
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
            title: DEFAULT_THREAD_TITLE,
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
            title: DEFAULT_THREAD_TITLE,
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
            title: DEFAULT_THREAD_TITLE,
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

  it('renders file-change approvals as embedded diffs and shows a spinner on the chosen action', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    window.agentApi.respondToApproval = vi.fn(() => new Promise<void>(() => {}))
    mockThreadSnapshotWithActivities([
      {
        id: 'approval:approval-1',
        kind: 'approval.requested',
        tone: 'approval',
        summary: 'src/app.ts',
        payload: {
          requestType: 'file_change_approval',
          args: {
            item: {
              changes: [
                {
                  path: 'src/app.ts',
                  diff: 'not a parseable patch\n+new line\n'
                }
              ]
            }
          }
        },
        turnId: 'turn-1',
        sequence: 1,
        resolved: false,
        createdAt: '2026-04-19T00:00:00.000Z'
      }
    ])

    const { container } = render(<RouterProvider router={router} />)
    await user.click((await screen.findAllByRole('button', { name: /add project/i }))[0])

    expect(await screen.findByRole('button', { name: /app\.ts/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText(/\+new line/i)).toBeInTheDocument()

    const approve = screen.getByRole('button', { name: /approve/i })
    await user.click(approve)

    expect(window.agentApi.respondToApproval).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'approval-1', decision: 'accept' })
    )
    expect(approve).toBeDisabled()
    expect(screen.getByRole('button', { name: /decline/i })).toBeDisabled()
    expect(container.querySelector('.button-spinner')).toBeInTheDocument()
  })

  it('does not render a separate transcript row for resolved approvals', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    mockThreadSnapshotWithActivities([
      {
        id: 'approval:approval-1',
        kind: 'approval.resolved',
        tone: 'info',
        summary: 'src/app.ts',
        payload: {
          requestType: 'file_change_approval',
          decision: 'accept',
          args: {
            item: {
              changes: [
                {
                  path: 'src/app.ts',
                  diff: 'not a parseable patch\n+new line\n'
                }
              ]
            }
          }
        },
        turnId: 'turn-1',
        sequence: 1,
        resolved: true,
        createdAt: '2026-04-19T00:00:00.000Z'
      }
    ])

    const { container } = render(<RouterProvider router={router} />)
    await user.click((await screen.findAllByRole('button', { name: /add project/i }))[0])

    expect(screen.queryByLabelText('approved')).not.toBeInTheDocument()
    expect(container.querySelector('.approval-resolution-line')).not.toBeInTheDocument()
    expect(container.querySelector('.embedded-diff-card')).not.toBeInTheDocument()
    expect(container.querySelector('.activity-row.approval')).not.toBeInTheDocument()
  })

  it('renders command approvals as a subtle single prompt', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    mockThreadSnapshotWithActivities([
      {
        id: 'approval:approval-1',
        kind: 'approval.requested',
        tone: 'approval',
        summary: 'bun test',
        payload: { requestType: 'command_execution_approval' },
        turnId: 'turn-1',
        sequence: 1,
        resolved: false,
        createdAt: '2026-04-19T00:00:00.000Z'
      }
    ])

    const { container } = render(<RouterProvider router={router} />)
    await user.click((await screen.findAllByRole('button', { name: /add project/i }))[0])

    expect(await screen.findByText('bun test')).toBeInTheDocument()
    expect(container.querySelector('.approval-prompt')).toBeInTheDocument()
    expect(container.querySelector('.embedded-diff-card')).not.toBeInTheDocument()
  })

  it('opens projects and deletes the active chat from controls', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])
    expect(window.agentApi.openWorkspaceFolder).toHaveBeenCalled()
    expect(await screen.findByText('Cobel')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /delete new thread/i }))
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Delete "${DEFAULT_THREAD_TITLE}"?`)
    )
    expect(window.agentApi.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thread.delete',
        threadId: expect.stringMatching(/^project:/)
      })
    )
  })

  it('deletes a sidebar thread from the hover action', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    const openFolderButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(openFolderButtons[0])

    await user.click(await screen.findByRole('button', { name: /delete new thread/i }))

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Delete "${DEFAULT_THREAD_TITLE}"?`)
    )
    expect(window.agentApi.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thread.delete',
        threadId: expect.stringMatching(/^project:/)
      })
    )
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /delete new thread/i })).not.toBeInTheDocument()
    })
    confirmSpy.mockRestore()
  })

  it('orders sidebar threads from latest to oldest and reveals older items with Show More', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))
    const projectId = 'project:demo'
    const projectPath = '/Users/ankush/codespace/gencode'
    const snapshot: OrchestrationShellSnapshot = {
      projects: [
        {
          id: projectId,
          name: 'demo',
          path: projectPath,
          createdAt: '2026-04-19T00:00:00.000Z',
          updatedAt: '2026-04-19T00:00:00.000Z',
          archivedAt: null
        }
      ],
      threads: [3, 9, 1, 7, 4, 8, 2, 6, 5].map((index) => ({
        id: `thread-${index}`,
        projectId,
        title: `Thread ${index}`,
        cwd: projectPath,
        branch: 'main',
        latestTurnId: null,
        sessionStatus: 'idle' as const,
        createdAt: `2026-04-19T00:0${index}:00.000Z`,
        updatedAt: `2026-04-19T00:0${index}:00.000Z`,
        archivedAt: null
      }))
    }

    vi.mocked(window.agentApi.subscribeShell).mockImplementationOnce((listener) => {
      listener({ kind: 'snapshot', snapshot })
      return vi.fn()
    })
    vi.mocked(window.agentApi.getShellSnapshot).mockResolvedValueOnce(snapshot)
    vi.mocked(window.agentApi.subscribeThread).mockImplementation((input, listener) => {
      listener({
        kind: 'snapshot',
        snapshot: {
          snapshotSequence: 1,
          thread: createTestThread({
            id: input.threadId,
            title: snapshot.threads.find((thread) => thread.id === input.threadId)?.title ?? input.threadId
          })
        }
      })
      return vi.fn()
    })

    const { container } = render(<RouterProvider router={router} />)

    await user.click(await screen.findByRole('button', { name: /^demo$/i }))

    const visibleLabels = Array.from(container.querySelectorAll<HTMLElement>('.thread-link .thread-label'))
    expect(visibleLabels.map((label) => label.textContent)).toEqual([
      'Thread 9',
      'Thread 8',
      'Thread 7',
      'Thread 6',
      'Thread 5',
      'Thread 4',
      'Thread 3'
    ])
    expect(container.querySelector('.thread-row.active .thread-label')).toHaveTextContent('Thread 9')
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument()
    expect(screen.queryByText('Thread 2')).not.toBeInTheDocument()
    expect(screen.queryByText('Thread 1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show more/i }))

    const expandedLabels = Array.from(container.querySelectorAll<HTMLElement>('.thread-link .thread-label'))
    expect(expandedLabels.map((label) => label.textContent)).toEqual([
      'Thread 9',
      'Thread 8',
      'Thread 7',
      'Thread 6',
      'Thread 5',
      'Thread 4',
      'Thread 3',
      'Thread 2',
      'Thread 1'
    ])
  })

  it('creates a new thread in the clicked project, not the previously active one', async () => {
    const user = userEvent.setup()
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    vi.mocked(window.agentApi.openWorkspaceFolder)
      .mockResolvedValueOnce({
        path: '/Users/ankush/codespace/gencode',
        name: 'gencode'
      })
      .mockResolvedValueOnce({
        path: '/Users/ankush/codespace/other-project',
        name: 'other-project'
      })

    render(<RouterProvider router={router} />)

    const addProjectButtons = await screen.findAllByRole('button', { name: /add project/i })
    await user.click(addProjectButtons[0])
    await user.click(screen.getByRole('button', { name: /add project/i }))

    await waitFor(() => {
      expect(document.querySelectorAll('.project-group')).toHaveLength(2)
    })

    const projectSections = Array.from(document.querySelectorAll<HTMLElement>('.project-group'))

    const secondProject = projectSections.find((section) =>
      within(section).queryByText('other-project')
    )
    expect(secondProject).toBeTruthy()

    const dispatchCommand = vi.mocked(window.agentApi.dispatchCommand)
    const dispatchCallsBefore = dispatchCommand.mock.calls.length

    const newThreadButton =
      (secondProject as HTMLElement).querySelector<HTMLButtonElement>('.project-new-thread')
    expect(newThreadButton).not.toBeNull()
    await user.click(newThreadButton as HTMLButtonElement)

    const threadCreateCall = dispatchCommand.mock.calls
      .slice(dispatchCallsBefore)
      .map(([input]) => input)
      .find((input) => input.type === 'thread.create')

    expect(threadCreateCall).toEqual(
      expect.objectContaining({
        type: 'thread.create',
        projectId: 'users-ankush-codespace-other-project',
        cwd: '/Users/ankush/codespace/other-project'
      })
    )
  })

  it('resizes the sidebar without showing a collapse control', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))

    render(<RouterProvider router={router} />)

    await screen.findByRole('heading', { name: /open a project/i })
    const shell = document.querySelector('.agent-shell')
    const resizeHandle = await screen.findByRole('separator', { name: /resize sidebar/i })

    expect(shell).toHaveStyle({ '--sidebar-width': '290px' })
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /expand sidebar/i })).not.toBeInTheDocument()

    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' })

    await waitFor(() => {
      expect(resizeHandle).toHaveAttribute('aria-valuenow', '302')
      expect(localStorage.getItem('cobel.sidebar-width.v1')).toBe('302')
    })
  })
})

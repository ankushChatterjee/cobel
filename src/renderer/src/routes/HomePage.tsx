import {
  FormEvent,
  KeyboardEvent,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Plus,
  RotateCcw,
  Square,
  ExternalLink,
  FilePen
} from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/hljs/diff'
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json'
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python'
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust'
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript'
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml'
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml'
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs'
import type {
  ModelInfo,
  OpenWorkspaceFolderResult,
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProjectSummary,
  ProviderSummary,
  RuntimeMode,
  ThreadShellSummary
} from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'

const activeSelectionKey = 'patronus.active.v1'
const legacyActiveSelectionKey = 'gencode.active.v1'
const legacyWorkspaceKey = 'gencode.workspace.v1'

SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('diff', diff)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('xml', xml)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)

const runtimeModes: Array<{ value: RuntimeMode; label: string }> = [
  { value: 'approval-required', label: 'Guarded' },
  { value: 'auto-accept-edits', label: 'Write' },
  { value: 'full-access', label: 'Full access' }
]
const composerSpacerStyle = { flex: 1 }

interface ActiveSelection {
  activeProjectId: string | null
  activeChatId: string | null
}

function loadActiveSelection(): ActiveSelection {
  try {
    const storedSelection =
      localStorage.getItem(activeSelectionKey) ?? localStorage.getItem(legacyActiveSelectionKey)
    const parsed = JSON.parse(storedSelection ?? 'null') as ActiveSelection | null
    if (!parsed) return { activeProjectId: null, activeChatId: null }
    return {
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null,
      activeChatId: typeof parsed.activeChatId === 'string' ? parsed.activeChatId : null
    }
  } catch {
    return { activeProjectId: null, activeChatId: null }
  }
}

function saveActiveSelection(selection: ActiveSelection): void {
  localStorage.setItem(activeSelectionKey, JSON.stringify(selection))
}

function runLegacyMigration(loadedShell: OrchestrationShellSnapshot): void {
  const raw = localStorage.getItem(legacyWorkspaceKey)
  if (!raw) return
  if (loadedShell.projects.length > 0) {
    // Backend already has data — just clear the legacy key
    localStorage.removeItem(legacyWorkspaceKey)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    localStorage.removeItem(legacyWorkspaceKey)
    return
  }
  const legacy = parsed as {
    projects?: Array<{
      id: string
      name: string
      path: string
      chats?: Array<{ id: string; label: string; createdAt: string }>
    }>
    activeProjectId?: string
    activeChatId?: string
  }
  if (!Array.isArray(legacy.projects)) {
    localStorage.removeItem(legacyWorkspaceKey)
    return
  }
  const migrateAsync = async (): Promise<void> => {
    const createdAt = new Date().toISOString()
    for (const project of legacy.projects ?? []) {
      if (typeof project.id !== 'string' || typeof project.path !== 'string') continue
      await window.agentApi.dispatchCommand({
        type: 'project.create',
        commandId: `cmd:${createId()}`,
        projectId: project.id,
        name: project.name ?? project.path,
        path: project.path,
        createdAt
      })
      for (const chat of project.chats ?? []) {
        if (typeof chat.id !== 'string') continue
        await window.agentApi.dispatchCommand({
          type: 'thread.create',
          commandId: `cmd:${createId()}`,
          threadId: chat.id,
          projectId: project.id,
          title: chat.label ?? 'New chat',
          cwd: project.path,
          createdAt: chat.createdAt ?? createdAt
        })
      }
    }
  }
  void migrateAsync().finally(() => {
    localStorage.removeItem(legacyWorkspaceKey)
  })
}

export function HomePage(): React.JSX.Element {
  const [shell, setShell] = useState<OrchestrationShellSnapshot>({ projects: [], threads: [] })
  const [selection, setSelection] = useState<ActiveSelection>(loadActiveSelection)
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(() => new Set())
  const [thread, setThread] = useState<OrchestrationThread | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [composerResetToken, setComposerResetToken] = useState(0)
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('auto-accept-edits')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState<string>('')
  const lastSequenceRef = useRef(0)
  const conversationRef = useRef<HTMLElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const pendingUserMessagesRef = useRef(new Map<string, OrchestrationMessage>())
  const [error, setError] = useState<string | null>(null)
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set())
  const [isPendingThinking, setIsPendingThinking] = useState(false)

  const activeProject = useMemo(
    () => shell.projects.find((p) => p.id === selection.activeProjectId) ?? null,
    [shell.projects, selection.activeProjectId]
  )
  const activeChat = useMemo(
    () =>
      shell.threads.find(
        (t) => t.projectId === selection.activeProjectId && t.id === selection.activeChatId
      ) ?? null,
    [shell.threads, selection.activeProjectId, selection.activeChatId]
  )
  const activeThreadId = activeChat?.id ?? null
  const activeProvider = providers[0]
  const sessionStatus = thread?.session?.status ?? 'idle'
  const activeTurnId = thread?.session?.activeTurnId
  const isRunning = sessionStatus === 'starting' || sessionStatus === 'running'
  const sessionError =
    thread?.session?.status === 'error' ? (thread.session.lastError ?? null) : null
  const transcriptItems = useMemo(() => buildTranscriptItems(thread), [thread])
  const hasActiveThinkingActivity = useMemo(
    () =>
      thread?.activities.some((activity) => isThinkingActivity(activity) && !activity.resolved) ??
      false,
    [thread]
  )
  const showPendingThinking = isPendingThinking && !hasActiveThinkingActivity

  useEffect(() => {
    saveActiveSelection(selection)
  }, [selection])

  // Shell subscription: drives sidebar state
  useEffect(() => {
    const unsubscribe = window.agentApi.subscribeShell((item) => {
      if (item.kind === 'snapshot') {
        setShell(item.snapshot)
        // Auto-open the active project
        if (item.snapshot.projects.length > 0) {
          setOpenProjectIds((prev) => {
            const next = new Set(prev)
            for (const p of item.snapshot.projects) next.add(p.id)
            return next
          })
        }
        // After loading shell, run one-time localStorage migration
        runLegacyMigration(item.snapshot)
        return
      }
      const { event } = item
      if (event.type === 'shell.project-upserted') {
        setShell((prev) => ({
          ...prev,
          projects: upsertById(prev.projects, event.project)
        }))
        setOpenProjectIds((prev) => new Set([...prev, event.project.id]))
      } else if (event.type === 'shell.project-removed') {
        setShell((prev) => ({
          ...prev,
          projects: prev.projects.filter((p) => p.id !== event.projectId)
        }))
      } else if (event.type === 'shell.thread-upserted') {
        setShell((prev) => ({
          ...prev,
          threads: upsertById(prev.threads, event.thread)
        }))
      } else if (event.type === 'shell.thread-removed') {
        setShell((prev) => ({
          ...prev,
          threads: prev.threads.filter((t) => t.id !== event.threadId)
        }))
      }
    })
    return unsubscribe
  }, [])

  // Provider and model list
  useEffect(() => {
    void window.agentApi
      .listProviders()
      .then(setProviders)
      .catch((providerError) => {
        setError(providerError instanceof Error ? providerError.message : String(providerError))
      })

    void window.agentApi
      .listModels()
      .then((fetched) => {
        if (fetched.length > 0) {
          setModels(fetched)
          setModel((current) => {
            const found = fetched.find((m) => m.id === current)
            return found ? current : (fetched.find((m) => m.isDefault)?.id ?? fetched[0]?.id ?? '')
          })
        }
      })
      .catch((modelError) => {
        console.error('[patronus:listModels]', modelError)
      })
  }, [])

  // Thread subscription for active chat
  useEffect(() => {
    if (!activeThreadId) return undefined

    lastSequenceRef.current = 0
    setIsPendingThinking(false)
    pendingUserMessagesRef.current.clear()
    const unsubscribe = window.agentApi.subscribeThread({ threadId: activeThreadId }, (item) => {
      logUiEvent('ui/thread-stream', item)
      if (item.kind === 'snapshot') {
        if (item.snapshot.snapshotSequence < lastSequenceRef.current) return
        lastSequenceRef.current = item.snapshot.snapshotSequence
        setThread(mergePendingUserMessages(item.snapshot.thread, pendingUserMessagesRef.current))
        if (threadSnapshotHasAssistantResponse(item.snapshot.thread)) {
          setIsPendingThinking(false)
        }
        return
      }

      if (item.event.sequence <= lastSequenceRef.current) return
      lastSequenceRef.current = item.event.sequence
      if (eventHasAssistantResponse(item.event)) {
        setIsPendingThinking(false)
      }
      if (item.event.type === 'thread.message-upserted') {
        pendingUserMessagesRef.current.delete(item.event.message.id)
      }
      setThread((current) =>
        applyOrchestrationEvent(
          current ?? createEmptyThread(item.event.threadId, item.event.createdAt),
          item.event
        )
      )
    })

    return unsubscribe
  }, [activeThreadId])

  useEffect(() => {
    shouldStickToBottomRef.current = true
    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeThreadId])

  useLayoutEffect(() => {
    if (!shouldStickToBottomRef.current) return
    const el = conversationRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [thread])

  const sendPrompt = useCallback(
    async (input: string): Promise<boolean> => {
      if (!input || isRunning) return false
      if (!activeProject || !activeThreadId) {
        setError('Open a project before starting a Codex chat.')
        return false
      }

      shouldStickToBottomRef.current = true
      setError(null)
      setIsPendingThinking(true)
      const commandId = `cmd:${createId()}`
      const createdAt = new Date().toISOString()
      const optimisticMessage: OrchestrationMessage = {
        id: `user:${commandId}`,
        role: 'user',
        text: input,
        turnId: null,
        streaming: false,
        sequence: lastSequenceRef.current + 0.5,
        createdAt,
        updatedAt: createdAt
      }
      pendingUserMessagesRef.current.set(optimisticMessage.id, optimisticMessage)
      setThread((current) =>
        upsertOptimisticUserMessage({
          thread: current,
          threadId: activeThreadId,
          cwd: activeProject.path,
          title: titleFromPrompt(input),
          message: optimisticMessage
        })
      )

      // Rename the chat if it still has the default label
      if (activeChat && activeChat.title === 'New chat') {
        void window.agentApi.dispatchCommand({
          type: 'thread.rename',
          commandId: `cmd:${createId()}`,
          threadId: activeThreadId,
          title: titleFromPrompt(input),
          createdAt
        })
      }

      try {
        await window.agentApi.dispatchCommand({
          type: 'thread.turn.start',
          commandId,
          threadId: activeThreadId,
          provider: 'codex',
          input,
          cwd: activeProject.path,
          model,
          runtimeMode,
          createdAt
        })
      } catch (commandError) {
        setIsPendingThinking(false)
        setError(commandError instanceof Error ? commandError.message : String(commandError))
        return false
      }
      return true
    },
    [activeChat, activeProject, activeThreadId, isRunning, model, runtimeMode]
  )

  const stopSession = useCallback(async (): Promise<void> => {
    if (!activeThreadId) return
    setError(null)
    try {
      await window.agentApi.stopSession({ threadId: activeThreadId })
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError))
    }
  }, [activeThreadId])

  const interruptTurn = useCallback(async (): Promise<void> => {
    if (!activeThreadId) return
    setError(null)
    try {
      await window.agentApi.interruptTurn({
        threadId: activeThreadId,
        turnId: activeTurnId ?? undefined
      })
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError))
    }
  }, [activeThreadId, activeTurnId])

  async function openWorkspaceFolder(): Promise<void> {
    setError(null)
    try {
      if (typeof window.agentApi.openWorkspaceFolder !== 'function') {
        setError(
          'Folder picker is not available yet. Fully restart bun run dev to refresh preload.'
        )
        return
      }
      const folder = await window.agentApi.openWorkspaceFolder()
      if (!folder) return
      await openProject(folder)
    } catch (folderError) {
      setError(readOpenProjectError(folderError))
    }
  }

  async function revealWorkspaceFolder(): Promise<void> {
    if (!activeProject) return
    setError(null)
    try {
      await window.agentApi.revealPath({ path: activeProject.path })
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : String(revealError))
    }
  }

  async function startNewChat(): Promise<void> {
    if (!activeProject) {
      void openWorkspaceFolder()
      return
    }
    const chatId = `project:${activeProject.id}:chat:${createId()}`
    const createdAt = new Date().toISOString()
    await window.agentApi.dispatchCommand({
      type: 'thread.create',
      commandId: `cmd:${createId()}`,
      threadId: chatId,
      projectId: activeProject.id,
      title: 'New chat',
      cwd: activeProject.path,
      createdAt
    })
    setSelection({ activeProjectId: activeProject.id, activeChatId: chatId })
    setComposerResetToken((token) => token + 1)
    setThread(null)
    setIsPendingThinking(false)
    setError(null)
  }

  async function clearCurrentChat(): Promise<void> {
    if (!activeThreadId) return
    setComposerResetToken((token) => token + 1)
    setIsPendingThinking(false)
    setError(null)
    try {
      await window.agentApi.clearThread({ threadId: activeThreadId })
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    }
  }

  function selectProject(project: ProjectSummary): void {
    const isAlreadyActive = selection.activeProjectId === project.id
    setOpenProjectIds((prev) => {
      const next = new Set(prev)
      if (isAlreadyActive) {
        if (next.has(project.id)) next.delete(project.id)
        else next.add(project.id)
      } else {
        next.add(project.id)
      }
      return next
    })
    const firstThread = shell.threads.find((t) => t.projectId === project.id && !t.archivedAt)
    setSelection({
      activeProjectId: project.id,
      activeChatId: firstThread?.id ?? null
    })
    setError(null)
  }

  function selectChat(chat: ThreadShellSummary): void {
    setSelection({ activeProjectId: chat.projectId, activeChatId: chat.id })
    setError(null)
  }

  async function openProject(folder: OpenWorkspaceFolderResult): Promise<void> {
    const projectId = projectIdForPath(folder.path)
    const existing = shell.projects.find((p) => p.id === projectId)
    const createdAt = new Date().toISOString()
    if (!existing) {
      await window.agentApi.dispatchCommand({
        type: 'project.create',
        commandId: `cmd:${createId()}`,
        projectId,
        name: folder.name || folder.path,
        path: folder.path,
        createdAt
      })
      const chatId = `project:${projectId}:chat:${createId()}`
      await window.agentApi.dispatchCommand({
        type: 'thread.create',
        commandId: `cmd:${createId()}`,
        threadId: chatId,
        projectId,
        title: 'New chat',
        cwd: folder.path,
        createdAt
      })
      setSelection({ activeProjectId: projectId, activeChatId: chatId })
    } else {
      const firstThread = shell.threads.find((t) => t.projectId === projectId && !t.archivedAt)
      setSelection({ activeProjectId: projectId, activeChatId: firstThread?.id ?? null })
    }
    setOpenProjectIds((prev) => new Set([...prev, projectId]))
  }

  function handleConversationScroll(): void {
    const element = conversationRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    shouldStickToBottomRef.current = distanceFromBottom < 160
  }

  const toggleToolExpanded = useCallback((activityId: string): void => {
    setExpandedToolIds((current) => {
      const next = new Set(current)
      if (next.has(activityId)) next.delete(activityId)
      else next.add(activityId)
      return next
    })
  }, [])

  const respondToApproval = useCallback(
    (
      activity: OrchestrationThreadActivity,
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
    ) =>
      activeThreadId
        ? window.agentApi.respondToApproval({
            threadId: activeThreadId,
            requestId: requestIdFromActivity(activity),
            decision
          })
        : Promise.resolve(),
    [activeThreadId]
  )

  const respondToUserInput = useCallback(
    (activity: OrchestrationThreadActivity, answer: Record<string, unknown>) =>
      activeThreadId
        ? window.agentApi.respondToUserInput({
            threadId: activeThreadId,
            requestId: requestIdFromActivity(activity),
            answers: answer
          })
        : Promise.resolve(),
    [activeThreadId]
  )

  return (
    <div className="agent-shell" data-theme="linear-dark">
      <aside className="project-sidebar" aria-label="Projects">
        <div className="sidebar-header">
          <div className="sidebar-app-name">patronus</div>
          <button
            type="button"
            className="add-project-button"
            title="Add project"
            aria-label="Add project"
            onClick={openWorkspaceFolder}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>

        <div className="sidebar-scroll">
          {shell.projects.length === 0 ? (
            <div className="sidebar-empty" aria-label="No projects open">
              <p>No projects open</p>
            </div>
          ) : (
            <nav className="project-list" aria-label="Project list">
              {shell.projects.map((project) => {
                const threads = shell.threads.filter(
                  (t) => t.projectId === project.id && !t.archivedAt
                )
                const isOpen = openProjectIds.has(project.id)
                const isActive = project.id === selection.activeProjectId
                return (
                  <section key={project.id} className="project-group">
                    <button
                      type="button"
                      className={`project-toggle ${isActive ? 'active' : ''}`}
                      aria-expanded={isOpen}
                      onClick={() => selectProject(project)}
                    >
                      <span className="disclosure">
                        {isOpen ? (
                          <ChevronDown size={12} strokeWidth={2} />
                        ) : (
                          <ChevronRight size={12} strokeWidth={2} />
                        )}
                      </span>
                      <FolderOpen size={13} strokeWidth={1.8} />
                      <span className="project-name">{project.name}</span>
                    </button>
                    {isOpen ? (
                      <div className="thread-list">
                        {threads.map((chat) => (
                          <button
                            key={chat.id}
                            type="button"
                            className={`thread-link ${chat.id === activeChat?.id ? 'active' : ''}`}
                            onClick={() => selectChat(chat)}
                          >
                            <span className="thread-dot" />
                            <span className="thread-label">{chat.title}</span>
                          </button>
                        ))}
                        <button
                          type="button"
                          className="thread-link new-thread"
                          onClick={() => void startNewChat()}
                        >
                          <Plus size={11} strokeWidth={2} />
                          <span>New chat</span>
                        </button>
                      </div>
                    ) : null}
                  </section>
                )
              })}
            </nav>
          )}
        </div>
      </aside>

      <main className="chat-surface">
        <header className="chat-header">
          <div className="chat-title-group">
            <h1>{activeChat?.title ?? 'Open a project'}</h1>
            <span>
              {activeProject?.name ?? 'no project'} · {sessionStatus}
            </span>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="text-button"
              title="New chat"
              aria-label="New chat"
              onClick={() => void startNewChat()}
            >
              New
            </button>
            <button
              type="button"
              className="text-button"
              title="Clear chat"
              aria-label="Clear chat"
              onClick={() => void clearCurrentChat()}
              disabled={!activeThreadId}
            >
              Clear
            </button>
            <button
              type="button"
              className="icon-button"
              title="Reveal workspace"
              aria-label="Reveal workspace"
              onClick={revealWorkspaceFolder}
              disabled={!activeProject}
            >
              <ExternalLink size={13} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Add project"
              aria-label="Add project"
              onClick={openWorkspaceFolder}
            >
              <FolderOpen size={13} strokeWidth={1.8} />
            </button>
          </div>
        </header>

        <section
          ref={conversationRef}
          className="conversation"
          aria-live="polite"
          onScroll={handleConversationScroll}
        >
          <div className="status-line">
            <span>{sessionStatus}</span>
            <span>{activeProject?.path ?? 'no workspace'}</span>
            <span>
              {activeProvider?.detail ?? activeProvider?.status ?? 'provider probe pending'}
            </span>
          </div>

          {!activeProject ? (
            <div className="empty-state">
              <p>What would you build?</p>
            </div>
          ) : transcriptItems.length === 0 ? (
            <div className="empty-state">
              <p>What would you build?</p>
            </div>
          ) : (
            <TranscriptList
              items={transcriptItems}
              showPendingThinking={showPendingThinking}
              expandedToolIds={expandedToolIds}
              onToggleTool={toggleToolExpanded}
              onApprove={respondToApproval}
              onAnswer={respondToUserInput}
            />
          )}
          {sessionError ? <SessionErrorBanner message={sessionError} /> : null}
          {error ? <p className="error-line">{error}</p> : null}
          <div ref={bottomRef} />
        </section>

        <div className="composer-wrap">
          <ChatComposer
            key={composerResetToken}
            enabled={Boolean(activeProject)}
            isRunning={isRunning}
            runtimeMode={runtimeMode}
            models={models}
            model={model}
            onRuntimeModeChange={setRuntimeMode}
            onModelChange={setModel}
            onSubmitPrompt={sendPrompt}
            onInterrupt={interruptTurn}
            onStop={stopSession}
          />
        </div>
      </main>
    </div>
  )
}

const ChatComposer = memo(function ChatComposer({
  enabled,
  isRunning,
  runtimeMode,
  models,
  model,
  onRuntimeModeChange,
  onModelChange,
  onSubmitPrompt,
  onInterrupt,
  onStop
}: {
  enabled: boolean
  isRunning: boolean
  runtimeMode: RuntimeMode
  models: ModelInfo[]
  model: string
  onRuntimeModeChange: (mode: RuntimeMode) => void
  onModelChange: (model: string) => void
  onSubmitPrompt: (input: string) => Promise<boolean>
  onInterrupt: () => void
  onStop: () => void
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const frame = window.requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    })
    return () => window.cancelAnimationFrame(frame)
  }, [prompt])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      const input = prompt.trim()
      if (!input || isRunning) return
      setPrompt('')
      const accepted = await onSubmitPrompt(input)
      if (!accepted) setPrompt(input)
    },
    [isRunning, onSubmitPrompt, prompt]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        event.currentTarget.form?.requestSubmit()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        const el = event.currentTarget
        const start = el.selectionStart
        const end = el.selectionEnd
        const newVal = prompt.slice(0, start) + '\n' + prompt.slice(end)
        setPrompt(newVal)
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 1
        })
      }
    },
    [prompt]
  )

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="agent-prompt">
        Ask Codex
      </label>
      <textarea
        ref={textareaRef}
        id="agent-prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={enabled ? 'Ask Codex...' : 'Open a project to start chatting...'}
        rows={1}
        disabled={!enabled}
      />
      <div className="composer-footer">
        <FilePen size={12} strokeWidth={1.6} className="composer-icon" />
        <select
          aria-label="Runtime mode"
          className="composer-select"
          value={runtimeMode}
          onChange={(event) => onRuntimeModeChange(event.target.value as RuntimeMode)}
          disabled={!enabled}
        >
          {runtimeModes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
        <span className="composer-divider" />
        <select
          aria-label="Model"
          className="composer-select model-select"
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={!enabled || models.length === 0}
          title={model ? `Model: ${model}` : 'Model list pending'}
        >
          {models.length === 0 ? (
            <option value="">Model list pending</option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.id}
              </option>
            ))
          )}
        </select>
        <span style={composerSpacerStyle} />
        {isRunning ? (
          <div className="run-controls">
            <button type="button" onClick={onInterrupt} title="Interrupt">
              <RotateCcw size={10} strokeWidth={2} />
            </button>
            <button type="button" onClick={onStop} title="Stop">
              <Square size={10} strokeWidth={2} />
            </button>
          </div>
        ) : null}
        <button
          type="submit"
          className="send-button"
          disabled={!enabled || !prompt.trim() || isRunning}
          title="Send (↵)"
        >
          <ArrowUp size={14} strokeWidth={2.5} />
        </button>
      </div>
    </form>
  )
})

type TranscriptItem =
  | {
      id: string
      kind: 'message'
      sequence: number
      createdAt: string
      message: OrchestrationMessage
    }
  | {
      id: string
      kind: 'activity'
      sequence: number
      createdAt: string
      activity: OrchestrationThreadActivity
    }

const TranscriptList = memo(function TranscriptList({
  items,
  showPendingThinking,
  expandedToolIds,
  onToggleTool,
  onApprove,
  onAnswer
}: {
  items: TranscriptItem[]
  showPendingThinking: boolean
  expandedToolIds: Set<string>
  onToggleTool: (activityId: string) => void
  onApprove: (
    activity: OrchestrationThreadActivity,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ) => Promise<void>
  onAnswer: (
    activity: OrchestrationThreadActivity,
    answer: Record<string, unknown>
  ) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="transcript" aria-label="Conversation transcript">
      {items.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          expandedToolIds={expandedToolIds}
          onToggleTool={onToggleTool}
          onApprove={onApprove}
          onAnswer={onAnswer}
        />
      ))}
      {showPendingThinking && (
        <article className="thinking-row is-active" aria-label="Thinking">
          <span className="thinking-spinner" aria-hidden="true" />
          <span>thinking…</span>
        </article>
      )}
    </div>
  )
})

const TranscriptRow = memo(function TranscriptRow({
  item,
  expandedToolIds,
  onToggleTool,
  onApprove,
  onAnswer
}: {
  item: TranscriptItem
  expandedToolIds: Set<string>
  onToggleTool: (activityId: string) => void
  onApprove: (
    activity: OrchestrationThreadActivity,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ) => Promise<void>
  onAnswer: (
    activity: OrchestrationThreadActivity,
    answer: Record<string, unknown>
  ) => Promise<void>
}): React.JSX.Element {
  if (item.kind === 'message') return <MessageRow message={item.message} />

  const { activity } = item
  if (isPendingPrompt(activity)) {
    return <PendingPrompt activity={activity} onApprove={onApprove} onAnswer={onAnswer} />
  }
  if (isThinkingActivity(activity)) return <ThinkingRow activity={activity} />
  if (isRuntimeError(activity)) {
    return <SessionErrorBanner message={activity.summary} />
  }
  if (isToolActivity(activity)) {
    return (
      <ToolRow
        activity={activity}
        expanded={expandedToolIds.has(activity.id)}
        onToggle={() => onToggleTool(activity.id)}
      />
    )
  }
  return <ActivityRow activity={activity} />
})

const ThinkingRow = memo(function ThinkingRow({
  activity
}: {
  activity: OrchestrationThreadActivity
}): React.JSX.Element {
  const isComplete = activity.resolved === true
  return (
    <article
      className={`thinking-row ${isComplete ? 'is-complete' : 'is-active'}`}
      aria-label={isComplete ? 'Thought' : 'Thinking'}
    >
      {!isComplete && <span className="thinking-spinner" aria-hidden="true" />}
      <span>{isComplete ? 'thought' : 'thinking…'}</span>
    </article>
  )
})

const MessageRow = memo(function MessageRow({
  message
}: {
  message: OrchestrationMessage
}): React.JSX.Element {
  const isAssistant = message.role === 'assistant'
  return (
    <article className={`message ${message.role} ${message.streaming ? 'streaming' : ''}`}>
      <div className="message-meta">
        <span>{message.role === 'assistant' ? 'worked' : 'you'}</span>
        <span>{formatTime(message.createdAt)}</span>
      </div>
      {isAssistant ? (
        <MarkdownMessage text={message.text} isStreaming={message.streaming} />
      ) : (
        <p>{message.text}</p>
      )}
    </article>
  )
})

const MarkdownMessage = memo(function MarkdownMessage({
  text,
  isStreaming
}: {
  text: string
  isStreaming: boolean
}): React.JSX.Element {
  const deferredText = useDeferredValue(text)
  const components = useMemo<Components>(
    () => ({
      a({ children, href }) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      },
      code({ children, className }) {
        const code = String(children).replace(/\n$/u, '')
        const language = languageFromClassName(className)
        const isBlock = Boolean(language) || code.includes('\n')
        if (!isBlock) return <code className="markdown-inline-code">{children}</code>
        return <CodeBlock code={code} language={language} isStreaming={isStreaming} />
      },
      pre({ children }) {
        return <>{children}</>
      }
    }),
    [isStreaming]
  )

  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {deferredText}
      </ReactMarkdown>
    </div>
  )
})

const CodeBlock = memo(function CodeBlock({
  code,
  language,
  isStreaming
}: {
  code: string
  language: string | null
  isStreaming: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    }
  }, [])

  function copyCode(): void {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1200)
    })
  }

  if (isStreaming) return <code className="markdown-code-block">{code}</code>

  const highlightedLanguage = normalizeHighlightLanguage(language ?? inferCodeLanguage(code))

  return (
    <div className="markdown-code-wrap">
      <button
        type="button"
        className={`code-copy-button ${copied ? 'copied' : ''}`}
        aria-label={copied ? 'Copied code' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        onClick={copyCode}
      >
        {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
      </button>
      <SyntaxHighlighter
        PreTag="pre"
        CodeTag="code"
        className="markdown-code-pre"
        codeTagProps={{ className: 'markdown-code-block highlighted' }}
        customStyle={{
          margin: 0,
          background: '#24292e',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: '12px 14px'
        }}
        language={highlightedLanguage}
        style={atomOneDark}
        wrapLongLines={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
})

const ToolRow = memo(function ToolRow({
  activity,
  expanded,
  onToggle
}: {
  activity: OrchestrationThreadActivity
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const payload = activity.payload ?? {}
  const data = readPayloadRecord(payload, 'data')
  const itemPayload = readBestItemData(data)
  const output =
    readPayloadString(payload, 'output') ?? readPayloadString(itemPayload, 'aggregatedOutput')
  const detail = readPayloadString(payload, 'detail') ?? readPayloadString(itemPayload, 'cwd')
  const title = readPayloadString(payload, 'title') ?? activity.summary
  const status = statusFromActivity(activity)
  const statusTone = statusToneForTool(status)
  const exitCode = itemPayload['exitCode']
  const durationMs = itemPayload['durationMs']
  const label = labelForActivity(activity)
  return (
    <article
      className={`tool-row ${activity.tone} ${statusTone}`}
      data-item-type={readPayloadString(payload, 'itemType')}
    >
      <button
        type="button"
        className="tool-row-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="tool-disclosure">
          {expanded ? (
            <ChevronDown size={11} strokeWidth={2} />
          ) : (
            <ChevronRight size={11} strokeWidth={2} />
          )}
        </span>
        <span className="tool-kind">{label}</span>
        <span className="tool-title">{title}</span>
        <span className="tool-status">
          <span aria-hidden="true" className="tool-status-dot" />
          {statusLabel(status)}
          {typeof exitCode === 'number' ? ` (exit ${exitCode})` : null}
          {typeof durationMs === 'number' ? ` ${formatDuration(durationMs)}` : null}
        </span>
      </button>
      {expanded ? (
        <div className="tool-details">
          {detail ? <p className="tool-cwd">{detail}</p> : null}
          {output ? <pre className="tool-output">{output}</pre> : null}
          {!detail && !output ? <pre className="tool-output">{formatPayload(payload)}</pre> : null}
        </div>
      ) : null}
    </article>
  )
})

const ActivityRow = memo(function ActivityRow({
  activity
}: {
  activity: OrchestrationThreadActivity
}): React.JSX.Element {
  return (
    <article className={`activity-row ${activity.tone}`}>
      <span>{labelForActivity(activity)}</span>
      <code>{activity.summary}</code>
    </article>
  )
})

const SessionErrorBanner = memo(function SessionErrorBanner({
  message
}: {
  message: string
}): React.JSX.Element {
  return (
    <div className="session-error-banner" role="alert" aria-live="assertive">
      <span className="session-error-icon" aria-hidden="true">
        ⚠
      </span>
      <div className="session-error-body">
        <p className="session-error-title">Codex returned an error</p>
        <p className="session-error-message">{renderTextWithLinks(message)}</p>
      </div>
    </div>
  )
})

function renderTextWithLinks(text: string): React.ReactNode {
  const urlRegex = /https?:\/\/[^\s)]+/g
  const parts: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(
      <a
        key={match.index}
        href={match[0]}
        target="_blank"
        rel="noreferrer"
        className="session-error-link"
      >
        {match[0]}
      </a>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

const PendingPrompt = memo(function PendingPrompt({
  activity,
  onApprove,
  onAnswer
}: {
  activity: OrchestrationThreadActivity
  onApprove: (
    activity: OrchestrationThreadActivity,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ) => Promise<void>
  onAnswer: (
    activity: OrchestrationThreadActivity,
    answer: Record<string, unknown>
  ) => Promise<void>
}): React.JSX.Element {
  const questions = readQuestions(activity)
  return (
    <div className="pending-prompt">
      <span>{activity.kind === 'approval.requested' ? 'approval' : 'input'}</span>
      <p>{activity.summary}</p>
      {activity.kind === 'approval.requested' ? (
        <div className="prompt-actions">
          <button type="button" onClick={() => void onApprove(activity, 'accept')}>
            accept
          </button>
          <button type="button" onClick={() => void onApprove(activity, 'decline')}>
            decline
          </button>
        </div>
      ) : (
        <div className="prompt-actions">
          {(questions[0]?.options ?? []).slice(0, 3).map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => void onAnswer(activity, { [questions[0].id]: option.label })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

function mergePendingUserMessages(
  thread: OrchestrationThread,
  pendingMessages: Map<string, OrchestrationMessage>
): OrchestrationThread {
  if (pendingMessages.size === 0) return thread
  return {
    ...thread,
    messages: Array.from(pendingMessages.values()).reduce(
      (messages, message) => upsertById(messages, message),
      thread.messages
    )
  }
}

function upsertOptimisticUserMessage({
  thread,
  threadId,
  cwd,
  title,
  message
}: {
  thread: OrchestrationThread | null
  threadId: string
  cwd: string
  title: string
  message: OrchestrationMessage
}): OrchestrationThread {
  const now = message.createdAt
  const current =
    thread ??
    createEmptyThread(threadId, now, {
      title,
      cwd
    })
  return {
    ...current,
    title: current.title === 'Chat title' || current.title === 'New chat' ? title : current.title,
    cwd: current.cwd ?? cwd,
    messages: upsertById(current.messages, message),
    updatedAt: now
  }
}

function createEmptyThread(
  threadId: string,
  createdAt: string,
  overrides: { title?: string; cwd?: string } = {}
): OrchestrationThread {
  return {
    id: threadId,
    title: overrides.title ?? 'Chat title',
    cwd: overrides.cwd,
    branch: 'main',
    messages: [],
    activities: [],
    proposedPlans: [],
    session: null,
    latestTurn: null,
    checkpoints: [],
    createdAt,
    updatedAt: createdAt,
    archivedAt: null
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

function buildTranscriptItems(thread: OrchestrationThread | null): TranscriptItem[] {
  if (!thread) return []
  return [
    ...thread.messages.map((message) => ({
      id: `message:${message.id}`,
      kind: 'message' as const,
      sequence: message.sequence ?? Number.MAX_SAFE_INTEGER,
      createdAt: message.createdAt,
      message
    })),
    ...thread.activities
      .filter((activity) => !isHiddenActivity(activity))
      .map((activity) => ({
        id: `activity:${activity.id}`,
        kind: 'activity' as const,
        sequence: activity.sequence ?? Number.MAX_SAFE_INTEGER,
        createdAt: activity.createdAt,
        activity
      }))
  ].sort((left, right) => {
    const leftCreatedAt = timestampForSort(left.createdAt)
    const rightCreatedAt = timestampForSort(right.createdAt)
    if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt
    return left.sequence - right.sequence
  })
}

function timestampForSort(value: string): number {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isPendingPrompt(activity: OrchestrationThreadActivity): boolean {
  return (
    (activity.kind === 'approval.requested' || activity.kind === 'user-input.requested') &&
    activity.resolved !== true
  )
}

function isToolActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind.startsWith('tool.')
}

function isRuntimeError(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === 'runtime.error'
}

function isThinkingActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.tone === 'thinking'
}

function isHiddenActivity(activity: OrchestrationThreadActivity): boolean {
  return isThinkingActivity(activity) && activity.resolved === true
}

function threadSnapshotHasAssistantResponse(thread: OrchestrationThread): boolean {
  return (
    thread.messages.some((message) => message.role === 'assistant') ||
    thread.activities.length > 0 ||
    thread.proposedPlans.length > 0 ||
    thread.session?.status === 'ready' ||
    thread.session?.status === 'stopped' ||
    thread.session?.status === 'interrupted' ||
    thread.session?.status === 'error'
  )
}

function eventHasAssistantResponse(event: OrchestrationEvent): boolean {
  if (event.type === 'thread.message-upserted') return event.message.role === 'assistant'
  if (event.type === 'thread.activity-upserted') return true
  if (event.type === 'thread.proposed-plan-upserted') return true
  if (event.type === 'thread.latest-turn-set') {
    return event.latestTurn !== null && event.latestTurn.status !== 'running'
  }
  if (event.type === 'thread.session-set') {
    return (
      event.session?.status === 'ready' ||
      event.session?.status === 'stopped' ||
      event.session?.status === 'interrupted' ||
      event.session?.status === 'error'
    )
  }
  return false
}

function labelForActivity(activity: OrchestrationThreadActivity): string {
  if (activity.kind.includes('approval')) return 'approval'
  if (activity.kind.includes('user-input')) return 'input'
  const itemType = readPayloadString(activity.payload, 'itemType')
  switch (itemType) {
    case 'command_execution':
      return 'terminal'
    case 'file_change':
      return 'edit'
    case 'reasoning':
      return 'thinking'
    case 'web_search':
      return 'search'
    case 'mcp_tool_call':
      return 'mcp'
    case 'dynamic_tool_call':
      return 'tool'
    case 'collab_agent_tool_call':
      return 'agent'
    case 'image_view':
      return 'image'
    case 'review_entered':
    case 'review_exited':
      return 'review'
    case 'context_compaction':
      return 'compact'
    case 'plan':
      return 'plan'
    default:
      break
  }
  if (activity.summary.toLowerCase().includes('terminal')) return 'terminal'
  if (activity.summary.toLowerCase().includes('edit')) return 'edit'
  return 'tool'
}

function statusFromActivity(activity: OrchestrationThreadActivity): string {
  const payloadStatus = readPayloadString(activity.payload, 'status')
  if (activity.kind === 'tool.completed' || activity.kind === 'task.completed') {
    if (payloadStatus === 'failed' || payloadStatus === 'declined') return payloadStatus
    return 'completed'
  }
  if (
    payloadStatus === 'completed' ||
    payloadStatus === 'success' ||
    payloadStatus === 'failed' ||
    payloadStatus === 'declined' ||
    payloadStatus === 'inProgress'
  ) {
    return payloadStatus
  }
  if (activity.resolved === true) {
    if (isToolActivity(activity) || isThinkingActivity(activity)) return 'completed'
    return 'resolved'
  }

  switch (activity.kind) {
    case 'tool.started':
    case 'task.started':
      return 'running'
    case 'tool.updated':
    case 'task.progress':
      return 'running'
    case 'runtime.error':
      return 'error'
    case 'approval.requested':
    case 'user-input.requested':
      return 'waiting'
    case 'approval.resolved':
    case 'user-input.resolved':
      return 'resolved'
    default:
      return 'info'
  }
}

function statusToneForTool(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'completed' || normalized === 'success' || normalized === 'resolved')
    return 'is-complete'
  if (normalized === 'failed' || normalized === 'error' || normalized === 'declined')
    return 'is-error'
  if (normalized === 'waiting') return 'is-waiting'
  return 'is-running'
}

function statusLabel(status: string): string {
  switch (status) {
    case 'inProgress':
      return 'running'
    case 'resolved':
      return 'done'
    default:
      return status
  }
}

function logUiEvent(label: string, payload: unknown): void {
  console.log(`[patronus:${label}]`, payload)
}

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

function readPayloadRecord(
  payload: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> {
  const value = payload?.[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readBestItemData(data: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['item', 'normalized']) {
    const candidate = data[key]
    if (typeof candidate === 'object' && candidate !== null && Object.keys(candidate).length > 0) {
      return candidate as Record<string, unknown>
    }
  }
  return data
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload.data ?? payload, null, 2)
  } catch {
    return String(payload)
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  )
}

function languageFromClassName(className: string | undefined): string | null {
  const match = /language-([^\s]+)/u.exec(className ?? '')
  return match?.[1]?.toLowerCase() ?? null
}

function normalizeHighlightLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'console':
    case 'shell':
    case 'shellsession':
    case 'sh':
    case 'zsh':
      return 'bash'
    case 'tsx':
    case 'typescript':
      return 'ts'
    case 'jsx':
    case 'javascript':
      return 'js'
    case 'html':
    case 'xml':
      return 'xml'
    case 'plaintext':
    case 'text':
    case 'txt':
      return 'plaintext'
    default:
      return language.toLowerCase()
  }
}

function inferCodeLanguage(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) return 'plaintext'

  if (
    /^(import|export)\s/mu.test(trimmed) ||
    /\b(type|interface|enum)\s+\w+/u.test(trimmed) ||
    /:\s*(string|number|boolean|unknown|Promise<|Array<|\w+\[\])/u.test(trimmed) ||
    /\bReact\.JSX\.Element\b/u.test(trimmed)
  ) {
    return 'ts'
  }

  if (
    /\b(function|const|let|var)\s+\w+/u.test(trimmed) ||
    /\b(console\.log|document\.|window\.)/u.test(trimmed)
  ) {
    return 'js'
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // Keep checking other lightweight signals.
    }
  }

  if (/^(bun|npm|pnpm|yarn|git|cd|ls|mkdir|rm|cp|mv|export)\b/mu.test(trimmed)) return 'bash'

  return 'plaintext'
}

function projectIdForPath(path: string): string {
  return (
    path
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/(^-|-$)/gu, '') || 'project'
  )
}

function titleFromPrompt(input: string): string {
  const firstLine = input.trim().split(/\r?\n/u)[0] ?? 'New chat'
  return firstLine.length > 42 ? `${firstLine.slice(0, 39)}...` : firstLine
}

function requestIdFromActivity(activity: OrchestrationThreadActivity): string {
  return activity.id.replace(/^approval:/u, '').replace(/^user-input:/u, '')
}

function readQuestions(activity: OrchestrationThreadActivity): Array<{
  id: string
  options?: Array<{ label: string }>
}> {
  const questions = activity.payload?.questions
  return Array.isArray(questions)
    ? questions
        .map((question) =>
          typeof question === 'object' && question !== null
            ? (question as { id: string; options?: Array<{ label: string }> })
            : null
        )
        .filter((question): question is { id: string; options?: Array<{ label: string }> } =>
          Boolean(question)
        )
    : []
}

function readOpenProjectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('No handler registered')) {
    return 'Project picker is not registered in the running desktop process. Fully restart bun run dev.'
  }
  return message
}

function createId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

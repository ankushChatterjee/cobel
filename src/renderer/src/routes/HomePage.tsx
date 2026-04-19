import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  OpenWorkspaceFolderResult,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderSummary,
  RuntimeMode
} from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'

const workspaceStorageKey = 'gencode.workspace.v1'

const runtimeModes: Array<{ value: RuntimeMode; label: string }> = [
  { value: 'approval-required', label: 'guarded' },
  { value: 'auto-accept-edits', label: 'workspace-write' },
  { value: 'full-access', label: 'full-access' }
]

interface ProjectChat {
  id: string
  label: string
  createdAt: string
}

interface ProjectGroup {
  id: string
  name: string
  path: string
  open: boolean
  chats: ProjectChat[]
}

interface WorkspaceState {
  projects: ProjectGroup[]
  activeProjectId: string | null
  activeChatId: string | null
}

export function HomePage(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => loadWorkspaceState())
  const [thread, setThread] = useState<OrchestrationThread | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [prompt, setPrompt] = useState('')
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('auto-accept-edits')
  const lastSequenceRef = useRef(0)
  const conversationRef = useRef<HTMLElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const pendingUserMessagesRef = useRef(new Map<string, OrchestrationMessage>())
  const [error, setError] = useState<string | null>(null)
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set())

  const activeProject = useMemo(
    () => workspace.projects.find((project) => project.id === workspace.activeProjectId) ?? null,
    [workspace]
  )
  const activeChat = useMemo(
    () => activeProject?.chats.find((chat) => chat.id === workspace.activeChatId) ?? null,
    [activeProject, workspace.activeChatId]
  )
  const activeThreadId = activeChat?.id ?? null
  const activeProvider = providers[0]
  const sessionStatus = thread?.session?.status ?? 'idle'
  const isRunning = sessionStatus === 'starting' || sessionStatus === 'running'
  const transcriptItems = useMemo(() => buildTranscriptItems(thread), [thread])

  useEffect(() => {
    saveWorkspaceState(workspace)
  }, [workspace])

  useEffect(() => {
    void window.agentApi
      .listProviders()
      .then(setProviders)
      .catch((providerError) => {
        setError(providerError instanceof Error ? providerError.message : String(providerError))
      })
  }, [])

  useEffect(() => {
    if (!activeThreadId) return undefined

    lastSequenceRef.current = 0
    pendingUserMessagesRef.current.clear()
    const unsubscribe = window.agentApi.subscribeThread({ threadId: activeThreadId }, (item) => {
      logUiEvent('ui/thread-stream', item)
      if (item.kind === 'snapshot') {
        setThread((current) => {
          if (current && item.snapshot.snapshotSequence < lastSequenceRef.current) {
            return mergePendingUserMessages(current, pendingUserMessagesRef.current)
          }
          lastSequenceRef.current = item.snapshot.snapshotSequence
          return mergePendingUserMessages(item.snapshot.thread, pendingUserMessagesRef.current)
        })
        return
      }

      setThread((current) => {
        if (item.event.sequence <= lastSequenceRef.current) return current
        lastSequenceRef.current = item.event.sequence
        if (item.event.type === 'thread.message-upserted') {
          pendingUserMessagesRef.current.delete(item.event.message.id)
        }
        return applyOrchestrationEvent(
          current ?? createEmptyThread(item.event.threadId, item.event.createdAt),
          item.event
        )
      })
    })

    return unsubscribe
  }, [activeThreadId])

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [transcriptItems.length, thread?.updatedAt])

  async function sendPrompt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const input = prompt.trim()
    if (!input || isRunning) return
    if (!activeProject || !activeThreadId) {
      setError('Open a project before starting a Codex chat.')
      return
    }

    shouldStickToBottomRef.current = true
    setPrompt('')
    setError(null)
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
    try {
      await window.agentApi.dispatchCommand({
        type: 'thread.turn.start',
        commandId,
        threadId: activeThreadId,
        provider: 'codex',
        input,
        cwd: activeProject.path,
        runtimeMode,
        createdAt
      })
      renameActiveChatFromPrompt(input)
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : String(commandError))
      setPrompt(input)
    }
  }

  async function stopSession(): Promise<void> {
    if (!activeThreadId) return
    setError(null)
    try {
      await window.agentApi.stopSession({ threadId: activeThreadId })
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError))
    }
  }

  async function interruptTurn(): Promise<void> {
    if (!activeThreadId) return
    setError(null)
    try {
      await window.agentApi.interruptTurn({
        threadId: activeThreadId,
        turnId: thread?.session?.activeTurnId ?? undefined
      })
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError))
    }
  }

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
      openProject(folder)
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

  function startNewChat(): void {
    if (!activeProject) {
      void openWorkspaceFolder()
      return
    }

    const chat = createChat(activeProject.id, 'New chat')
    setWorkspace((current) => ({
      ...current,
      activeProjectId: activeProject.id,
      activeChatId: chat.id,
      projects: current.projects.map((project) =>
        project.id === activeProject.id
          ? { ...project, open: true, chats: [chat, ...project.chats] }
          : project
      )
    }))
    setPrompt('')
    setThread(null)
    setError(null)
  }

  async function clearCurrentChat(): Promise<void> {
    if (!activeThreadId) return
    setPrompt('')
    setError(null)
    try {
      await window.agentApi.clearThread({ threadId: activeThreadId })
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    }
  }

  function selectProject(project: ProjectGroup): void {
    setWorkspace((current) => ({
      ...current,
      activeProjectId: project.id,
      activeChatId: project.chats[0]?.id ?? null,
      projects: current.projects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              open: candidate.id === current.activeProjectId ? !candidate.open : true
            }
          : candidate
      )
    }))
    setError(null)
  }

  function selectChat(project: ProjectGroup, chat: ProjectChat): void {
    setWorkspace((current) => ({
      ...current,
      activeProjectId: project.id,
      activeChatId: chat.id
    }))
    setError(null)
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.currentTarget.form?.requestSubmit()
    }
  }

  function handleConversationScroll(): void {
    const element = conversationRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    shouldStickToBottomRef.current = distanceFromBottom < 120
  }

  function toggleToolExpanded(activityId: string): void {
    setExpandedToolIds((current) => {
      const next = new Set(current)
      if (next.has(activityId)) next.delete(activityId)
      else next.add(activityId)
      return next
    })
  }

  function openProject(folder: OpenWorkspaceFolderResult): void {
    const project = createProject(folder)
    setWorkspace((current) => {
      const existing = current.projects.find((candidate) => candidate.id === project.id)
      if (existing) {
        return {
          projects: current.projects.map((candidate) =>
            candidate.id === project.id ? { ...candidate, open: true } : candidate
          ),
          activeProjectId: existing.id,
          activeChatId: existing.chats[0]?.id ?? null
        }
      }

      return {
        projects: [project, ...current.projects],
        activeProjectId: project.id,
        activeChatId: project.chats[0]?.id ?? null
      }
    })
  }

  function renameActiveChatFromPrompt(input: string): void {
    if (!activeProject || !activeChat || activeChat.label !== 'New chat') return
    const label = titleFromPrompt(input)
    setWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              chats: project.chats.map((chat) =>
                chat.id === activeChat.id ? { ...chat, label } : chat
              )
            }
          : project
      )
    }))
  }

  return (
    <div className="agent-shell" data-theme="swiss-retro-dark">
      <aside className="project-sidebar" aria-label="Projects">
        <div className="sidebar-header">
          <span>Projects</span>
          <button
            type="button"
            className="add-project-button"
            title="Add project"
            aria-label="Add project"
            onClick={openWorkspaceFolder}
          >
            +
          </button>
        </div>
        {workspace.projects.length === 0 ? (
          <div className="sidebar-empty" aria-label="No projects open">
            <p>No Projects Open</p>
          </div>
        ) : (
          <nav className="project-list" aria-label="Project list">
            {workspace.projects.map((project) => (
              <section key={project.id} className="project-group">
                <button
                  type="button"
                  className={`project-toggle ${project.id === activeProject?.id ? 'active' : ''}`}
                  aria-expanded={project.open}
                  onClick={() => selectProject(project)}
                >
                  <span className="disclosure">{project.open ? '⌄' : '›'}</span>
                  <span className="project-name">{project.name}</span>
                </button>
                {project.open ? (
                  <div className="thread-list">
                    {project.chats.map((chat) => (
                      <button
                        key={chat.id}
                        type="button"
                        className={`thread-link ${chat.id === activeChat?.id ? 'active' : ''}`}
                        onClick={() => selectChat(project, chat)}
                      >
                        {chat.label}
                      </button>
                    ))}
                    <button type="button" className="thread-link new-thread" onClick={startNewChat}>
                      + New chat
                    </button>
                  </div>
                ) : null}
              </section>
            ))}
          </nav>
        )}
      </aside>

      <main className="chat-surface">
        <header className="chat-header">
          <div className="chat-title-group">
            <h1>{activeChat?.label ?? 'Open a project'}</h1>
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
              onClick={startNewChat}
            >
              new
            </button>
            <button
              type="button"
              className="text-button"
              title="Clear chat"
              aria-label="Clear chat"
              onClick={() => void clearCurrentChat()}
              disabled={!activeThreadId}
            >
              clear
            </button>
            <button
              type="button"
              className="icon-button"
              title="Reveal workspace"
              aria-label="Reveal workspace"
              onClick={revealWorkspaceFolder}
              disabled={!activeProject}
            >
              □
            </button>
            <button
              type="button"
              className="icon-button"
              title="Add project"
              aria-label="Add project"
              onClick={openWorkspaceFolder}
            >
              ▣
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
              expandedToolIds={expandedToolIds}
              onToggleTool={toggleToolExpanded}
              onApprove={(activity, decision) =>
                activeThreadId
                  ? window.agentApi.respondToApproval({
                      threadId: activeThreadId,
                      requestId: requestIdFromActivity(activity),
                      decision
                    })
                  : Promise.resolve()
              }
              onAnswer={(activity, answer) =>
                activeThreadId
                  ? window.agentApi.respondToUserInput({
                      threadId: activeThreadId,
                      requestId: requestIdFromActivity(activity),
                      answers: answer
                    })
                  : Promise.resolve()
              }
            />
          )}
          {error ? <p className="error-line">{error}</p> : null}
          <div ref={bottomRef} />
        </section>

        <form className="composer" onSubmit={sendPrompt}>
          <label className="sr-only" htmlFor="agent-prompt">
            Ask Codex
          </label>
          <textarea
            id="agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              activeProject
                ? 'Ask Codex to edit files, run a command, review a diff, or explain this project...'
                : 'Open a project folder to start chatting with Codex...'
            }
            rows={2}
            disabled={!activeProject}
          />
          <div className="composer-footer">
            <input
              aria-label="Workspace path"
              value={activeProject?.path ?? ''}
              readOnly
              className="cwd-input"
              placeholder="No project selected"
            />
            <select
              aria-label="Runtime mode"
              value={runtimeMode}
              onChange={(event) => setRuntimeMode(event.target.value as RuntimeMode)}
              disabled={!activeProject}
            >
              {runtimeModes.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
            {isRunning ? (
              <div className="run-controls">
                <button type="button" onClick={interruptTurn}>
                  interrupt
                </button>
                <button type="button" onClick={stopSession}>
                  stop
                </button>
              </div>
            ) : null}
            <button
              type="submit"
              className="send-button"
              disabled={!activeProject || !prompt.trim() || isRunning}
            >
              send
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

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

function TranscriptList({
  items,
  expandedToolIds,
  onToggleTool,
  onApprove,
  onAnswer
}: {
  items: TranscriptItem[]
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
    </div>
  )
}

function TranscriptRow({
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
  if (isThinkingActivity(activity)) return <ThinkingRow />
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
}

function ThinkingRow(): React.JSX.Element {
  return (
    <article className="thinking-row" aria-label="Thinking">
      <span className="thinking-spinner" aria-hidden="true" />
      <span>Thinking</span>
    </article>
  )
}

function MessageRow({ message }: { message: OrchestrationMessage }): React.JSX.Element {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-meta">
        <span>{message.role === 'assistant' ? 'worked' : 'you'}</span>
        <span>{formatTime(message.createdAt)}</span>
      </div>
      <p>{message.text}</p>
    </article>
  )
}

function ToolRow({
  activity,
  expanded,
  onToggle
}: {
  activity: OrchestrationThreadActivity
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const payload = activity.payload ?? {}
  const output = readPayloadString(payload, 'output')
  const detail = readPayloadString(payload, 'detail')
  const title = readPayloadString(payload, 'title') ?? activity.summary
  const status = readPayloadString(payload, 'status') ?? statusFromActivity(activity)
  const statusTone = statusToneForTool(status)
  return (
    <article className={`tool-row ${activity.tone} ${statusTone}`}>
      <button
        type="button"
        className="tool-row-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="tool-disclosure">{expanded ? '-' : '+'}</span>
        <span className="tool-kind">{labelForActivity(activity)}</span>
        <span className="tool-title">{title}</span>
        <span className="tool-status">
          <span aria-hidden="true" className="tool-status-dot" />
          {statusLabel(status)}
        </span>
      </button>
      {expanded ? (
        <div className="tool-details">
          {detail ? <p>{detail}</p> : null}
          {output ? <pre>{output}</pre> : null}
          {!detail && !output ? <pre>{formatPayload(payload)}</pre> : null}
        </div>
      ) : null}
    </article>
  )
}

function ActivityRow({ activity }: { activity: OrchestrationThreadActivity }): React.JSX.Element {
  return (
    <article className={`activity-row ${activity.tone}`}>
      <span>{labelForActivity(activity)}</span>
      <code>{activity.summary}</code>
    </article>
  )
}

function PendingPrompt({
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
}

function loadWorkspaceState(): WorkspaceState {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(workspaceStorageKey) ?? 'null'
    ) as WorkspaceState | null
    if (!parsed || !Array.isArray(parsed.projects)) return emptyWorkspace()
    const projects = parsed.projects.filter(isProjectGroup)
    const activeProject =
      projects.find((project) => project.id === parsed.activeProjectId) ?? projects[0]
    const activeChat =
      activeProject?.chats.find((chat) => chat.id === parsed.activeChatId) ??
      activeProject?.chats[0]
    return {
      projects,
      activeProjectId: activeProject?.id ?? null,
      activeChatId: activeChat?.id ?? null
    }
  } catch {
    return emptyWorkspace()
  }
}

function saveWorkspaceState(workspace: WorkspaceState): void {
  localStorage.setItem(workspaceStorageKey, JSON.stringify(workspace))
}

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

function emptyWorkspace(): WorkspaceState {
  return { projects: [], activeProjectId: null, activeChatId: null }
}

function isProjectGroup(value: unknown): value is ProjectGroup {
  if (!value || typeof value !== 'object') return false
  const candidate = value as ProjectGroup
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    Array.isArray(candidate.chats)
  )
}

function createProject(folder: OpenWorkspaceFolderResult): ProjectGroup {
  const id = projectIdForPath(folder.path)
  return {
    id,
    name: folder.name || folder.path,
    path: folder.path,
    open: true,
    chats: [createChat(id, 'New chat')]
  }
}

function createChat(projectId: string, label: string): ProjectChat {
  return {
    id: `project:${projectId}:chat:${createId()}`,
    label,
    createdAt: new Date().toISOString()
  }
}

function createId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
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
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  })
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

function isThinkingActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.tone === 'thinking' && activity.summary === 'Thinking'
}

function isHiddenActivity(activity: OrchestrationThreadActivity): boolean {
  return isThinkingActivity(activity) && activity.resolved === true
}

function labelForActivity(activity: OrchestrationThreadActivity): string {
  if (activity.kind.includes('approval')) return 'approval'
  if (activity.kind.includes('user-input')) return 'input'
  const itemType = readPayloadString(activity.payload, 'itemType')
  if (itemType === 'command_execution') return 'terminal'
  if (itemType === 'file_change') return 'edit'
  if (itemType === 'reasoning') return 'thinking'
  if (itemType === 'web_search') return 'search'
  if (activity.summary.toLowerCase().includes('terminal')) return 'terminal'
  if (activity.summary.toLowerCase().includes('edit')) return 'edit'
  return 'tool'
}

function statusFromActivity(activity: OrchestrationThreadActivity): string {
  if (activity.kind === 'tool.completed') return 'completed'
  if (activity.kind === 'tool.started') return 'running'
  if (activity.kind === 'runtime.error') return 'error'
  return 'updated'
}

function statusToneForTool(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'completed' || normalized === 'success') return 'is-complete'
  if (normalized === 'failed' || normalized === 'error' || normalized === 'declined')
    return 'is-error'
  return 'is-running'
}

function statusLabel(status: string): string {
  if (status === 'inProgress') return 'running'
  return status
}

function logUiEvent(label: string, payload: unknown): void {
  console.log(`[gencode:${label}]`, payload)
}

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
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

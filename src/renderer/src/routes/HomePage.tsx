import {
  FormEvent,
  KeyboardEvent,
  memo,
  PointerEvent,
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
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
  Trash2,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Plus,
  RotateCcw,
  Square,
  TriangleAlert,
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
  CheckpointFileChange,
  OrchestrationEvent,
  OrchestrationCheckpointSummary,
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
import {
  ChangedFilePills,
  DiffPreviewPopover,
  DiffReviewSidebar,
  FloatingDiffPill,
  type DiffPanelMode,
  type DiffPreviewState,
  type DiffStyleMode
} from '../components/diff/DiffReview'

const activeSelectionKey = 'cobel.active.v1'
const legacyActiveSelectionKeys = ['patronus.active.v1', 'gencode.active.v1']
const legacyWorkspaceKey = 'gencode.workspace.v1'
const threadComposerPreferencesKey = 'cobel.thread-composer-prefs.v1'
const legacyThreadComposerPreferencesKeys = ['patronus.thread-composer-prefs.v1']
const sidebarWidthKey = 'cobel.sidebar-width.v1'
const legacySidebarWidthKeys = ['patronus.sidebar-width.v1']
const diffPanelWidthKey = 'cobel.diff-panel-width.v1'
const defaultRuntimeMode: RuntimeMode = 'auto-accept-edits'
const defaultSidebarWidth = 290
const minSidebarWidth = 184
const maxSidebarWidth = 420
const defaultDiffPanelWidth = 640
const minDiffPanelWidth = 420
const maxDiffPanelWidth = 920

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
const markdownRemarkPlugins = [remarkGfm]

type ComposerSelectOption = {
  value: string
  label: string
}

const modelTokenLabels: Record<string, string> = {
  gpt: 'GPT',
  codex: 'Codex',
  mini: 'Mini',
  max: 'Max',
  nano: 'Nano',
  turbo: 'Turbo',
  preview: 'Preview'
}

interface ActiveSelection {
  activeProjectId: string | null
  activeChatId: string | null
}

interface ThreadComposerPreference {
  model?: string
  runtimeMode?: RuntimeMode
}

type ThreadComposerPreferenceMap = Record<string, ThreadComposerPreference>

function loadActiveSelection(): ActiveSelection {
  try {
    const storedSelection =
      localStorage.getItem(activeSelectionKey) ??
      legacyActiveSelectionKeys.map((key) => localStorage.getItem(key)).find(Boolean)
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

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === 'approval-required' || value === 'auto-accept-edits' || value === 'full-access'
}

function loadThreadComposerPreferences(): ThreadComposerPreferenceMap {
  try {
    const storedPreferences =
      localStorage.getItem(threadComposerPreferencesKey) ??
      legacyThreadComposerPreferencesKeys.map((key) => localStorage.getItem(key)).find(Boolean)
    const parsed = JSON.parse(storedPreferences ?? 'null') as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return {}
    const preferences: ThreadComposerPreferenceMap = {}
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId || typeof value !== 'object' || !value) continue
      const raw = value as { model?: unknown; runtimeMode?: unknown }
      const model =
        typeof raw.model === 'string' && raw.model.trim().length > 0 ? raw.model : undefined
      const runtimeMode = isRuntimeMode(raw.runtimeMode) ? raw.runtimeMode : undefined
      if (!model && !runtimeMode) continue
      preferences[threadId] = { model, runtimeMode }
    }
    return preferences
  } catch {
    return {}
  }
}

function saveThreadComposerPreferences(preferences: ThreadComposerPreferenceMap): void {
  localStorage.setItem(threadComposerPreferencesKey, JSON.stringify(preferences))
}

function clampSidebarWidth(width: number): number {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)))
}

function loadSidebarWidth(): number {
  try {
    const storedWidth =
      localStorage.getItem(sidebarWidthKey) ??
      legacySidebarWidthKeys.map((key) => localStorage.getItem(key)).find(Boolean)
    if (!storedWidth) return defaultSidebarWidth
    const parsed = Number(storedWidth)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : defaultSidebarWidth
  } catch {
    return defaultSidebarWidth
  }
}

function saveSidebarWidth(width: number): void {
  localStorage.setItem(sidebarWidthKey, String(clampSidebarWidth(width)))
}

function clampDiffPanelWidth(width: number): number {
  return Math.min(maxDiffPanelWidth, Math.max(minDiffPanelWidth, Math.round(width)))
}

function loadDiffPanelWidth(): number {
  try {
    const storedWidth = localStorage.getItem(diffPanelWidthKey)
    if (!storedWidth) return defaultDiffPanelWidth
    const parsed = Number(storedWidth)
    return Number.isFinite(parsed) ? clampDiffPanelWidth(parsed) : defaultDiffPanelWidth
  } catch {
    return defaultDiffPanelWidth
  }
}

function saveDiffPanelWidth(width: number): void {
  localStorage.setItem(diffPanelWidthKey, String(clampDiffPanelWidth(width)))
}

function pickDefaultModel(models: ModelInfo[]): string {
  return models.find((candidate) => candidate.isDefault)?.id ?? models[0]?.id ?? ''
}

function formatModelId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase()
      const mapped = modelTokenLabels[lower]
      if (mapped) return mapped
      if (/^\d+(\.\d+)*$/.test(token)) return token
      if (/^[a-z]{1,3}\d+(\.\d+)*$/i.test(token)) return token.toUpperCase()
      if (/^[a-z]{1,3}$/.test(lower)) return token.toUpperCase()
      return token.charAt(0).toUpperCase() + token.slice(1)
    })
    .join(' ')
}

function canonicalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function getModelDisplayName(modelInfo: Pick<ModelInfo, 'id' | 'name'>): string {
  const name = modelInfo.name?.trim()
  if (name && canonicalizeModelName(name) !== canonicalizeModelName(modelInfo.id)) return name
  return formatModelId(modelInfo.id)
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
  const [threadComposerPreferences, setThreadComposerPreferences] =
    useState<ThreadComposerPreferenceMap>(loadThreadComposerPreferences)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [diffPanelWidth, setDiffPanelWidth] = useState(loadDiffPanelWidth)
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(() => new Set())
  const [thread, setThread] = useState<OrchestrationThread | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [composerResetToken, setComposerResetToken] = useState(0)
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(defaultRuntimeMode)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState<string>('')
  const lastSequenceRef = useRef(0)
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const diffPanelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const conversationRef = useRef<HTMLElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const pendingUserMessagesRef = useRef(new Map<string, OrchestrationMessage>())
  const [error, setError] = useState<string | null>(null)
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set())
  const [isPendingThinking, setIsPendingThinking] = useState(false)
  const [diffPanelOpen, setDiffPanelOpen] = useState(false)
  const [diffPanelMode, setDiffPanelMode] = useState<DiffPanelMode>('full')
  const [diffStyleMode, setDiffStyleMode] = useState<DiffStyleMode>('unified')
  const [diffWrapLines, setDiffWrapLines] = useState(false)
  const [selectedDiffTurnId, setSelectedDiffTurnId] = useState<string | null>(null)
  const [selectedDiffFilePath, setSelectedDiffFilePath] = useState<string | null>(null)
  const [diffPreview, setDiffPreview] = useState<DiffPreviewState | null>(null)
  const [pendingRevertTurnCount, setPendingRevertTurnCount] = useState<number | null>(null)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitSubmitting, setCommitSubmitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [workspaceDiffVersion, setWorkspaceDiffVersion] = useState(0)

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
  const transcriptItems = useMemo(() => buildTranscriptItems(thread), [thread])
  const checkpointByAssistantMessageId = useMemo(
    () => buildCheckpointByAssistantMessageId(thread?.checkpoints ?? []),
    [thread?.checkpoints]
  )
  const sessionError = useMemo(() => readSessionErrorForDisplay(thread), [thread])
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

  useEffect(() => {
    saveThreadComposerPreferences(threadComposerPreferences)
  }, [threadComposerPreferences])

  useEffect(() => {
    saveSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    saveDiffPanelWidth(diffPanelWidth)
  }, [diffPanelWidth])

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
        setModels(fetched)
      })
      .catch((modelError) => {
        console.error('[cobel:listModels]', modelError)
      })
  }, [])

  useEffect(() => {
    if (!activeThreadId) return
    const preferredMode = threadComposerPreferences[activeThreadId]?.runtimeMode
    const sessionRuntimeMode =
      thread?.id === activeThreadId ? (thread.session?.runtimeMode ?? undefined) : undefined
    setRuntimeMode(preferredMode ?? sessionRuntimeMode ?? defaultRuntimeMode)
  }, [activeThreadId, thread, threadComposerPreferences])

  useEffect(() => {
    if (!activeThreadId) return
    const preferredModel = threadComposerPreferences[activeThreadId]?.model
    if (models.length === 0) {
      setModel(preferredModel ?? '')
      return
    }
    const resolvedModel =
      preferredModel && models.some((candidate) => candidate.id === preferredModel)
        ? preferredModel
        : pickDefaultModel(models)
    setModel(resolvedModel)
  }, [activeThreadId, models, threadComposerPreferences])

  const handleRuntimeModeChange = useCallback(
    (nextMode: RuntimeMode) => {
      setRuntimeMode(nextMode)
      if (!activeThreadId) return
      setThreadComposerPreferences((current) => ({
        ...current,
        [activeThreadId]: {
          ...current[activeThreadId],
          runtimeMode: nextMode
        }
      }))
    },
    [activeThreadId]
  )

  const handleModelChange = useCallback(
    (nextModel: string) => {
      setModel(nextModel)
      if (!activeThreadId) return
      setThreadComposerPreferences((current) => ({
        ...current,
        [activeThreadId]: {
          ...current[activeThreadId],
          model: nextModel
        }
      }))
    },
    [activeThreadId]
  )

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

  async function deleteChat(chat: ThreadShellSummary): Promise<void> {
    const confirmed = window.confirm(`Delete "${chat.title}"? This cannot be undone.`)
    if (!confirmed) return

    setError(null)
    const createdAt = new Date().toISOString()
    const fallbackThread =
      shell.threads.find(
        (candidate) =>
          candidate.projectId === chat.projectId &&
          candidate.id !== chat.id &&
          !candidate.archivedAt
      ) ?? null

    if (selection.activeChatId === chat.id) {
      setSelection({
        activeProjectId: chat.projectId,
        activeChatId: fallbackThread?.id ?? null
      })
      setThread(null)
      setComposerResetToken((token) => token + 1)
      setIsPendingThinking(false)
    }

    setThreadComposerPreferences((current) => {
      const next = { ...current }
      delete next[chat.id]
      return next
    })

    try {
      await window.agentApi.dispatchCommand({
        type: 'thread.delete',
        commandId: `cmd:${createId()}`,
        threadId: chat.id,
        createdAt
      })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
      if (selection.activeChatId === chat.id) {
        setSelection({ activeProjectId: chat.projectId, activeChatId: chat.id })
      }
    }
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

  const openDiffPanel = useCallback(
    (input: { mode?: DiffPanelMode; turnId?: string | null; filePath?: string | null } = {}) => {
      setDiffPanelMode(input.mode ?? 'full')
      setSelectedDiffTurnId(input.turnId ?? null)
      setSelectedDiffFilePath(input.filePath ?? null)
      setDiffPanelOpen(true)
      setDiffPreview(null)
    },
    []
  )

  const showDiffPreview = useCallback(
    (summary: OrchestrationCheckpointSummary, file: CheckpointFileChange, rect: DOMRect): void => {
      setDiffPreview({ summary, file, rect })
    },
    []
  )

  const requestRevertToCheckpoint = useCallback((turnCount: number): Promise<void> => {
    setPendingRevertTurnCount(turnCount)
    return Promise.resolve()
  }, [])

  const requestCommitFullChanges = useCallback((): void => {
    setCommitError(null)
    setCommitDialogOpen(true)
  }, [])

  const commitFullChanges = useCallback(
    async (message: string): Promise<void> => {
      if (!activeThreadId) return
      setCommitSubmitting(true)
      setCommitError(null)
      try {
        await window.agentApi.dispatchCommand({
          type: 'thread.checkpoint.commit',
          commandId: `cmd:${createId()}`,
          threadId: activeThreadId,
          message,
          createdAt: new Date().toISOString()
        })
        setCommitDialogOpen(false)
        setWorkspaceDiffVersion((version) => version + 1)
      } catch (commitError) {
        setCommitError(errorMessageForDisplay(commitError))
      } finally {
        setCommitSubmitting(false)
      }
    },
    [activeThreadId]
  )

  const revertToCheckpoint = useCallback(
    async (turnCount: number): Promise<void> => {
      if (!activeThreadId) return
      setError(null)
      try {
        await window.agentApi.dispatchCommand({
          type: 'thread.checkpoint.revert',
          commandId: `cmd:${createId()}`,
          threadId: activeThreadId,
          turnCount,
          createdAt: new Date().toISOString()
        })
        setPendingRevertTurnCount(null)
        setWorkspaceDiffVersion((version) => version + 1)
      } catch (revertError) {
        setError(revertError instanceof Error ? revertError.message : String(revertError))
      }
    },
    [activeThreadId]
  )

  const sidebarStyle = useMemo(
    () =>
      ({
        '--sidebar-width': `${sidebarWidth}px`,
        '--diff-panel-width': `${diffPanelWidth}px`
      }) as CSSProperties,
    [diffPanelWidth, sidebarWidth]
  )

  const startSidebarResize = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      sidebarResizeRef.current = { startX: event.clientX, startWidth: sidebarWidth }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      document.body.classList.add('sidebar-resizing')
    },
    [sidebarWidth]
  )

  const resizeSidebar = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const resize = sidebarResizeRef.current
    if (!resize) return
    setSidebarWidth(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX))
  }, [])

  const stopSidebarResize = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (!sidebarResizeRef.current) return
    sidebarResizeRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    document.body.classList.remove('sidebar-resizing')
  }, [])

  const handleSidebarResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    setSidebarWidth((width) => clampSidebarWidth(width + direction * 12))
  }, [])

  const startDiffPanelResize = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      diffPanelResizeRef.current = { startX: event.clientX, startWidth: diffPanelWidth }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      document.body.classList.add('diff-panel-resizing')
    },
    [diffPanelWidth]
  )

  const resizeDiffPanel = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const resize = diffPanelResizeRef.current
    if (!resize) return
    setDiffPanelWidth(clampDiffPanelWidth(resize.startWidth + resize.startX - event.clientX))
  }, [])

  const stopDiffPanelResize = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (!diffPanelResizeRef.current) return
    diffPanelResizeRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    document.body.classList.remove('diff-panel-resizing')
  }, [])

  const handleDiffPanelResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? 1 : -1
      setDiffPanelWidth((width) => clampDiffPanelWidth(width + direction * 16))
    },
    []
  )

  return (
    <div className="agent-shell" data-theme="linear-dark" style={sidebarStyle}>
      <aside className="project-sidebar" aria-label="Projects">
        <div className="sidebar-header">
          <div className="sidebar-app-name">Cobel</div>
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
                      {isOpen ? (
                        <FolderOpen size={13} strokeWidth={2} />
                      ) : (
                        <Folder size={13} strokeWidth={2} />
                      )}
                      <span className="project-name">{project.name}</span>
                    </button>
                    {isOpen ? (
                      <div className="thread-list">
                        {threads.map((chat) => (
                          <div
                            key={chat.id}
                            className={`thread-row ${chat.id === activeChat?.id ? 'active' : ''}`}
                          >
                            <button
                              type="button"
                              className="thread-link"
                              onClick={() => selectChat(chat)}
                            >
                              <span className="thread-dot" />
                              <span className="thread-label">{chat.title}</span>
                              <span
                                className="thread-used-at"
                                title={`Last used ${formatTime(chat.updatedAt)}`}
                              >
                                {formatThreadLastUsed(chat.updatedAt)}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="thread-delete-button"
                              title={`Delete ${chat.title}`}
                              aria-label={`Delete ${chat.title}`}
                              onClick={() => void deleteChat(chat)}
                            >
                              <Trash2 size={12} strokeWidth={1.9} />
                            </button>
                          </div>
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
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={minSidebarWidth}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onKeyDown={handleSidebarResizeKeyDown}
          onPointerDown={startSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
        />
      </aside>

      <main className={`chat-surface ${diffPanelOpen ? 'diff-open' : ''}`}>
        <header className="chat-header">
          <div className="chat-title-group">
            <h1>{activeChat?.title ?? 'Open a project'}</h1>
            <span>
              <strong className="chat-project-name">{activeProject?.name ?? 'no project'}</strong> ·{' '}
              {sessionStatus}
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

        <div className="chat-primary">
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
                checkpointByAssistantMessageId={checkpointByAssistantMessageId}
                onToggleTool={toggleToolExpanded}
                onApprove={respondToApproval}
                onAnswer={respondToUserInput}
                onPreviewDiff={showDiffPreview}
                onOpenDiff={(turnId, filePath) =>
                  openDiffPanel({ mode: turnId ? 'turn' : 'full', turnId, filePath })
                }
                onRevert={requestRevertToCheckpoint}
              />
            )}
            {sessionError ? <SessionErrorBanner message={sessionError} /> : null}
            {error ? <p className="error-line">{errorMessageForDisplay(error)}</p> : null}
            <div ref={bottomRef} />
          </section>

          <div className="composer-wrap">
            <div className="composer-stack">
              <div className="floating-diff-row">
                <FloatingDiffPill
                  threadId={activeThreadId}
                  summaries={thread?.checkpoints ?? []}
                  workspaceDiffVersion={workspaceDiffVersion}
                  onOpen={() => openDiffPanel({ mode: 'full' })}
                />
              </div>
              <ChatComposer
                key={composerResetToken}
                enabled={Boolean(activeProject)}
                isRunning={isRunning}
                runtimeMode={runtimeMode}
                models={models}
                model={model}
                onRuntimeModeChange={handleRuntimeModeChange}
                onModelChange={handleModelChange}
                onSubmitPrompt={sendPrompt}
                onInterrupt={interruptTurn}
                onStop={stopSession}
              />
            </div>
          </div>
          <DiffPreviewPopover
            preview={diffPreview}
            threadId={activeThreadId}
            onClose={() => setDiffPreview(null)}
            onOpenSidebar={(turnId, filePath) => openDiffPanel({ mode: 'turn', turnId, filePath })}
          />
        </div>
        <DiffReviewSidebar
          open={diffPanelOpen}
          threadId={activeThreadId}
          summaries={thread?.checkpoints ?? []}
          mode={diffPanelMode}
          diffStyle={diffStyleMode}
          wrapLines={diffWrapLines}
          selectedTurnId={selectedDiffTurnId}
          selectedFilePath={selectedDiffFilePath}
          workspaceDiffVersion={workspaceDiffVersion}
          onModeChange={setDiffPanelMode}
          onDiffStyleChange={setDiffStyleMode}
          onWrapLinesChange={setDiffWrapLines}
          onSelectTurn={setSelectedDiffTurnId}
          onSelectFile={setSelectedDiffFilePath}
          onCommitFull={requestCommitFullChanges}
          onClose={() => setDiffPanelOpen(false)}
          resizeLabel="Resize review panel"
          resizeMin={minDiffPanelWidth}
          resizeMax={maxDiffPanelWidth}
          resizeValue={diffPanelWidth}
          onResizeStart={startDiffPanelResize}
          onResizeMove={resizeDiffPanel}
          onResizeEnd={stopDiffPanelResize}
          onResizeKeyDown={handleDiffPanelResizeKeyDown}
        />
        <RevertWarningDialog
          turnCount={pendingRevertTurnCount}
          workspacePath={activeProject?.path ?? thread?.cwd ?? null}
          onCancel={() => setPendingRevertTurnCount(null)}
          onConfirm={(turnCount) => void revertToCheckpoint(turnCount)}
        />
        <CommitMessageDialog
          open={commitDialogOpen}
          workspacePath={activeProject?.path ?? thread?.cwd ?? null}
          error={commitError}
          submitting={commitSubmitting}
          onCancel={() => {
            if (commitSubmitting) return
            setCommitDialogOpen(false)
            setCommitError(null)
          }}
          onConfirm={(message) => void commitFullChanges(message)}
        />
      </main>
    </div>
  )
}

function ComposerDropdown({
  ariaLabel,
  className,
  disabled,
  onChange,
  shortcut,
  shortcutLabel,
  options,
  title,
  value
}: {
  ariaLabel: string
  className: string
  disabled: boolean
  onChange: (value: string) => void
  shortcut?: { key: string; metaKey?: boolean; shiftKey?: boolean }
  shortcutLabel?: string
  options: ComposerSelectOption[]
  title?: string
  value: string
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const activeOption = options.find((option) => option.value === value) ?? options[0]
  const displayLabel = activeOption?.label ?? ''
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === activeOption?.value)
  )

  useEffect(() => {
    if (!isOpen) return
    setHighlightedIndex(activeIndex)
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, isOpen])

  useEffect(() => {
    if (!shortcut || disabled) return

    const handleShortcut = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return
      if (Boolean(shortcut.metaKey) !== event.metaKey) return
      if (Boolean(shortcut.shiftKey) !== event.shiftKey) return
      event.preventDefault()
      setIsOpen(true)
      triggerRef.current?.focus()
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [disabled, shortcut])

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: globalThis.PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setIsOpen(false)
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const moveHighlight = useCallback(
    (direction: 1 | -1): void => {
      setHighlightedIndex((currentIndex) => {
        const nextIndex = (currentIndex + direction + options.length) % options.length
        window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus())
        return nextIndex
      })
    },
    [options.length]
  )

  const openMenu = useCallback((): void => {
    setHighlightedIndex(activeIndex)
    setIsOpen(true)
  }, [activeIndex])

  const chooseOption = useCallback(
    (nextValue: string): void => {
      onChange(nextValue)
      setIsOpen(false)
      triggerRef.current?.focus()
    },
    [onChange]
  )

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu()
      }
    },
    [openMenu]
  )

  const handleOptionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, optionValue: string): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveHighlight(1)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveHighlight(-1)
        return
      }

      if (event.key === 'Home') {
        event.preventDefault()
        setHighlightedIndex(0)
        optionRefs.current[0]?.focus()
        return
      }

      if (event.key === 'End') {
        event.preventDefault()
        const lastIndex = options.length - 1
        setHighlightedIndex(lastIndex)
        optionRefs.current[lastIndex]?.focus()
        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        chooseOption(optionValue)
      }
    },
    [chooseOption, moveHighlight, options.length]
  )

  return (
    <span ref={rootRef} className={`composer-select-shell ${className}`}>
      <select
        aria-label={ariaLabel}
        className="sr-only composer-native-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        tabIndex={-1}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        ref={triggerRef}
        type="button"
        className="composer-select-trigger"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="composer-select-value">{displayLabel}</span>
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {isOpen ? (
        <div className="composer-select-popover" role="listbox" id={listboxId}>
          <div className="composer-select-options">
            {options.map((option, index) => {
              const isSelected = option.value === value
              return (
                <button
                  ref={(node) => {
                    optionRefs.current[index] = node
                  }}
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="composer-select-option"
                  data-highlighted={index === highlightedIndex}
                  onClick={() => chooseOption(option.value)}
                  onFocus={() => setHighlightedIndex(index)}
                  onKeyDown={(event) => handleOptionKeyDown(event, option.value)}
                >
                  <span>{option.label}</span>
                  {isSelected ? <Check size={12} strokeWidth={1.8} aria-hidden="true" /> : null}
                </button>
              )
            })}
          </div>
          {shortcutLabel ? (
            <div className="composer-select-hint" aria-hidden="true">
              <span>Open selector</span>
              <kbd>{shortcutLabel}</kbd>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
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
  const activeModel = useMemo(
    () => models.find((candidate) => candidate.id === model) ?? null,
    [model, models]
  )
  const modelTitle = useMemo(() => {
    if (!model) return 'Model list pending'
    if (activeModel) return `Model: ${getModelDisplayName(activeModel)}`
    return `Model: ${formatModelId(model)}`
  }, [activeModel, model])
  const modelShortcut = useMemo(() => ({ key: 'm', metaKey: true, shiftKey: true }), [])
  const modelOptions = useMemo<ComposerSelectOption[]>(
    () =>
      models.length === 0
        ? [{ value: '', label: 'Model list pending' }]
        : models.map((m) => ({ value: m.id, label: getModelDisplayName(m) })),
    [models]
  )
  const runtimeModeOptions = useMemo<ComposerSelectOption[]>(
    () => runtimeModes.map((mode) => ({ value: mode.value, label: mode.label })),
    []
  )

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
        <ComposerDropdown
          ariaLabel="Runtime mode"
          className="permissions-select-shell"
          value={runtimeMode}
          onChange={(nextValue) => onRuntimeModeChange(nextValue as RuntimeMode)}
          options={runtimeModeOptions}
          disabled={!enabled}
        />
        <span className="composer-divider" />
        <ComposerDropdown
          ariaLabel="Model"
          className="model-select-shell"
          value={model}
          onChange={onModelChange}
          options={modelOptions}
          disabled={!enabled || models.length === 0}
          title={`${modelTitle} (⌘⇧M)`}
          shortcut={modelShortcut}
          shortcutLabel="⌘⇧M"
        />
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
          <ArrowUp size={14} strokeWidth={3} />
        </button>
      </div>
    </form>
  )
})

type MessageTranscriptItem = {
  id: string
  kind: 'message'
  sequence: number
  createdAt: string
  workDurationMs: number | null
  message: OrchestrationMessage
}

type ActivityTranscriptItem = {
  id: string
  kind: 'activity'
  sequence: number
  createdAt: string
  activity: OrchestrationThreadActivity
}

type TranscriptItem = MessageTranscriptItem | ActivityTranscriptItem

type TranscriptRenderGroup =
  | { kind: 'non-tool'; item: TranscriptItem }
  | { kind: 'tool-run'; id: string; activities: ActivityTranscriptItem[] }

function groupTranscriptItems(items: TranscriptItem[]): TranscriptRenderGroup[] {
  const groups: TranscriptRenderGroup[] = []
  let toolRun: ActivityTranscriptItem[] = []

  function flushRun(): void {
    if (toolRun.length === 0) return
    groups.push({
      kind: 'tool-run',
      id: `run:${toolRun[0].id}:${toolRun[toolRun.length - 1].id}`,
      activities: toolRun
    })
    toolRun = []
  }

  for (const item of items) {
    if (item.kind === 'activity' && isToolActivity(item.activity)) {
      toolRun.push(item)
    } else {
      flushRun()
      groups.push({ kind: 'non-tool', item })
    }
  }
  flushRun()
  return groups
}

const TranscriptList = memo(function TranscriptList({
  items,
  showPendingThinking,
  expandedToolIds,
  checkpointByAssistantMessageId,
  onToggleTool,
  onApprove,
  onAnswer,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  items: TranscriptItem[]
  showPendingThinking: boolean
  expandedToolIds: Set<string>
  checkpointByAssistantMessageId: Map<string, OrchestrationCheckpointSummary>
  onToggleTool: (activityId: string) => void
  onApprove: (
    activity: OrchestrationThreadActivity,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ) => Promise<void>
  onAnswer: (
    activity: OrchestrationThreadActivity,
    answer: Record<string, unknown>
  ) => Promise<void>
  onPreviewDiff: (
    summary: OrchestrationCheckpointSummary,
    file: CheckpointFileChange,
    rect: DOMRect
  ) => void
  onOpenDiff: (turnId: string | null, filePath?: string) => void
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  const groups = useMemo(() => groupTranscriptItems(items), [items])
  return (
    <div className="transcript" aria-label="Conversation transcript">
      {groups.map((group) => {
        if (group.kind === 'non-tool') {
          return (
            <TranscriptRow
              key={group.item.id}
              item={group.item}
              checkpointByAssistantMessageId={checkpointByAssistantMessageId}
              onApprove={onApprove}
              onAnswer={onAnswer}
              onPreviewDiff={onPreviewDiff}
              onOpenDiff={onOpenDiff}
              onRevert={onRevert}
            />
          )
        }
        const { id, activities } = group
        if (activities.length === 1) {
          const single = activities[0]
          return (
            <ToolLine
              key={single.id}
              activity={single.activity}
              expanded={expandedToolIds.has(single.activity.id)}
              onToggle={() => onToggleTool(single.activity.id)}
            />
          )
        }
        return (
          <ToolGroup
            key={id}
            activities={activities}
            expandedToolIds={expandedToolIds}
            onToggleTool={onToggleTool}
          />
        )
      })}
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
  checkpointByAssistantMessageId,
  onApprove,
  onAnswer,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  item: TranscriptItem
  checkpointByAssistantMessageId: Map<string, OrchestrationCheckpointSummary>
  onApprove: (
    activity: OrchestrationThreadActivity,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ) => Promise<void>
  onAnswer: (
    activity: OrchestrationThreadActivity,
    answer: Record<string, unknown>
  ) => Promise<void>
  onPreviewDiff: (
    summary: OrchestrationCheckpointSummary,
    file: CheckpointFileChange,
    rect: DOMRect
  ) => void
  onOpenDiff: (turnId: string | null, filePath?: string) => void
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  if (item.kind === 'message') {
    return (
      <MessageRow
        message={item.message}
        workDurationMs={item.workDurationMs}
        checkpointSummary={checkpointByAssistantMessageId.get(item.message.id) ?? null}
        onPreviewDiff={onPreviewDiff}
        onOpenDiff={onOpenDiff}
        onRevert={onRevert}
      />
    )
  }

  const { activity } = item
  if (isPendingPrompt(activity)) {
    return <PendingPrompt activity={activity} onApprove={onApprove} onAnswer={onAnswer} />
  }
  if (isThinkingActivity(activity)) return <ThinkingRow activity={activity} />
  if (isRuntimeError(activity)) {
    return <SessionErrorBanner message={activity.summary} />
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
  message,
  workDurationMs,
  checkpointSummary,
  onPreviewDiff,
  onOpenDiff,
  onRevert
}: {
  message: OrchestrationMessage
  workDurationMs: number | null
  checkpointSummary: OrchestrationCheckpointSummary | null
  onPreviewDiff: (
    summary: OrchestrationCheckpointSummary,
    file: CheckpointFileChange,
    rect: DOMRect
  ) => void
  onOpenDiff: (turnId: string | null, filePath?: string) => void
  onRevert: (turnCount: number) => Promise<void>
}): React.JSX.Element {
  const isAssistant = message.role === 'assistant'
  return (
    <article className={`message ${message.role} ${message.streaming ? 'streaming' : ''}`}>
      <div className="message-meta">
        {isAssistant ? (
          <>
            <span>worked for</span>
            <span>{formatWorkDuration(workDurationMs)}</span>
          </>
        ) : (
          <>
            <span>you</span>
            <span>{formatTime(message.createdAt)}</span>
          </>
        )}
      </div>
      {isAssistant ? (
        <>
          <MarkdownMessage text={message.text} isStreaming={message.streaming} />
          {checkpointSummary ? (
            <ChangedFilePills
              summary={checkpointSummary}
              onPreview={(file, rect) => onPreviewDiff(checkpointSummary, file, rect)}
              onOpenDiff={(filePath) => onOpenDiff(checkpointSummary.turnId, filePath)}
              revertTurnCount={
                checkpointSummary.status === 'ready'
                  ? Math.max(0, checkpointSummary.checkpointTurnCount - 1)
                  : null
              }
              onRevert={onRevert}
            />
          ) : null}
        </>
      ) : (
        <p>{message.text}</p>
      )}
    </article>
  )
})

function RevertWarningDialog({
  turnCount,
  workspacePath,
  onCancel,
  onConfirm
}: {
  turnCount: number | null
  workspacePath: string | null
  onCancel: () => void
  onConfirm: (turnCount: number) => void
}): React.JSX.Element | null {
  useEffect(() => {
    if (turnCount === null) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, turnCount])

  if (turnCount === null) return null

  return (
    <div className="revert-warning-layer" role="presentation">
      <button
        type="button"
        className="revert-warning-scrim"
        aria-label="Cancel revert"
        onClick={onCancel}
      />
      <section
        className="revert-warning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="revert-warning-title"
        aria-describedby="revert-warning-description"
      >
        <div className="revert-warning-icon" aria-hidden="true">
          <TriangleAlert size={15} strokeWidth={2} />
        </div>
        <div className="revert-warning-copy">
          <p className="revert-warning-kicker">Checkpoint {turnCount}</p>
          <h2 id="revert-warning-title">Restore files to this snapshot?</h2>
          <p id="revert-warning-description">
            This only changes files in the worktree. The chat history stays intact, but the restore
            can overwrite or remove changes made by another thread, by you, or by tools since this
            checkpoint.
          </p>
          {workspacePath ? <code>{workspacePath}</code> : null}
        </div>
        <div className="revert-warning-actions">
          <button type="button" className="revert-warning-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="revert-warning-primary"
            onClick={() => onConfirm(turnCount)}
          >
            <RotateCcw size={13} strokeWidth={2} />
            Restore files
          </button>
        </div>
      </section>
    </div>
  )
}

function CommitMessageDialog({
  open,
  workspacePath,
  error,
  submitting,
  onCancel,
  onConfirm
}: {
  open: boolean
  workspacePath: string | null
  error: string | null
  submitting: boolean
  onCancel: () => void
  onConfirm: (message: string) => void
}): React.JSX.Element | null {
  const [message, setMessage] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const trimmedMessage = message.trim()

  useEffect(() => {
    if (!open) {
      setMessage('')
      return
    }
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20)
    return () => window.clearTimeout(focusTimer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, open, submitting])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      if (!trimmedMessage || submitting) return
      onConfirm(trimmedMessage)
    },
    [onConfirm, submitting, trimmedMessage]
  )

  if (!open) return null

  return (
    <div className="commit-dialog-layer" role="presentation">
      <button
        type="button"
        className="commit-dialog-scrim"
        aria-label="Cancel commit"
        onClick={onCancel}
        disabled={submitting}
      />
      <form
        className="commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={handleSubmit}
      >
        <div className="commit-dialog-icon" aria-hidden="true">
          <GitCommitHorizontal size={15} strokeWidth={2} />
        </div>
        <div className="commit-dialog-copy">
          <p className="commit-dialog-kicker">Commit all changes</p>
          <h2 id={titleId}>Commit review diff?</h2>
          <p id={descriptionId}>
            This stages the current workspace changes and creates a Git commit.
          </p>
          {workspacePath ? <code>{workspacePath}</code> : null}
        </div>
        <label className="commit-message-field">
          <span>Message</span>
          <input
            ref={inputRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe the change"
            disabled={submitting}
          />
        </label>
        {error ? <p className="commit-dialog-error">{error}</p> : null}
        <div className="commit-dialog-actions">
          <button
            type="button"
            className="commit-dialog-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="commit-dialog-primary"
            disabled={!trimmedMessage || submitting}
          >
            <GitCommitHorizontal size={13} strokeWidth={2} />
            {submitting ? 'Committing...' : 'Commit'}
          </button>
        </div>
      </form>
    </div>
  )
}

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
      <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={components}>
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

function categorizeToolActivity(activity: OrchestrationThreadActivity): string {
  const label = labelForActivity(activity)
  if (label === 'terminal' || label === 'mcp') return label
  if (label === 'edit') return 'edit'
  if (label === 'search') return 'search'
  if (label === 'web') return 'web'
  if (label === 'image') return 'image'
  if (label === 'review') return 'review'
  if (label === 'compact') return 'compact'
  if (label === 'plan') return 'plan'
  if (label === 'agent') return 'agent'
  const payload = activity.payload ?? {}
  const title = (readPayloadString(payload, 'title') ?? activity.summary).toLowerCase()
  if (title.startsWith('read') || title.startsWith('glob') || label === 'tool') {
    if (title.startsWith('read') || title.startsWith('glob')) return 'read'
  }
  if (title.startsWith('search') || title.startsWith('grep') || title.includes('search'))
    return 'search'
  return label === 'tool' ? 'tool' : label
}

function verbForActivity(activity: OrchestrationThreadActivity): string {
  const payload = activity.payload ?? {}
  const title = readPayloadString(payload, 'title') ?? activity.summary
  const label = labelForActivity(activity)
  if (label === 'edit') return 'Edited'
  if (label === 'terminal') return 'Ran'
  if (label === 'search') return 'Searched for'
  if (label === 'web') return 'Searched web for'
  if (label === 'mcp') return 'Called'
  if (label === 'image') return 'Viewed'
  if (label === 'agent') return 'Spawned agent'
  if (label === 'review') return 'Review'
  if (label === 'compact') return 'Compacted'
  if (label === 'plan') return 'Planned'
  const titleLower = title.toLowerCase()
  if (titleLower.startsWith('read')) return 'Read'
  if (titleLower.startsWith('glob')) return 'Listed'
  if (titleLower.startsWith('search') || titleLower.startsWith('grep')) return 'Searched for'
  const first = label.charAt(0).toUpperCase() + label.slice(1)
  return first
}

function summarizeToolRun(activities: OrchestrationThreadActivity[]): string {
  const categoryCounts = new Map<string, number>()
  const seenOrder: string[] = []
  for (const activity of activities) {
    const cat = categorizeToolActivity(activity)
    if (!categoryCounts.has(cat)) {
      categoryCounts.set(cat, 0)
      seenOrder.push(cat)
    }
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const cat of seenOrder) {
    const n = categoryCounts.get(cat) ?? 0
    if (cat === 'read') parts.push(`Explored ${n} ${n === 1 ? 'file' : 'files'}`)
    else if (cat === 'search') parts.push(`${n} ${n === 1 ? 'search' : 'searches'}`)
    else if (cat === 'terminal') parts.push(`Ran ${n} ${n === 1 ? 'command' : 'commands'}`)
    else if (cat === 'edit') parts.push(`Edited ${n} ${n === 1 ? 'file' : 'files'}`)
    else if (cat === 'web') parts.push(`${n} web ${n === 1 ? 'search' : 'searches'}`)
    else if (cat === 'mcp') parts.push(`${n} MCP ${n === 1 ? 'call' : 'calls'}`)
    else if (cat === 'image') parts.push(`Viewed ${n} ${n === 1 ? 'image' : 'images'}`)
    else if (cat === 'agent') parts.push(`${n} ${n === 1 ? 'agent' : 'agents'}`)
    else parts.push(`${n} tool ${n === 1 ? 'call' : 'calls'}`)
  }
  return parts.join(', ')
}

const ToolLine = memo(function ToolLine({
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
  const verb = verbForActivity(activity)
  const hasDetails = Boolean(detail ?? output)
  const isRunning = statusTone === 'is-running'

  return (
    <article
      className={`tool-line ${statusTone}`}
      data-item-type={readPayloadString(payload, 'itemType')}
    >
      <button
        type="button"
        className="tool-line-summary"
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={hasDetails ? onToggle : undefined}
        style={hasDetails ? undefined : { cursor: 'default' }}
      >
        <span className="tool-line-chevron" aria-hidden="true">
          {isRunning ? (
            <span className="tool-line-spinner" />
          ) : hasDetails ? (
            expanded ? (
              <ChevronDown size={10} strokeWidth={2} />
            ) : (
              <ChevronRight size={10} strokeWidth={2} />
            )
          ) : null}
        </span>
        <span className="tool-line-verb">{verb}</span>
        <span className="tool-line-target">{title}</span>
        <span className="tool-line-meta">{statusLabel(status)}</span>
        {typeof exitCode === 'number' && exitCode !== 0 ? (
          <span className="tool-line-meta">exit {exitCode}</span>
        ) : null}
        {typeof durationMs === 'number' ? (
          <span className="tool-line-meta">{formatDuration(durationMs)}</span>
        ) : null}
      </button>
      {expanded && hasDetails ? (
        <div className="tool-details">
          {detail ? <p className="tool-cwd">{detail}</p> : null}
          {output ? <pre className="tool-output">{output}</pre> : null}
          {!detail && !output ? <pre className="tool-output">{formatPayload(payload)}</pre> : null}
        </div>
      ) : null}
    </article>
  )
})

const ToolGroup = memo(function ToolGroup({
  activities,
  expandedToolIds,
  onToggleTool
}: {
  activities: ActivityTranscriptItem[]
  expandedToolIds: Set<string>
  onToggleTool: (activityId: string) => void
}): React.JSX.Element {
  const activityList = activities.map((a) => a.activity)
  const summary = summarizeToolRun(activityList)
  const allComplete = activityList.every(
    (a) => statusToneForTool(statusFromActivity(a)) === 'is-complete'
  )
  const anyRunning = activityList.some(
    (a) => statusToneForTool(statusFromActivity(a)) === 'is-running'
  )
  const anyError = activityList.some((a) => statusToneForTool(statusFromActivity(a)) === 'is-error')
  const groupTone = anyError
    ? 'is-error'
    : anyRunning
      ? 'is-running'
      : allComplete
        ? 'is-complete'
        : ''

  // Start open while streaming; auto-collapse when the run finishes.
  // User can re-open after collapse.
  const [open, setOpen] = useState(() => anyRunning)
  const userToggledRef = useRef(false)
  const prevRunningRef = useRef(anyRunning)

  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = anyRunning
    if (anyRunning && !wasRunning) {
      // New work started — expand
      setOpen(true)
      userToggledRef.current = false
    } else if (!anyRunning && wasRunning && !userToggledRef.current) {
      // Run just finished and user hasn't manually toggled — collapse
      setOpen(false)
    }
  }, [anyRunning])

  function handleToggle(): void {
    userToggledRef.current = true
    setOpen((v) => !v)
  }

  return (
    <div className={`tool-group ${groupTone}`}>
      <button
        type="button"
        className="tool-group-summary"
        aria-expanded={open}
        onClick={handleToggle}
      >
        <span className="tool-line-chevron" aria-hidden="true">
          {anyRunning ? (
            <span className="tool-line-spinner" />
          ) : open ? (
            <ChevronDown size={10} strokeWidth={2} />
          ) : (
            <ChevronRight size={10} strokeWidth={2} />
          )}
        </span>
        <span className="tool-group-label">{summary}</span>
      </button>
      {open ? (
        <div className="tool-group-body">
          {activities.map((item) => (
            <ToolLine
              key={item.id}
              activity={item.activity}
              expanded={expandedToolIds.has(item.activity.id)}
              onToggle={() => onToggleTool(item.activity.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

const ActivityRow = memo(function ActivityRow({
  activity
}: {
  activity: OrchestrationThreadActivity
}): React.JSX.Element {
  if (activity.kind === 'runtime.warning') {
    return (
      <article className="activity-row warning" aria-label="Warning">
        <span className="activity-row-icon" aria-hidden="true">
          <TriangleAlert size={11} strokeWidth={2.1} />
        </span>
        <code>{activity.summary}</code>
      </article>
    )
  }

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
  const displayMessage = errorMessageForDisplay(message)
  return (
    <div className="session-error-banner" role="alert" aria-live="assertive">
      <span className="session-error-icon" aria-hidden="true">
        ⚠
      </span>
      <div className="session-error-body">
        <p className="session-error-title">Codex returned an error</p>
        <p className="session-error-message">{renderTextWithLinks(displayMessage)}</p>
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
      workDurationMs: workDurationForMessage(message),
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

function buildCheckpointByAssistantMessageId(
  checkpoints: OrchestrationCheckpointSummary[]
): Map<string, OrchestrationCheckpointSummary> {
  const map = new Map<string, OrchestrationCheckpointSummary>()
  for (const checkpoint of checkpoints) {
    if (checkpoint.assistantMessageId) map.set(checkpoint.assistantMessageId, checkpoint)
  }
  return map
}

function workDurationForMessage(message: OrchestrationMessage): number | null {
  if (message.role !== 'assistant') return null
  return durationBetween(message.createdAt, message.updatedAt)
}

function durationBetween(start: string, end: string): number | null {
  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return Math.max(0, endMs - startMs)
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

function readSessionErrorForDisplay(thread: OrchestrationThread | null): string | null {
  const message = thread?.session?.status === 'error' ? (thread.session.lastError ?? null) : null
  if (!message) return null
  const normalizedMessage = normalizeErrorMessage(message)
  const hasMatchingRuntimeError =
    thread?.activities.some(
      (activity) =>
        isRuntimeError(activity) && normalizeErrorMessage(activity.summary) === normalizedMessage
    ) ?? false
  return hasMatchingRuntimeError ? null : message
}

function errorMessageForDisplay(error: unknown): string {
  return sanitizeDisplayedError(error instanceof Error ? error.message : String(error))
}

function sanitizeDisplayedError(message: string): string {
  let normalized = stripAnsi(message).trim().replace(/\s+/g, ' ')
  normalized = normalized.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  normalized = normalized.replace(/^Error:\s*/i, '')
  if (/^No active Codex session for thread:/i.test(normalized)) {
    return 'Codex session ended. Send your message again to start a fresh session.'
  }
  return normalized
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function normalizeErrorMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ')
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
  if (activity.kind === 'runtime.warning') return 'warning'
  if (activity.kind === 'runtime.error') return 'error'
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
  console.log(`[cobel:${label}]`, payload)
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

function formatWorkDuration(ms: number | null): string {
  if (ms === null) return 'a moment'
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatThreadLastUsed(value: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''

  const elapsedMs = Math.max(0, Date.now() - timestamp)
  if (elapsedMs < 60_000) return 'now'
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m`
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h`
  if (elapsedMs < 604_800_000) return `${Math.floor(elapsedMs / 86_400_000)}d`

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(timestamp)
  )
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

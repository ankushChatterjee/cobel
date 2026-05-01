import {
  KeyboardEvent,
  PointerEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  InteractionMode,
  ModelCatalog,
  ModelInfo,
  ProviderSummary,
  OpenWorkspaceFolderResult,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProjectSummary,
  ProviderId,
  ReasoningEffort,
  RuntimeMode,
  ThreadShellSummary
} from '../../../shared/agent'
import { applyOrchestrationEvent } from '../../../shared/orchestrationReducer'
import { DEFAULT_THREAD_TITLE } from '../../../shared/threadTitle'
import {
  DiffPreviewPopover,
  DiffReviewSidebar,
  FloatingDiffPill,
  type DiffPanelMode,
  type DiffPreviewState,
  type DiffStyleMode
} from '../components/diff/DiffReview'
import { ChatComposer } from '../components/home/ChatComposer'
import { NoProjectSplash } from '../components/home/NoProjectSplash'
import { CommitMessageDialog, RevertWarningDialog } from '../components/home/Dialogs'
import { ProjectSidebar } from '../components/home/ProjectSidebar'
import { FloatingTodoPanel, FloatingTodoPill } from '../components/home/TodoPanel'
import { ThreadSidebar, PlanSidebarPanel } from '../components/home/ThreadSidebar'
import { TranscriptList } from '../components/home/transcript'
import { SessionErrorBanner } from '../components/home/transcript'
import { errorMessageForDisplay } from '../components/home/formatUtils'
import {
  filterModelsForProvider,
  getModelEfforts,
  pickDefaultEffort,
  pickDefaultModel
} from '../components/home/modelUtils'
import {
  clampDiffPanelWidth,
  clampSidebarWidth,
  defaultInteractionMode,
  defaultRuntimeMode,
  loadActiveSelection,
  loadDiffPanelWidth,
  loadSidebarWidth,
  loadThreadComposerPreferences,
  maxDiffPanelWidth,
  minDiffPanelWidth,
  saveActiveSelection,
  saveDiffPanelWidth,
  saveSidebarWidth,
  saveThreadComposerPreferences
} from '../components/home/storage'
import {
  buildCheckpointByAssistantMessageId,
  buildPlanImplementationPrompt,
  buildTranscriptItems,
  createEmptyThread,
  createId,
  derivePlanTitle,
  findLatestProposedPlan,
  isOrchestrationModelTurnInProgress,
  mergePendingUserMessages,
  projectIdForPath,
  readSessionErrorForDisplay,
  runLegacyMigration,
  shouldShowTranscriptEndThinkingRow,
  snapshotMergeClearsPendingTurnStart,
  threadsForProject,
  visibleTodoListsForThread,
  upsertById,
  upsertOptimisticUserMessage
} from '../components/home/threadUtils'
import type {
  ActiveSelection,
  ApprovalDecision,
  SidebarTabId,
  ThreadComposerPreferenceMap,
  ThreadSidebarState
} from '../components/home/types'
import { deriveTitleSeed } from '../../../shared/threadTitle'

export function HomePage(): React.JSX.Element {
  const [shell, setShell] = useState<OrchestrationShellSnapshot>({ projects: [], threads: [] })
  const [selection, setSelection] = useState<ActiveSelection>(loadActiveSelection)
  const [threadComposerPreferences, setThreadComposerPreferences] =
    useState<ThreadComposerPreferenceMap>(loadThreadComposerPreferences)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [diffPanelWidth, setDiffPanelWidth] = useState(loadDiffPanelWidth)
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(() => new Set())
  const [thread, setThread] = useState<OrchestrationThread | null>(null)
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null)
  const [providerProbe, setProviderProbe] = useState<ProviderSummary[] | null>(null)
  const [providerProbeError, setProviderProbeError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('codex')
  const [composerResetToken, setComposerResetToken] = useState(0)
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(defaultRuntimeMode)
  const [interactionMode, setInteractionMode] = useState<InteractionMode>(defaultInteractionMode)
  const [model, setModel] = useState<string>('')
  const [effort, setEffort] = useState<ReasoningEffort>('medium')
  const lastSequenceRef = useRef(0)
  const lastCommittedCommandSequenceRef = useRef(0)
  const threadRef = useRef<OrchestrationThread | null>(null)
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const diffPanelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const conversationRef = useRef<HTMLElement | null>(null)
  const transcriptStackRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const todoFloatingUiRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRafRef = useRef(0)
  /** Ignore `onScroll` while we adjust scroll position so smooth/CSS scroll does not clear stick-to-bottom. */
  const suppressConversationScrollRef = useRef(false)
  const shouldStickToBottomRef = useRef(true)
  const pendingUserMessagesRef = useRef(new Map<string, OrchestrationMessage>())
  const [error, setError] = useState<string | null>(null)
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set())
  const [isPendingThinking, setIsPendingThinking] = useState(false)
  const [threadSidebarState, setThreadSidebarState] = useState<Record<string, ThreadSidebarState>>(
    {}
  )
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
  const [submittingApprovals, setSubmittingApprovals] = useState<
    Map<string, ApprovalDecision>
  >(() => new Map())
  const [todoPanelOpen, setTodoPanelOpen] = useState(false)

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
  const activeSidebarScopeKey =
    activeThreadId ?? (activeProject ? `project:${activeProject.id}` : null)
  const providerSummaries = modelCatalog?.providers ?? providerProbe ?? []
  const allCatalogModels = useMemo((): ModelInfo[] => {
    if (!modelCatalog) return []
    const codex = modelCatalog.modelsByProvider.codex ?? []
    const opencode = modelCatalog.modelsByProvider.opencode ?? []
    return [...codex, ...opencode]
  }, [modelCatalog])
  const lockedProviderId = thread?.session?.providerName ?? null
  const providerLocked = useMemo(
    () =>
      Boolean(thread?.messages.some((m) => m.role === 'user') || lockedProviderId),
    [thread?.messages, lockedProviderId]
  )
  const models = useMemo(() => {
    if (providerLocked && lockedProviderId) {
      return filterModelsForProvider(allCatalogModels, lockedProviderId)
    }
    return filterModelsForProvider(allCatalogModels, selectedProvider)
  }, [allCatalogModels, providerLocked, lockedProviderId, selectedProvider])
  const providerStatusLine = useMemo(() => {
    const summary = providerSummaries.find((p) => p.id === selectedProvider)
    return summary?.detail ?? summary?.status ?? 'provider probe pending'
  }, [providerSummaries, selectedProvider])
  const sessionStatus = thread?.session?.status ?? 'idle'
  const activeTurnId = thread?.session?.activeTurnId
  const isBusy = sessionStatus === 'starting' || sessionStatus === 'running'
  const isRunning = sessionStatus === 'running'
  const turnInProgress = useMemo(() => isOrchestrationModelTurnInProgress(thread), [thread])
  const activeSidebarState = activeSidebarScopeKey
    ? threadSidebarState[activeSidebarScopeKey]
    : undefined
  const transcriptItems = useMemo(() => buildTranscriptItems(thread), [thread])
  const latestProposedPlan = useMemo(
    () => findLatestProposedPlan(thread?.proposedPlans ?? [], thread?.latestTurn?.id ?? null),
    [thread?.latestTurn?.id, thread?.proposedPlans]
  )
  const checkpointByAssistantMessageId = useMemo(
    () => buildCheckpointByAssistantMessageId(thread?.checkpoints ?? []),
    [thread?.checkpoints]
  )
  const sessionError = useMemo(() => readSessionErrorForDisplay(thread), [thread])
  const hasActiveThinkingActivity = useMemo(
    () =>
      thread?.activities.some(
        (activity: OrchestrationThreadActivity) =>
          activity.tone === 'thinking' && !activity.resolved
      ) ?? false,
    [thread]
  )
  const showPendingThinking = useMemo(
    () =>
      shouldShowTranscriptEndThinkingRow(thread, {
        isPendingTurnStart: isPendingThinking,
        hasActiveThinkingActivity
      }),
    [thread, isPendingThinking, hasActiveThinkingActivity]
  )
  const workspaceDiffRefreshKey = useMemo(
    () => `${workspaceDiffVersion}:${thread?.updatedAt ?? 'no-thread'}`,
    [thread?.updatedAt, workspaceDiffVersion]
  )
  const visibleTodoLists = useMemo(() => visibleTodoListsForThread(thread), [thread])

  useEffect(() => {
    threadRef.current = thread
  }, [thread])

  useEffect(() => {
    setSubmittingApprovals((current) => {
      if (current.size === 0) return current
      const activeApprovalIds = new Set(
        (thread?.activities ?? [])
          .filter(
            (activity) => activity.kind === 'approval.requested' && activity.resolved !== true
          )
          .map((activity) => activity.id)
      )
      let changed = false
      const next = new Map(current)
      for (const id of current.keys()) {
        if (!activeApprovalIds.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [thread?.activities])

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
        if (item.snapshot.projects.length > 0) {
          setOpenProjectIds((prev) => {
            const next = new Set(prev)
            for (const p of item.snapshot.projects) next.add(p.id)
            return next
          })
        }
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

  useEffect(() => {
    if (!activeProject) {
      setModelCatalog(null)
      setError(null)
      setProviderProbeError(null)
      setProviderProbe(null)
      void window.agentApi
        .listProviders()
        .then((rows) => {
          setProviderProbe(rows)
          setProviderProbeError(null)
        })
        .catch((probeError) => {
          setProviderProbe([])
          setProviderProbeError(
            probeError instanceof Error ? probeError.message : String(probeError)
          )
        })
      return
    }
    setProviderProbeError(null)
    void window.agentApi
      .listModelCatalog()
      .then((catalog) => {
        setModelCatalog(catalog)
        setError(null)
      })
      .catch((catalogError) => {
        setError(catalogError instanceof Error ? catalogError.message : String(catalogError))
      })
  }, [activeProject])

  useEffect(() => {
    if (!activeThreadId) return
    if (providerLocked && lockedProviderId) {
      setSelectedProvider(lockedProviderId)
      return
    }
    const pref = threadComposerPreferences[activeThreadId]?.provider
    setSelectedProvider(pref === 'opencode' ? 'opencode' : 'codex')
  }, [activeThreadId, providerLocked, lockedProviderId, threadComposerPreferences])

  useEffect(() => {
    if (providerLocked) return
    if (models.length > 0) return
    const fallbackProvider =
      allCatalogModels.find((candidate) => candidate.providerId === 'codex')?.providerId ??
      allCatalogModels[0]?.providerId
    if (!fallbackProvider || fallbackProvider === selectedProvider) return
    setSelectedProvider(fallbackProvider)
  }, [allCatalogModels, models.length, providerLocked, selectedProvider])

  useEffect(() => {
    if (!activeThreadId) return
    const preferredMode = threadComposerPreferences[activeThreadId]?.runtimeMode
    const sessionRuntimeMode =
      thread?.id === activeThreadId ? (thread.session?.runtimeMode ?? undefined) : undefined
    setRuntimeMode(preferredMode ?? sessionRuntimeMode ?? defaultRuntimeMode)
  }, [activeThreadId, thread, threadComposerPreferences])

  useEffect(() => {
    if (!activeThreadId) return
    const preferredMode = threadComposerPreferences[activeThreadId]?.interactionMode
    const sessionInteractionMode =
      thread?.id === activeThreadId ? (thread.session?.interactionMode ?? undefined) : undefined
    setInteractionMode(preferredMode ?? sessionInteractionMode ?? defaultInteractionMode)
  }, [activeThreadId, thread, threadComposerPreferences])

  useEffect(() => {
    if (!activeThreadId) return
    const preferredModel = threadComposerPreferences[activeThreadId]?.model
    const sessionModel =
      thread?.id === activeThreadId ? (thread.session?.model ?? undefined) : undefined
    if (models.length === 0) {
      setModel(preferredModel ?? sessionModel ?? '')
      return
    }
    const resolvedModel =
      preferredModel && models.some((candidate) => candidate.id === preferredModel)
        ? preferredModel
        : sessionModel && models.some((candidate) => candidate.id === sessionModel)
          ? sessionModel
        : pickDefaultModel(models)
    setModel(resolvedModel)
  }, [activeThreadId, models, thread, threadComposerPreferences])

  const activeModelInfo = useMemo(
    () => models.find((candidate) => candidate.id === model) ?? null,
    [model, models]
  )

  useEffect(() => {
    if (!activeThreadId) return
    const preferredEffort = threadComposerPreferences[activeThreadId]?.effort
    const supportedEfforts = getModelEfforts(activeModelInfo)
    const resolvedEffort =
      preferredEffort && supportedEfforts.includes(preferredEffort)
        ? preferredEffort
        : pickDefaultEffort(activeModelInfo)
    setEffort(resolvedEffort)
  }, [activeModelInfo, activeThreadId, threadComposerPreferences])

  const handleInteractionModeChange = useCallback(
    (nextMode: InteractionMode) => {
      setInteractionMode(nextMode)
      if (!activeThreadId) return
      setThreadComposerPreferences((current) => ({
        ...current,
        [activeThreadId]: {
          ...current[activeThreadId],
          interactionMode: nextMode
        }
      }))
    },
    [activeThreadId]
  )

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
      const nextModelInfo = allCatalogModels.find((candidate) => candidate.id === nextModel) ?? null
      const providerForModel: ProviderId =
        nextModelInfo?.providerId === 'opencode' ? 'opencode' : 'codex'
      setSelectedProvider(providerForModel)
      const preferredEffort = activeThreadId
        ? threadComposerPreferences[activeThreadId]?.effort
        : undefined
      const supportedEfforts = getModelEfforts(nextModelInfo)
      const nextEffort =
        preferredEffort && supportedEfforts.includes(preferredEffort)
          ? preferredEffort
          : pickDefaultEffort(nextModelInfo)
      setEffort(nextEffort)
      if (!activeThreadId) return
      setThreadComposerPreferences((current) => ({
        ...current,
        [activeThreadId]: {
          ...current[activeThreadId],
          provider: providerForModel,
          model: nextModel,
          effort: nextEffort
        }
      }))
    },
    [activeThreadId, allCatalogModels, threadComposerPreferences]
  )

  const handleEffortChange = useCallback(
    (nextEffort: ReasoningEffort) => {
      setEffort(nextEffort)
      if (!activeThreadId) return
      setThreadComposerPreferences((current) => ({
        ...current,
        [activeThreadId]: {
          ...current[activeThreadId],
          effort: nextEffort
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
      if (item.kind === 'snapshot') {
        if (item.snapshot.snapshotSequence < lastSequenceRef.current) return
        lastSequenceRef.current = item.snapshot.snapshotSequence
        const mergedThread = mergePendingUserMessages(
          item.snapshot.thread,
          pendingUserMessagesRef.current
        )
        threadRef.current = mergedThread
        setThread(mergedThread)
        if (snapshotMergeClearsPendingTurnStart(mergedThread)) {
          setIsPendingThinking(false)
        }
        return
      }

      if (item.event.sequence <= lastSequenceRef.current) return
      lastSequenceRef.current = item.event.sequence
      if (isCommandActivityEvent(item.event)) {
        void window.agentApi
          .appendDebugTrace({
            stage: 'renderer.thread-event.received',
            payload: {
              threadId: item.event.threadId,
              turnId: item.event.activity.turnId ?? null,
              activityId: item.event.activity.id,
              itemId: readCommandItemId(item.event.activity.id),
              itemType:
                typeof item.event.activity.payload?.itemType === 'string'
                  ? item.event.activity.payload.itemType
                  : null,
              title:
                typeof item.event.activity.payload?.title === 'string'
                  ? item.event.activity.payload.title
                  : null,
              summary: item.event.activity.summary,
              status:
                typeof item.event.activity.payload?.status === 'string'
                  ? item.event.activity.payload.status
                  : null,
              activityKind: item.event.activity.kind,
              sequence: item.event.sequence
            }
          })
          .catch(() => {})
      }
      if (item.event.type === 'thread.message-upserted') {
        pendingUserMessagesRef.current.delete(item.event.message.id)
      }
      const currentThread =
        threadRef.current ?? createEmptyThread(item.event.threadId, item.event.createdAt)
      const nextThread = applyOrchestrationEvent(currentThread, item.event)
      threadRef.current = nextThread
      setThread(nextThread)
      if (snapshotMergeClearsPendingTurnStart(nextThread)) {
        setIsPendingThinking(false)
      }
    })

    return unsubscribe
  }, [activeThreadId])

  const scrollConversationToBottomIfStuck = useCallback((): void => {
    if (!shouldStickToBottomRef.current) return
    const el = conversationRef.current
    if (!el) return
    suppressConversationScrollRef.current = true
    el.scrollTop = el.scrollHeight
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        suppressConversationScrollRef.current = false
      })
    })
  }, [])

  const scheduleStickConversationToBottom = useCallback((): void => {
    if (!shouldStickToBottomRef.current) return
    if (stickToBottomRafRef.current !== 0) return
    stickToBottomRafRef.current = window.requestAnimationFrame(() => {
      stickToBottomRafRef.current = 0
      scrollConversationToBottomIfStuck()
    })
  }, [scrollConversationToBottomIfStuck])

  useLayoutEffect(() => {
    scrollConversationToBottomIfStuck()
  }, [thread, scrollConversationToBottomIfStuck])

  useEffect(() => {
    if (!thread) return
    const latestCommandActivity = [...thread.activities]
      .filter(
        (activity) =>
          activity.payload?.itemType === 'command_execution' &&
          typeof activity.sequence === 'number'
      )
      .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))[0]
    if (!latestCommandActivity || typeof latestCommandActivity.sequence !== 'number') return
    if (latestCommandActivity.sequence <= lastCommittedCommandSequenceRef.current) return
    lastCommittedCommandSequenceRef.current = latestCommandActivity.sequence
    void window.agentApi
      .appendDebugTrace({
        stage: 'renderer.thread-state.committed',
        payload: {
          threadId: thread.id,
          turnId: latestCommandActivity.turnId ?? null,
          activityId: latestCommandActivity.id,
          itemId: readCommandItemId(latestCommandActivity.id),
          itemType:
            typeof latestCommandActivity.payload?.itemType === 'string'
              ? latestCommandActivity.payload.itemType
              : null,
          title:
            typeof latestCommandActivity.payload?.title === 'string'
              ? latestCommandActivity.payload.title
              : null,
          summary: latestCommandActivity.summary,
          status:
            typeof latestCommandActivity.payload?.status === 'string'
              ? latestCommandActivity.payload.status
              : null,
          activityKind: latestCommandActivity.kind,
          sequence: latestCommandActivity.sequence
        }
      })
      .catch(() => {})
  }, [thread])

  useEffect(() => {
    const stack = transcriptStackRef.current
    if (!stack || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      scheduleStickConversationToBottom()
    })
    ro.observe(stack)
    return () => {
      ro.disconnect()
      if (stickToBottomRafRef.current !== 0) {
        window.cancelAnimationFrame(stickToBottomRafRef.current)
        stickToBottomRafRef.current = 0
      }
    }
  }, [scheduleStickConversationToBottom])

  useEffect(() => {
    shouldStickToBottomRef.current = true
    const frame = window.requestAnimationFrame(() => {
      scrollConversationToBottomIfStuck()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeThreadId, scrollConversationToBottomIfStuck])

  useEffect(() => {
    setTodoPanelOpen(false)
  }, [activeThreadId])

  useEffect(() => {
    if (visibleTodoLists.length > 0) return
    setTodoPanelOpen(false)
  }, [visibleTodoLists.length])

  useEffect(() => {
    if (!todoPanelOpen) return

    const handlePointerDown = (event: globalThis.PointerEvent): void => {
      if (todoFloatingUiRef.current?.contains(event.target as Node)) return
      setTodoPanelOpen(false)
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setTodoPanelOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [todoPanelOpen])

  const sendPrompt = useCallback(
    async (input: string): Promise<boolean> => {
      if (!input || isBusy) return false
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
      const titleSeed = deriveTitleSeed(input)
      const targetPlanId =
        interactionMode === 'plan' && activeSidebarState?.activeTabId?.startsWith('plan:')
          ? activeSidebarState.activeTabId.slice('plan:'.length)
          : undefined
      setThread((current) =>
        upsertOptimisticUserMessage({
          thread: current,
          threadId: activeThreadId,
          cwd: activeProject.path,
          title: titleSeed,
          message: optimisticMessage
        })
      )

      try {
        await window.agentApi.dispatchCommand({
          type: 'thread.turn.start',
          commandId,
          threadId: activeThreadId,
          provider: selectedProvider,
          input,
          titleSeed,
          cwd: activeProject.path,
          model,
          effort,
          runtimeMode,
          interactionMode,
          targetPlanId,
          createdAt
        })
      } catch (commandError) {
        setIsPendingThinking(false)
        setError(commandError instanceof Error ? commandError.message : String(commandError))
        return false
      }
      return true
    },
    [
      activeProject,
      activeSidebarState?.activeTabId,
      activeThreadId,
      effort,
      isBusy,
      interactionMode,
      model,
      runtimeMode,
      selectedProvider
    ]
  )

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

  async function startNewChat(projectOverride?: ProjectSummary): Promise<void> {
    const targetProject = projectOverride ?? activeProject
    if (!targetProject) {
      void openWorkspaceFolder()
      return
    }
    const chatId = `project:${targetProject.id}:chat:${createId()}`
    const createdAt = new Date().toISOString()
    await window.agentApi.dispatchCommand({
      type: 'thread.create',
      commandId: `cmd:${createId()}`,
      threadId: chatId,
      projectId: targetProject.id,
      title: DEFAULT_THREAD_TITLE,
      cwd: targetProject.path,
      createdAt
    })
    setSelection({ activeProjectId: targetProject.id, activeChatId: chatId })
    setComposerResetToken((token) => token + 1)
    setThread(null)
    setIsPendingThinking(false)
    setError(null)
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
    const firstThread = threadsForProject(shell, project.id)[0] ?? null
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
      threadsForProject(shell, chat.projectId).find((candidate) => candidate.id !== chat.id) ?? null

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
        title: DEFAULT_THREAD_TITLE,
        cwd: folder.path,
        createdAt
      })
      setSelection({ activeProjectId: projectId, activeChatId: chatId })
    } else {
      const firstThread = threadsForProject(shell, projectId)[0] ?? null
      setSelection({ activeProjectId: projectId, activeChatId: firstThread?.id ?? null })
    }
    setOpenProjectIds((prev) => new Set([...prev, projectId]))
  }

  function handleConversationScroll(): void {
    if (suppressConversationScrollRef.current) return
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
    async (
      activity: OrchestrationThreadActivity,
      decision: ApprovalDecision
    ) => {
      if (!activeThreadId) return
      setSubmittingApprovals((current) => new Map(current).set(activity.id, decision))
      try {
        await window.agentApi.respondToApproval({
          threadId: activeThreadId,
          requestId: activity.id.replace(/^approval:/u, '').replace(/^user-input:/u, ''),
          decision
        })
      } catch (approvalError) {
        setSubmittingApprovals((current) => {
          const next = new Map(current)
          next.delete(activity.id)
          return next
        })
        throw approvalError
      }
    },
    [activeThreadId]
  )

  const respondToUserInput = useCallback(
    (activity: OrchestrationThreadActivity, answer: Record<string, unknown>) =>
      activeThreadId
        ? window.agentApi.respondToUserInput({
            threadId: activeThreadId,
            requestId: activity.id.replace(/^approval:/u, '').replace(/^user-input:/u, ''),
            answers: answer
          })
        : Promise.resolve(),
    [activeThreadId]
  )

  const updateActiveSidebarState = useCallback(
    (updater: (current: ThreadSidebarState) => ThreadSidebarState) => {
      if (!activeSidebarScopeKey) return
      setThreadSidebarState((current) => ({
        ...current,
        [activeSidebarScopeKey]: updater(
          current[activeSidebarScopeKey] ?? { open: false, activeTabId: null }
        )
      }))
    },
    [activeSidebarScopeKey]
  )

  const openDiffPanel = useCallback(
    (input: { mode?: DiffPanelMode; turnId?: string | null; filePath?: string | null } = {}) => {
      setDiffPanelMode(input.mode ?? 'full')
      setSelectedDiffTurnId(input.turnId ?? null)
      setSelectedDiffFilePath(input.filePath ?? null)
      updateActiveSidebarState((current) => ({
        ...current,
        open: true,
        activeTabId: 'review'
      }))
      setDiffPreview(null)
    },
    [updateActiveSidebarState]
  )

  const showDiffPreview = useCallback(
    (summary: OrchestrationCheckpointSummary, file: import('../../../shared/agent').CheckpointFileChange, rect: DOMRect): void => {
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

  const refreshDiffReview = useCallback((): void => {
    setWorkspaceDiffVersion((version) => version + 1)
  }, [])

  const implementProposedPlan = useCallback(
    async (plan: OrchestrationProposedPlan): Promise<void> => {
      if (!activeProject || !activeThreadId || isRunning) return
      const executionRuntimeMode =
        threadComposerPreferences[activeThreadId]?.runtimeMode ??
        thread?.session?.runtimeMode ??
        runtimeMode
      const createdAt = new Date().toISOString()
      const implementationPrompt = buildPlanImplementationPrompt(plan.text)
      const titleSeed = `Implement ${derivePlanTitle(plan.text)}`
      setError(null)
      setIsPendingThinking(true)
      setInteractionMode('default')
      setRuntimeMode(executionRuntimeMode)
      setThreadComposerPreferences((current) => ({
        ...current,
        [activeThreadId]: {
          ...current[activeThreadId],
          runtimeMode: executionRuntimeMode,
          interactionMode: 'default'
        }
      }))
      try {
        await window.agentApi.dispatchCommand({
          type: 'thread.turn.start',
          commandId: `cmd:${createId()}`,
          threadId: activeThreadId,
          provider: selectedProvider,
          input: implementationPrompt,
          titleSeed,
          cwd: activeProject.path,
          model,
          effort,
          runtimeMode: executionRuntimeMode,
          interactionMode: 'default',
          createdAt
        })
      } catch (implementError) {
        setIsPendingThinking(false)
        setError(implementError instanceof Error ? implementError.message : String(implementError))
      }
    },
    [
      activeProject,
      activeThreadId,
      effort,
      isRunning,
      model,
      runtimeMode,
      selectedProvider,
      thread?.session?.runtimeMode,
      threadComposerPreferences
    ]
  )

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

  const sidebarTabs = useMemo(
    () => [
      { id: 'review' as const, label: 'Review' },
      ...(thread?.proposedPlans ?? []).map((plan) => ({
        id: `plan:${plan.id}` as const,
        label: derivePlanTitle(plan.text),
        plan
      }))
    ],
    [thread?.proposedPlans]
  )

  const resolvedSidebarTabId = useMemo(() => {
    const preferred = activeSidebarState?.activeTabId
    if (preferred && sidebarTabs.some((tab) => tab.id === preferred)) return preferred
    return 'review' as SidebarTabId
  }, [activeSidebarState?.activeTabId, sidebarTabs])

  useEffect(() => {
    if (!activeThreadId) return
    if (!latestProposedPlan) return
    if (latestProposedPlan.turnId !== thread?.latestTurn?.id) return
    const expectedTabId = `plan:${latestProposedPlan.id}` as SidebarTabId
    if (activeSidebarState?.open && activeSidebarState.activeTabId === expectedTabId) return
    updateActiveSidebarState(() => ({
      open: true,
      activeTabId: expectedTabId
    }))
  }, [
    activeSidebarState?.activeTabId,
    activeSidebarState?.open,
    activeThreadId,
    latestProposedPlan,
    thread?.latestTurn?.id,
    updateActiveSidebarState
  ])

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

  const handleDiffPanelResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? 1 : -1
    setDiffPanelWidth((width) => clampDiffPanelWidth(width + direction * 16))
  }, [])

  return (
    <div className="agent-shell" data-theme="linear-dark" style={sidebarStyle}>
      <ProjectSidebar
        shell={shell}
        selection={selection}
        openProjectIds={openProjectIds}
        sidebarWidth={sidebarWidth}
        onAddProject={() => void openWorkspaceFolder()}
        onSelectProject={selectProject}
        onSelectChat={selectChat}
        onDeleteChat={(chat) => void deleteChat(chat)}
        onNewChat={(project) => void startNewChat(project)}
        onResizeKeyDown={handleSidebarResizeKeyDown}
        onResizeStart={startSidebarResize}
        onResizeMove={resizeSidebar}
        onResizeEnd={stopSidebarResize}
      />

      <main className={`chat-surface ${activeSidebarState?.open ? 'diff-open' : ''}`}>
        <header className="chat-header">
          <div className="chat-title-group">
            <h1>{activeChat?.title ?? 'Open a project'}</h1>
            <span>
              {activeProject ? (
                <>
                  <strong className="chat-project-name">{activeProject.name}</strong> ·{' '}
                  {sessionStatus}
                </>
              ) : (
                'Add a folder from the sidebar to begin'
              )}
            </span>
          </div>
          <div className="header-actions">
            <FloatingDiffPill
              workspacePath={activeProject?.path ?? thread?.cwd ?? null}
              workspaceDiffVersion={workspaceDiffRefreshKey}
              open={activeSidebarState?.open === true && resolvedSidebarTabId === 'review'}
              onToggle={() =>
                activeSidebarState?.open === true && resolvedSidebarTabId === 'review'
                  ? updateActiveSidebarState((current) => ({ ...current, open: false }))
                  : openDiffPanel({ mode: 'full' })
              }
            />
          </div>
        </header>

        <div className="chat-primary">
          <section
            ref={conversationRef}
            className={`conversation${!activeProject ? ' conversation--no-project' : ''}`}
            aria-live="polite"
            onScroll={handleConversationScroll}
          >
            {activeProject ? (
              <div className="status-line">
                <span>{sessionStatus}</span>
                <span>{activeProject.path}</span>
                <span>{providerStatusLine}</span>
              </div>
            ) : null}

            <div ref={transcriptStackRef} className="conversation-transcript-stack">
              {!activeProject ? (
                <NoProjectSplash providers={providerProbe} errorMessage={providerProbeError} />
              ) : transcriptItems.length === 0 && !showPendingThinking ? (
                <div className="empty-state">
                  <NoProjectSplash
                    mode="empty-chat"
                    providers={providerSummaries}
                    errorMessage={null}
                  />
                </div>
              ) : (
              <TranscriptList
                items={transcriptItems}
                showPendingThinking={showPendingThinking}
                turnInProgress={turnInProgress}
                activeTurnId={activeTurnId ?? thread?.latestTurn?.id ?? null}
                latestTurnId={thread?.latestTurn?.id ?? null}
                providerName={thread?.session?.providerName ?? null}
                expandedToolIds={expandedToolIds}
                  submittingApprovals={submittingApprovals}
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
            </div>
          </section>

          {activeProject ? (
            <div className="composer-wrap">
              <div className="composer-stack">
                <div ref={todoFloatingUiRef} className="composer-floating-ui">
                  <FloatingTodoPanel todoLists={visibleTodoLists} open={todoPanelOpen} />
                  <FloatingTodoPill
                    todoLists={visibleTodoLists}
                    open={todoPanelOpen}
                    onToggle={() => setTodoPanelOpen((current) => !current)}
                  />
                </div>
                <ChatComposer
                  key={composerResetToken}
                  enabled={Boolean(activeProject)}
                  isBusy={isBusy}
                  isRunning={isRunning}
                  interactionMode={interactionMode}
                  runtimeMode={runtimeMode}
                  catalogModels={allCatalogModels}
                  model={model}
                  effort={effort}
                  providerSummaries={providerSummaries}
                  selectedProviderId={selectedProvider}
                  providerLocked={providerLocked}
                  onInteractionModeChange={handleInteractionModeChange}
                  onRuntimeModeChange={handleRuntimeModeChange}
                  onModelChange={handleModelChange}
                  onEffortChange={handleEffortChange}
                  onSubmitPrompt={sendPrompt}
                  onInterrupt={interruptTurn}
                />
              </div>
            </div>
          ) : null}
          <DiffPreviewPopover
            preview={diffPreview}
            threadId={activeThreadId}
            onClose={() => setDiffPreview(null)}
            onOpenSidebar={(turnId, filePath) => openDiffPanel({ mode: 'turn', turnId, filePath })}
          />
        </div>
        <ThreadSidebar
          open={activeSidebarState?.open === true}
          tabs={sidebarTabs}
          activeTabId={resolvedSidebarTabId}
          onSelectTab={(tabId) =>
            updateActiveSidebarState((current) => ({
              ...current,
              open: true,
              activeTabId: tabId
            }))
          }
          onClose={() => updateActiveSidebarState((current) => ({ ...current, open: false }))}
          resizeLabel="Resize review panel"
          resizeMin={minDiffPanelWidth}
          resizeMax={maxDiffPanelWidth}
          resizeValue={diffPanelWidth}
          onResizeStart={startDiffPanelResize}
          onResizeMove={resizeDiffPanel}
          onResizeEnd={stopDiffPanelResize}
          onResizeKeyDown={handleDiffPanelResizeKeyDown}
          renderContent={(tabId) => {
            if (tabId === 'review') {
              return (
                <DiffReviewSidebar
                  open
                  embedded
                  workspacePath={activeProject?.path ?? thread?.cwd ?? null}
                  threadId={activeThreadId}
                  summaries={thread?.checkpoints ?? []}
                  mode={diffPanelMode}
                  diffStyle={diffStyleMode}
                  wrapLines={diffWrapLines}
                  selectedTurnId={selectedDiffTurnId}
                  selectedFilePath={selectedDiffFilePath}
                  workspaceDiffVersion={workspaceDiffVersion}
                  workspaceDiffRefreshKey={workspaceDiffRefreshKey}
                  onModeChange={setDiffPanelMode}
                  onDiffStyleChange={setDiffStyleMode}
                  onWrapLinesChange={setDiffWrapLines}
                  onSelectTurn={setSelectedDiffTurnId}
                  onSelectFile={setSelectedDiffFilePath}
                  onCommitFull={requestCommitFullChanges}
                  onRefresh={refreshDiffReview}
                  onClose={() => undefined}
                  resizeLabel="Resize review panel"
                  resizeMin={minDiffPanelWidth}
                  resizeMax={maxDiffPanelWidth}
                  resizeValue={diffPanelWidth}
                  onResizeStart={startDiffPanelResize}
                  onResizeMove={resizeDiffPanel}
                  onResizeEnd={stopDiffPanelResize}
                  onResizeKeyDown={handleDiffPanelResizeKeyDown}
                />
              )
            }
            const plan = sidebarTabs.find(
              (candidate): candidate is { id: SidebarTabId; label: string; plan: OrchestrationProposedPlan } =>
                candidate.id === tabId && 'plan' in candidate
            )?.plan
            return plan ? (
              <PlanSidebarPanel
                plan={plan}
                disabled={isBusy}
                onImplement={() => void implementProposedPlan(plan)}
              />
            ) : null
          }}
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

function readOpenProjectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('No handler registered')) {
    return 'Project picker is not registered in the running desktop process. Fully restart bun run dev.'
  }
  return message
}

function isCommandActivityEvent(
  event: Parameters<typeof applyOrchestrationEvent>[1]
): event is Extract<
  Parameters<typeof applyOrchestrationEvent>[1],
  { type: 'thread.activity-upserted' }
> {
  if (event.type !== 'thread.activity-upserted') return false
  return event.activity.payload?.itemType === 'command_execution'
}

function readCommandItemId(activityId: string): string | null {
  return activityId.startsWith('tool:') ? activityId.slice('tool:'.length) : null
}

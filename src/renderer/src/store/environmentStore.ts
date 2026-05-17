/**
 * Environment store
 *
 * Top-level store that combines shell state, thread detail state, and local UI
 * state into one managed surface. Designed to be used from a React context or
 * `useReducer` hook so that all state transitions are predictable and testable.
 *
 * Architecture position:
 *   IPC shell stream → applyShellSnapshot/applyShellEvent → ShellState
 *   IPC thread stream → applyThreadDetailSnapshot/applyThreadDetailEvent → ThreadDetailState
 *   User interactions → LocalUiState mutations
 *
 * Ownership rules (per plan):
 * - Shell stream: project summaries, thread sidebar summaries.
 * - Thread-detail stream: messages, activities, plans, todos, checkpoints.
 * - Local UI: expanded tools, selected diff, panel widths, composer drafts,
 *   pending button submission state, scroll/selection behavior.
 */
import type {
  OrchestrationEvent,
  OrchestrationShellEvent,
  OrchestrationShellSnapshot,
  OrchestrationThread
} from '../../../shared/agent'
import {
  type ShellState,
  applyShellEvent,
  applyShellSnapshot,
  createShellState
} from './shellReducer'
import {
  type ThreadDetailState,
  applyThreadDetailEvent,
  applyThreadDetailReplay,
  applyThreadDetailSnapshot,
  createThreadDetailState,
  resetThreadDetailState
} from './threadDetailReducer'
import { deriveEventBatchEffects, type BatchEventEffects } from './orchestrationEventEffects'

// ---------------------------------------------------------------------------
// Local UI state
// ---------------------------------------------------------------------------

export interface LocalUiState {
  /** Set of activity ids that are expanded in the transcript. */
  expandedActivityIds: Set<string>
  /** Currently selected diff file path. */
  selectedDiffPath: string | null
  /** Whether the diff sidebar is open. */
  diffSidebarOpen: boolean
  /** Sidebar panel width (px). */
  sidebarWidth: number
  /** Diff panel width (px). */
  diffPanelWidth: number
  /** Whether the transcript is scrolled to the bottom (sticky). */
  transcriptScrollSticky: boolean
}

export function createLocalUiState(): LocalUiState {
  return {
    expandedActivityIds: new Set(),
    selectedDiffPath: null,
    diffSidebarOpen: false,
    sidebarWidth: 260,
    diffPanelWidth: 400,
    transcriptScrollSticky: true
  }
}

// ---------------------------------------------------------------------------
// Environment store state
// ---------------------------------------------------------------------------

export interface EnvironmentState {
  shell: ShellState
  /** Detail state per active thread (keyed by threadId). */
  threadDetails: Map<string, ThreadDetailState>
  localUi: LocalUiState
  /** The currently active thread id (selected in the UI). */
  activeThreadId: string | null
}

export function createEnvironmentState(): EnvironmentState {
  return {
    shell: createShellState(),
    threadDetails: new Map(),
    localUi: createLocalUiState(),
    activeThreadId: null
  }
}

// ---------------------------------------------------------------------------
// Shell updates
// ---------------------------------------------------------------------------

export function applyEnvShellSnapshot(
  state: EnvironmentState,
  snapshot: OrchestrationShellSnapshot
): EnvironmentState {
  return { ...state, shell: applyShellSnapshot(state.shell, snapshot) }
}

export function applyEnvShellEvent(
  state: EnvironmentState,
  event: OrchestrationShellEvent
): EnvironmentState {
  return { ...state, shell: applyShellEvent(state.shell, event) }
}

// ---------------------------------------------------------------------------
// Thread detail updates
// ---------------------------------------------------------------------------

function getOrCreateDetail(state: EnvironmentState, threadId: string): ThreadDetailState {
  const existing = state.threadDetails.get(threadId)
  if (existing) return existing
  const created = createThreadDetailState()
  state.threadDetails.set(threadId, created)
  return created
}

export function applyEnvThreadSnapshot(
  state: EnvironmentState,
  threadId: string,
  snapshot: { snapshotSequence: number; thread: OrchestrationThread }
): EnvironmentState {
  const detail = getOrCreateDetail(state, threadId)
  applyThreadDetailSnapshot(detail, snapshot)
  return { ...state, threadDetails: new Map(state.threadDetails) }
}

export function applyEnvThreadEvents(
  state: EnvironmentState,
  threadId: string,
  events: OrchestrationEvent[]
): { state: EnvironmentState; effects: BatchEventEffects } {
  const detail = getOrCreateDetail(state, threadId)
  for (const event of events) {
    applyThreadDetailEvent(detail, event)
  }
  const effects = deriveEventBatchEffects(events, state.activeThreadId)
  const nextState: EnvironmentState = {
    ...state,
    threadDetails: new Map(state.threadDetails)
  }
  return { state: nextState, effects }
}

export function applyEnvThreadReplay(
  state: EnvironmentState,
  threadId: string,
  events: OrchestrationEvent[]
): EnvironmentState {
  const detail = getOrCreateDetail(state, threadId)
  applyThreadDetailReplay(detail, events)
  return { ...state, threadDetails: new Map(state.threadDetails) }
}

export function evictThreadDetail(state: EnvironmentState, threadId: string): EnvironmentState {
  const detail = state.threadDetails.get(threadId)
  if (!detail) return state
  resetThreadDetailState(detail)
  const next = new Map(state.threadDetails)
  next.delete(threadId)
  return { ...state, threadDetails: next }
}

// ---------------------------------------------------------------------------
// Active thread
// ---------------------------------------------------------------------------

export function setActiveThreadId(
  state: EnvironmentState,
  threadId: string | null
): EnvironmentState {
  return { ...state, activeThreadId: threadId }
}

export function selectActiveThreadDetail(
  state: EnvironmentState
): ThreadDetailState | null {
  if (!state.activeThreadId) return null
  return state.threadDetails.get(state.activeThreadId) ?? null
}

export function selectActiveThread(state: EnvironmentState): OrchestrationThread | null {
  return selectActiveThreadDetail(state)?.thread ?? null
}

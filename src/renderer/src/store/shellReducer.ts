/**
 * Shell state reducer
 *
 * Manages the normalized shell-layer read model: project summaries and thread
 * sidebar summaries. This state is driven exclusively by the shell stream
 * (IPC shell subscription) — it does not receive thread-detail events.
 *
 * Ownership rules (per plan):
 * - Shell stream owns: project summaries, thread sidebar summaries.
 * - Thread-detail stream owns: messages, activities, plans, todos, checkpoints.
 * - Overlapping fields (session status, latest turn) on `ThreadShellSummary`
 *   are updated by the shell stream only.
 */
import type {
  OrchestrationShellEvent,
  OrchestrationShellSnapshot,
  ProjectSummary,
  ThreadShellSummary
} from '../../../shared/agent'

export interface ShellState {
  /** Ordered project ids (insertion/update order) */
  projectIds: string[]
  projectsById: Record<string, ProjectSummary>
  /** Ordered thread ids (insertion/update order) */
  threadIds: string[]
  threadsById: Record<string, ThreadShellSummary>
}

export function createShellState(): ShellState {
  return {
    projectIds: [],
    projectsById: {},
    threadIds: [],
    threadsById: {}
  }
}

/**
 * Apply a full shell snapshot — replaces the current normalized state.
 */
export function applyShellSnapshot(
  _state: ShellState,
  snapshot: OrchestrationShellSnapshot
): ShellState {
  const projectsById: Record<string, ProjectSummary> = {}
  const projectIds: string[] = []
  for (const project of snapshot.projects) {
    projectsById[project.id] = project
    projectIds.push(project.id)
  }

  const threadsById: Record<string, ThreadShellSummary> = {}
  const threadIds: string[] = []
  for (const thread of snapshot.threads) {
    threadsById[thread.id] = thread
    threadIds.push(thread.id)
  }

  return { projectIds, projectsById, threadIds, threadsById }
}

/**
 * Apply a single shell event — returns updated state.
 */
export function applyShellEvent(state: ShellState, event: OrchestrationShellEvent): ShellState {
  switch (event.type) {
    case 'shell.project-upserted': {
      const { project } = event
      const projectIds = state.projectsById[project.id]
        ? state.projectIds
        : [...state.projectIds, project.id]
      return {
        ...state,
        projectIds,
        projectsById: { ...state.projectsById, [project.id]: project }
      }
    }

    case 'shell.project-removed': {
      const { [event.projectId]: _removed, ...projectsById } = state.projectsById
      return {
        ...state,
        projectIds: state.projectIds.filter((id) => id !== event.projectId),
        projectsById
      }
    }

    case 'shell.thread-upserted': {
      const { thread } = event
      const threadIds = state.threadsById[thread.id]
        ? state.threadIds
        : [...state.threadIds, thread.id]
      return {
        ...state,
        threadIds,
        threadsById: { ...state.threadsById, [thread.id]: thread }
      }
    }

    case 'shell.thread-removed': {
      const { [event.threadId]: _removed, ...threadsById } = state.threadsById
      return {
        ...state,
        threadIds: state.threadIds.filter((id) => id !== event.threadId),
        threadsById
      }
    }

    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function selectProjects(state: ShellState): ProjectSummary[] {
  return state.projectIds.map((id) => state.projectsById[id]).filter(Boolean) as ProjectSummary[]
}

export function selectThreadsForProject(
  state: ShellState,
  projectId: string
): ThreadShellSummary[] {
  return state.threadIds
    .map((id) => state.threadsById[id])
    .filter((t): t is ThreadShellSummary => Boolean(t) && t.projectId === projectId)
}

export function selectThread(state: ShellState, threadId: string): ThreadShellSummary | undefined {
  return state.threadsById[threadId]
}

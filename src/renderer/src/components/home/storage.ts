import type { InteractionMode, RuntimeMode, ReasoningEffort } from '../../../../shared/agent'
import type { ActiveSelection, ThreadComposerPreferenceMap } from './types'

export const activeSelectionKey = 'cobel.active.v1'
export const legacyActiveSelectionKeys = ['patronus.active.v1', 'gencode.active.v1']
export const legacyWorkspaceKey = 'gencode.workspace.v1'
export const threadComposerPreferencesKey = 'cobel.thread-composer-prefs.v1'
export const legacyThreadComposerPreferencesKeys = ['patronus.thread-composer-prefs.v1']
export const sidebarWidthKey = 'cobel.sidebar-width.v1'
export const legacySidebarWidthKeys = ['patronus.sidebar-width.v1']
export const diffPanelWidthKey = 'cobel.diff-panel-width.v1'

export const defaultRuntimeMode: RuntimeMode = 'auto-accept-edits'
export const defaultInteractionMode: InteractionMode = 'default'
export const defaultSidebarWidth = 290
export const minSidebarWidth = 184
export const maxSidebarWidth = 420
export const defaultDiffPanelWidth = 640
export const minDiffPanelWidth = 420
export const maxDiffPanelWidth = 920

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === 'approval-required' || value === 'auto-accept-edits' || value === 'full-access'
}

export function isInteractionMode(value: unknown): value is InteractionMode {
  return value === 'default' || value === 'plan'
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  )
}

export function loadActiveSelection(): ActiveSelection {
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

export function saveActiveSelection(selection: ActiveSelection): void {
  localStorage.setItem(activeSelectionKey, JSON.stringify(selection))
}

export function loadThreadComposerPreferences(): ThreadComposerPreferenceMap {
  try {
    const storedPreferences =
      localStorage.getItem(threadComposerPreferencesKey) ??
      legacyThreadComposerPreferencesKeys.map((key) => localStorage.getItem(key)).find(Boolean)
    const parsed = JSON.parse(storedPreferences ?? 'null') as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return {}
    const preferences: ThreadComposerPreferenceMap = {}
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId || typeof value !== 'object' || !value) continue
      const raw = value as {
        model?: unknown
        effort?: unknown
        runtimeMode?: unknown
        interactionMode?: unknown
      }
      const model =
        typeof raw.model === 'string' && raw.model.trim().length > 0 ? raw.model : undefined
      const effort = isReasoningEffort(raw.effort) ? raw.effort : undefined
      const runtimeMode = isRuntimeMode(raw.runtimeMode) ? raw.runtimeMode : undefined
      const interactionMode = isInteractionMode(raw.interactionMode)
        ? raw.interactionMode
        : undefined
      if (!model && !effort && !runtimeMode && !interactionMode) continue
      preferences[threadId] = { model, effort, runtimeMode, interactionMode }
    }
    return preferences
  } catch {
    return {}
  }
}

export function saveThreadComposerPreferences(preferences: ThreadComposerPreferenceMap): void {
  localStorage.setItem(threadComposerPreferencesKey, JSON.stringify(preferences))
}

export function clampSidebarWidth(width: number): number {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)))
}

export function loadSidebarWidth(): number {
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

export function saveSidebarWidth(width: number): void {
  localStorage.setItem(sidebarWidthKey, String(clampSidebarWidth(width)))
}

export function clampDiffPanelWidth(width: number): number {
  return Math.min(maxDiffPanelWidth, Math.max(minDiffPanelWidth, Math.round(width)))
}

export function loadDiffPanelWidth(): number {
  try {
    const storedWidth = localStorage.getItem(diffPanelWidthKey)
    if (!storedWidth) return defaultDiffPanelWidth
    const parsed = Number(storedWidth)
    return Number.isFinite(parsed) ? clampDiffPanelWidth(parsed) : defaultDiffPanelWidth
  } catch {
    return defaultDiffPanelWidth
  }
}

export function saveDiffPanelWidth(width: number): void {
  localStorage.setItem(diffPanelWidthKey, String(clampDiffPanelWidth(width)))
}

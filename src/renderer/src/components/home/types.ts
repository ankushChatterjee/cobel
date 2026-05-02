import type {
  InteractionMode,
  OrchestrationThreadActivity,
  ProviderId,
  ReasoningEffort,
  RuntimeMode
} from '../../../../shared/agent'
import type { OrchestrationCheckpointSummary } from '../../../../shared/agent'

export type ComposerSelectOption = {
  value: string
  label: string
  /** Section title rows in the custom popover (not selectable). */
  kind?: 'header' | 'option'
}

export interface ActiveSelection {
  activeProjectId: string | null
  activeChatId: string | null
}

export interface ThreadComposerPreference {
  provider?: ProviderId
  model?: string
  effort?: ReasoningEffort
  runtimeMode?: RuntimeMode
  interactionMode?: InteractionMode
}

export type ThreadComposerPreferenceMap = Record<string, ThreadComposerPreference>

export type SidebarTabId = 'review' | `plan:${string}`

export interface ThreadSidebarState {
  open: boolean
  activeTabId: SidebarTabId | null
  hiddenPlanIds?: string[]
}

export interface PendingQuestionOption {
  label: string
  description?: string
}

export interface PendingQuestion {
  id: string
  header?: string
  question: string
  options: PendingQuestionOption[]
}

export interface PendingRequestViewModel {
  activity: OrchestrationThreadActivity
  kind: 'approval' | 'input'
  requestType: string
  requestLabel: string
  requestTypeLabel: string
  summary: string
  fileChange: { diff: string; title: string } | null
  questions: PendingQuestion[]
}

export type MessageTranscriptItem = {
  id: string
  kind: 'message'
  sequence: number
  createdAt: string
  workDurationMs: number | null
  message: import('../../../../shared/agent').OrchestrationMessage
}

export type ActivityTranscriptItem = {
  id: string
  kind: 'activity'
  sequence: number
  createdAt: string
  activity: OrchestrationThreadActivity
}

export type TranscriptItem = MessageTranscriptItem | ActivityTranscriptItem

export type TranscriptRenderGroup =
  | { kind: 'non-tool'; item: TranscriptItem }
  | { kind: 'reasoning-run'; id: string; activities: ActivityTranscriptItem[] }
  | { kind: 'tool-run'; id: string; activities: ActivityTranscriptItem[] }

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export type OnApprove = (
  activity: OrchestrationThreadActivity,
  decision: ApprovalDecision
) => Promise<void>

export type OnAnswer = (
  activity: OrchestrationThreadActivity,
  answer: Record<string, unknown>
) => Promise<void>

export type OnPreviewDiff = (
  summary: OrchestrationCheckpointSummary,
  file: import('../../../../shared/agent').CheckpointFileChange,
  rect: DOMRect
) => void

export type OnOpenDiff = (turnId: string | null, filePath?: string) => void
export type OnOpenPlan = (planId: string) => void

import type { ModelInfo, ReasoningEffort, RuntimeMode } from '../../../../shared/agent'
import { isReasoningEffort } from './storage'

export const runtimeModes: Array<{ value: RuntimeMode; label: string }> = [
  { value: 'approval-required', label: 'Guarded' },
  { value: 'auto-accept-edits', label: 'Write' },
  { value: 'full-access', label: 'Full access' }
]

const modelTokenLabels: Record<string, string> = {
  gpt: 'GPT',
  codex: 'Codex',
  mini: 'Mini',
  max: 'Max',
  nano: 'Nano',
  turbo: 'Turbo',
  preview: 'Preview'
}

export function pickDefaultModel(models: ModelInfo[]): string {
  return models.find((candidate) => candidate.isDefault)?.id ?? models[0]?.id ?? ''
}

export function formatModelId(id: string): string {
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

export function canonicalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function getModelDisplayName(modelInfo: Pick<ModelInfo, 'id' | 'name'>): string {
  const name = modelInfo.name?.trim()
  if (name && canonicalizeModelName(name) !== canonicalizeModelName(modelInfo.id)) return name
  return formatModelId(modelInfo.id)
}

export function getModelEfforts(modelInfo: ModelInfo | null): ReasoningEffort[] {
  const efforts = modelInfo?.supportedReasoningEfforts
    ?.map((option) => option.reasoningEffort)
    .filter(isReasoningEffort)
  return efforts && efforts.length > 0 ? efforts : ['medium']
}

export function pickDefaultEffort(modelInfo: ModelInfo | null): ReasoningEffort {
  return isReasoningEffort(modelInfo?.defaultReasoningEffort)
    ? modelInfo.defaultReasoningEffort
    : getModelEfforts(modelInfo)[0] ?? 'medium'
}

export function formatEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case 'none':
      return 'None'
    case 'minimal':
      return 'Minimal'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
    case 'xhigh':
      return 'XHigh'
  }
}

import type { ModelInfo, ProviderId, ReasoningEffort, RuntimeMode } from '../../../../shared/agent'
import { isReasoningEffort } from './storage'
import type { ComposerSelectOption } from './types'

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

function modelsForProvider(models: ModelInfo[], provider: ProviderId): ModelInfo[] {
  return models.filter((m) => (m.providerId ?? 'codex') === provider)
}

/** Flat list for one app-level provider (used when thread is locked). */
export function filterModelsForProvider(models: ModelInfo[], provider: ProviderId): ModelInfo[] {
  return modelsForProvider(models, provider)
}

/**
 * Dropdown rows: provider sections; under OpenCode, subgroup by upstream vendor (slug prefix).
 */
export function buildGroupedModelOptions(models: ModelInfo[]): ComposerSelectOption[] {
  if (models.length === 0) {
    return [{ value: '', label: 'Model list pending', kind: 'option' }]
  }
  const order: ProviderId[] = ['codex', 'opencode']
  const out: ComposerSelectOption[] = []
  for (const pid of order) {
    const list = modelsForProvider(models, pid)
    if (list.length === 0) continue
    out.push({
      kind: 'header',
      value: `__group:${pid}`,
      label: pid === 'codex' ? 'Codex' : 'OpenCode'
    })
    if (pid === 'opencode') {
      const vendors = [...new Set(list.map((m) => m.upstreamVendor ?? 'models'))].sort()
      for (const vendor of vendors) {
        const vendorModels = list.filter((m) => (m.upstreamVendor ?? 'models') === vendor)
        if (vendors.length > 1 || vendor !== 'models') {
          out.push({
            kind: 'header',
            value: `__sub:${pid}:${vendor}`,
            label: vendor
          })
        }
        for (const m of vendorModels) {
          out.push({
            kind: 'option',
            value: m.id,
            label: getModelDisplayName(m)
          })
        }
      }
    } else {
      for (const m of list) {
        out.push({
          kind: 'option',
          value: m.id,
          label: getModelDisplayName(m)
        })
      }
    }
  }
  return out
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
    case 'max':
      return 'Max'
    case 'xhigh':
      return 'Extra High'
  }
}

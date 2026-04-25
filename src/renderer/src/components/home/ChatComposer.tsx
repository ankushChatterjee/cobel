import {
  FormEvent,
  KeyboardEvent,
  memo,
  useCallback,
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
  Map as MapIcon,
  RotateCcw,
  Search,
  Square,
  Zap
} from 'lucide-react'
import type {
  InteractionMode,
  ModelInfo,
  ProviderId,
  ProviderSummary,
  ReasoningEffort,
  RuntimeMode
} from '../../../../shared/agent'
import {
  filterModelsForProvider,
  formatEffortLabel,
  formatModelId,
  getModelDisplayName,
  getModelEfforts,
  runtimeModes
} from './modelUtils'
import type { ComposerSelectOption } from './types'


function isHeaderRow(option: ComposerSelectOption): boolean {
  return option.kind === 'header'
}

export function InteractionModeToggle({
  value,
  onChange,
  disabled
}: {
  value: InteractionMode
  onChange: (mode: InteractionMode) => void
  disabled: boolean
}): React.JSX.Element {
  useEffect(() => {
    if (disabled) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Tab' || !event.shiftKey) return
      event.preventDefault()
      onChange(value === 'plan' ? 'default' : 'plan')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [disabled, onChange, value])

  return (
    <div className="composer-interaction-toggle" role="group" aria-label="Interaction mode">
      <button
        type="button"
        className={`composer-interaction-btn${value !== 'plan' ? ' active' : ''}`}
        onClick={() => onChange('default')}
        disabled={disabled}
        aria-pressed={value !== 'plan'}
        title="Do mode — agent executes changes directly"
      >
        <Zap size={11} strokeWidth={1.9} aria-hidden="true" />
        <span>Do</span>
      </button>
      <button
        type="button"
        className={`composer-interaction-btn plan${value === 'plan' ? ' active' : ''}`}
        onClick={() => onChange('plan')}
        disabled={disabled}
        aria-pressed={value === 'plan'}
        title="Plan mode — agent proposes a plan first"
      >
        <MapIcon size={11} strokeWidth={1.9} aria-hidden="true" />
        <span>Plan</span>
      </button>
    </div>
  )
}

export function ComposerDropdown({
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
  const selectableOptions = useMemo(
    () => options.filter((option) => !isHeaderRow(option)),
    [options]
  )
  const activeOption =
    selectableOptions.find((option) => option.value === value) ?? selectableOptions[0] ?? options[0]
  const displayLabel = activeOption?.label ?? ''
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === activeOption?.value && !isHeaderRow(option))
  )

  const nextSelectableIndex = useCallback(
    (from: number, direction: 1 | -1): number => {
      if (options.length === 0) return 0
      let i = from
      for (let step = 0; step < options.length; step += 1) {
        i = (i + direction + options.length) % options.length
        if (!isHeaderRow(options[i])) return i
      }
      return from
    },
    [options]
  )

  useEffect(() => {
    if (!isOpen) return
    const start = activeIndex >= 0 ? activeIndex : nextSelectableIndex(0, 1)
    setHighlightedIndex(start)
    const frame = window.requestAnimationFrame(() => optionRefs.current[start]?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, isOpen, nextSelectableIndex])

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
        const nextIndex = nextSelectableIndex(currentIndex, direction)
        window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus())
        return nextIndex
      })
    },
    [nextSelectableIndex]
  )

  const openMenu = useCallback((): void => {
    setHighlightedIndex(activeIndex)
    setIsOpen(true)
  }, [activeIndex])

  const chooseOption = useCallback(
    (nextValue: string): void => {
      const picked = options.find((o) => o.value === nextValue)
      if (picked && isHeaderRow(picked)) return
      onChange(nextValue)
      setIsOpen(false)
      triggerRef.current?.focus()
    },
    [onChange, options]
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
        const firstIndex = nextSelectableIndex(0, 1)
        setHighlightedIndex(firstIndex)
        optionRefs.current[firstIndex]?.focus()
        return
      }

      if (event.key === 'End') {
        event.preventDefault()
        const lastIndex = nextSelectableIndex(0, -1)
        setHighlightedIndex(lastIndex)
        optionRefs.current[lastIndex]?.focus()
        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        chooseOption(optionValue)
      }
    },
    [chooseOption, moveHighlight, nextSelectableIndex]
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
        {options
          .filter((option) => !isHeaderRow(option))
          .map((option) => (
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
              if (isHeaderRow(option)) {
                return (
                  <div
                    key={option.value}
                    className="composer-select-group-label"
                    role="presentation"
                  >
                    {option.label}
                  </div>
                )
              }
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

function searchFilterModels(list: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((m) => {
    const label = getModelDisplayName(m).toLowerCase()
    const id = m.id.toLowerCase()
    const name = (m.name ?? '').toLowerCase()
    const vendor = (m.upstreamVendor ?? '').toLowerCase()
    return label.includes(q) || id.includes(q) || name.includes(q) || vendor.includes(q)
  })
}

function providerSummaryName(summaries: ProviderSummary[], id: ProviderId): string {
  return summaries.find((s) => s.id === id)?.name ?? (id === 'opencode' ? 'OpenCode' : 'Codex')
}

export function ProviderModelPicker({
  disabled,
  catalogModels,
  providerSummaries,
  selectedProviderId,
  model,
  providerLocked,
  onModelChange,
  shortcut,
  shortcutLabel
}: {
  disabled: boolean
  catalogModels: ModelInfo[]
  providerSummaries: ProviderSummary[]
  selectedProviderId: ProviderId
  model: string
  providerLocked: boolean
  onModelChange: (modelId: string) => void
  shortcut?: { key: string; metaKey?: boolean; shiftKey?: boolean }
  shortcutLabel?: string
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [browseProviderId, setBrowseProviderId] = useState<ProviderId>(selectedProviderId)
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const dialogId = useId()
  const listboxId = useId()
  const searchId = useId()
  const wasOpenRef = useRef(false)

  const activeModel = useMemo(
    () => catalogModels.find((candidate) => candidate.id === model) ?? null,
    [catalogModels, model]
  )
  const triggerProviderLabel = providerSummaryName(providerSummaries, selectedProviderId)
  const triggerModelLabel = activeModel
    ? getModelDisplayName(activeModel)
    : model
      ? formatModelId(model)
      : 'Model list pending'
  const triggerTitle = `${triggerProviderLabel} · ${triggerModelLabel} (${shortcutLabel ?? '⌘⇧M'})`

  const tabProviders = useMemo((): ProviderId[] => {
    const ordered: ProviderId[] = ['codex', 'opencode']
    if (providerSummaries.length > 0) {
      const ids = new Set(providerSummaries.map((p) => p.id))
      return ordered.filter((id) => ids.has(id))
    }
    const has = (pid: ProviderId): boolean =>
      catalogModels.some((m) => (m.providerId ?? 'codex') === pid)
    return ordered.filter(has)
  }, [providerSummaries, catalogModels])

  const effectiveBrowseId = providerLocked ? selectedProviderId : browseProviderId

  const baseList = useMemo(
    () => searchFilterModels(filterModelsForProvider(catalogModels, effectiveBrowseId), search),
    [catalogModels, effectiveBrowseId, search]
  )

  useEffect(() => {
    if (!isOpen) {
      setBrowseProviderId(selectedProviderId)
    }
  }, [isOpen, selectedProviderId])

  useLayoutEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setBrowseProviderId(selectedProviderId)
      setSearch('')
      const list = searchFilterModels(
        filterModelsForProvider(catalogModels, selectedProviderId),
        ''
      )
      queueMicrotask(() => {
        if (list.length === 0) {
          searchInputRef.current?.focus()
          return
        }
        const idx = list.findIndex((m) => m.id === model)
        const start = idx >= 0 ? idx : 0
        setHighlightedIndex(start)
        window.requestAnimationFrame(() => optionRefs.current[start]?.focus())
      })
    }
    wasOpenRef.current = isOpen
  }, [isOpen, selectedProviderId, catalogModels, model])

  useEffect(() => {
    setHighlightedIndex((idx) => Math.min(idx, Math.max(0, baseList.length - 1)))
  }, [baseList.length, search])

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
      if (baseList.length === 0) return
      setHighlightedIndex((current) => {
        const next = (current + direction + baseList.length) % baseList.length
        window.requestAnimationFrame(() => optionRefs.current[next]?.focus())
        return next
      })
    },
    [baseList.length]
  )

  const chooseModel = useCallback(
    (modelId: string): void => {
      onModelChange(modelId)
      setIsOpen(false)
      triggerRef.current?.focus()
    },
    [onModelChange]
  )

  const showTabs = !providerLocked && tabProviders.length > 1

  const nativeOptions = useMemo(
    () => filterModelsForProvider(catalogModels, selectedProviderId),
    [catalogModels, selectedProviderId]
  )

  return (
    <span ref={rootRef} className="composer-select-shell model-provider-select-shell">
      <select
        aria-label="Model"
        className="sr-only composer-native-select"
        value={nativeOptions.some((o) => o.id === model) ? model : nativeOptions[0]?.id ?? ''}
        onChange={(event) => onModelChange(event.target.value)}
        disabled={disabled}
        tabIndex={-1}
      >
        {nativeOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {getModelDisplayName(option)}
          </option>
        ))}
      </select>
      <button
        ref={triggerRef}
        type="button"
        className="composer-select-trigger composer-mpc-trigger"
        disabled={disabled || catalogModels.length === 0}
        title={triggerTitle}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? dialogId : undefined}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setIsOpen(true)
          }
        }}
      >
        <span className="composer-mpc-trigger-stack">
          <span className="composer-mpc-trigger-provider">{triggerProviderLabel}</span>
          <span className="composer-mpc-trigger-model-row">
            <span className="composer-select-value composer-mpc-trigger-model">
              {triggerModelLabel}
            </span>
            <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
          </span>
        </span>
      </button>
      {isOpen ? (
        <div
          className="composer-select-popover composer-mpc-popover"
          role="dialog"
          aria-label="Model and provider"
          id={dialogId}
        >
          {showTabs ? (
            <div className="composer-mpc-tabs" role="tablist" aria-label="Provider">
              {tabProviders.map((pid) => {
                const summary = providerSummaries.find((s) => s.id === pid)
                const selected = effectiveBrowseId === pid
                return (
                  <button
                    key={pid}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className={`composer-mpc-tab${selected ? ' active' : ''}`}
                    onClick={() => {
                      setBrowseProviderId(pid)
                      setSearch('')
                      setHighlightedIndex(0)
                      const nextList = searchFilterModels(
                        filterModelsForProvider(catalogModels, pid),
                        ''
                      )
                      window.requestAnimationFrame(() => {
                        if (nextList.length > 0) {
                          optionRefs.current[0]?.focus()
                        } else {
                          searchInputRef.current?.focus()
                        }
                      })
                    }}
                  >
                    {summary?.name ?? pid}
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className="composer-mpc-search-wrap">
            <Search size={12} strokeWidth={1.8} aria-hidden="true" className="composer-mpc-search-icon" />
            <input
              ref={searchInputRef}
              id={searchId}
              type="search"
              className="composer-mpc-search"
              placeholder="Search models…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setHighlightedIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  if (baseList.length > 0) {
                    setHighlightedIndex(0)
                    optionRefs.current[0]?.focus()
                  }
                }
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setIsOpen(false)
                  triggerRef.current?.focus()
                }
              }}
              aria-label="Search models"
            />
          </div>
          <div className="composer-mpc-list" role="listbox" id={listboxId} aria-labelledby={searchId}>
            {baseList.length === 0 ? (
              <div className="composer-mpc-empty">No models match your search.</div>
            ) : (
              baseList.map((m, index) => {
                const isSelected = m.id === model
                const highlighted = index === highlightedIndex
                return (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="composer-select-option composer-mpc-option"
                    data-highlighted={highlighted}
                    onClick={() => chooseModel(m.id)}
                    onFocus={() => setHighlightedIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        moveHighlight(1)
                        return
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        if (index === 0) {
                          searchInputRef.current?.focus()
                          return
                        }
                        moveHighlight(-1)
                        return
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        chooseModel(m.id)
                      }
                    }}
                  >
                    <span className="composer-mpc-option-main">
                      <span className="composer-mpc-option-title">{getModelDisplayName(m)}</span>
                      {m.providerId === 'opencode' && m.upstreamVendor ? (
                        <span className="composer-mpc-option-provider-line">{m.upstreamVendor}</span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <Check size={12} strokeWidth={1.8} aria-hidden="true" className="composer-mpc-option-check" />
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
          {shortcutLabel ? (
            <div className="composer-select-hint" aria-hidden="true">
              <span>Open model picker</span>
              <kbd>{shortcutLabel}</kbd>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

export const ChatComposer = memo(function ChatComposer({
  enabled,
  isRunning,
  interactionMode,
  runtimeMode,
  catalogModels,
  model,
  effort,
  providerSummaries,
  selectedProviderId,
  providerLocked,
  onInteractionModeChange,
  onRuntimeModeChange,
  onModelChange,
  onEffortChange,
  onSubmitPrompt,
  onInterrupt,
  onStop
}: {
  enabled: boolean
  isRunning: boolean
  interactionMode: InteractionMode
  runtimeMode: RuntimeMode
  catalogModels: ModelInfo[]
  model: string
  effort: ReasoningEffort
  providerSummaries: ProviderSummary[]
  selectedProviderId: ProviderId
  providerLocked: boolean
  onInteractionModeChange: (mode: InteractionMode) => void
  onRuntimeModeChange: (mode: RuntimeMode) => void
  onModelChange: (model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onSubmitPrompt: (input: string) => Promise<boolean>
  onInterrupt: () => void
  onStop: () => void
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const activeModel = useMemo(
    () => catalogModels.find((candidate) => candidate.id === model) ?? null,
    [model, catalogModels]
  )
  const effortOptions = useMemo<ComposerSelectOption[]>(
    () =>
      getModelEfforts(activeModel).map((value) => ({
        value,
        label: formatEffortLabel(value)
      })),
    [activeModel]
  )
  const effortTitle = useMemo(
    () => `Reasoning effort: ${formatEffortLabel(effort)}`,
    [effort]
  )
  const modelShortcut = useMemo(() => ({ key: 'm', metaKey: true, shiftKey: true }), [])
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
        <InteractionModeToggle
          value={interactionMode}
          onChange={onInteractionModeChange}
          disabled={!enabled}
        />
        <ComposerDropdown
          ariaLabel="Runtime mode"
          className="permissions-select-shell"
          value={runtimeMode}
          onChange={(v) => onRuntimeModeChange(v as RuntimeMode)}
          options={runtimeModeOptions}
          disabled={!enabled}
        />
        <span className="composer-divider" />
        <ProviderModelPicker
          disabled={!enabled}
          catalogModels={catalogModels}
          providerSummaries={providerSummaries}
          selectedProviderId={selectedProviderId}
          model={model}
          providerLocked={providerLocked}
          onModelChange={onModelChange}
          shortcut={modelShortcut}
          shortcutLabel="⌘⇧M"
        />
        <ComposerDropdown
          ariaLabel="Effort"
          className="effort-select-shell"
          value={effort}
          onChange={(nextValue) => onEffortChange(nextValue as ReasoningEffort)}
          options={effortOptions}
          disabled={!enabled || effortOptions.length === 0}
          title={effortTitle}
        />
        <div className="composer-footer-trail">
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
      </div>
    </form>
  )
})

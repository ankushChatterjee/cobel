import {
  FormEvent,
  KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { ArrowUp, Check, ChevronDown, Map as MapIcon, RotateCcw, Square, Zap } from 'lucide-react'
import type { InteractionMode, ModelInfo, ReasoningEffort, RuntimeMode } from '../../../../shared/agent'
import { formatEffortLabel, getModelDisplayName, getModelEfforts, runtimeModes } from './modelUtils'
import { formatModelId } from './modelUtils'
import type { ComposerSelectOption } from './types'

const composerSpacerStyle = { flex: 1 }

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

export const ChatComposer = memo(function ChatComposer({
  enabled,
  isRunning,
  interactionMode,
  runtimeMode,
  models,
  model,
  effort,
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
  models: ModelInfo[]
  model: string
  effort: ReasoningEffort
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
    () => models.find((candidate) => candidate.id === model) ?? null,
    [model, models]
  )
  const modelTitle = useMemo(() => {
    if (!model) return 'Model list pending'
    if (activeModel) return `Model: ${getModelDisplayName(activeModel)}`
    return `Model: ${formatModelId(model)}`
  }, [activeModel, model])
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
        <ComposerDropdown
          ariaLabel="Effort"
          className="effort-select-shell"
          value={effort}
          onChange={(nextValue) => onEffortChange(nextValue as ReasoningEffort)}
          options={effortOptions}
          disabled={!enabled || effortOptions.length === 0}
          title={effortTitle}
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

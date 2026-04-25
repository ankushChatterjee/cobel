import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent
} from 'react'
import { FileDiff, WorkerPoolContextProvider } from '@pierre/diffs/react'
import { parsePatchFiles, trimPatchContext, type FileDiffMetadata } from '@pierre/diffs'
import { ChevronDown, GitCommitHorizontal, RefreshCw, TextWrap, Undo2 } from 'lucide-react'
import type {
  CheckpointDiffResult,
  CheckpointFileChange,
  CheckpointWorktreeDiffResult,
  OrchestrationCheckpointSummary
} from '../../../../shared/agent'
import {
  DiffChangedFilesTree,
  DiffTreeToggleButton,
  type DiffChangedFileChoice
} from './DiffChangedFilesTree'
import { DiffTurnPager } from './DiffTurnPager'

export type DiffPanelMode = 'full' | 'turn'
export type DiffStyleMode = 'unified' | 'split'

export interface DiffPreviewState {
  summary: OrchestrationCheckpointSummary
  file: CheckpointFileChange
  rect: DOMRect
}

interface ChangedFilePillsProps {
  summary: OrchestrationCheckpointSummary
  onPreview: (file: CheckpointFileChange, rect: DOMRect) => void
  onOpenDiff: (filePath?: string) => void
  revertTurnCount?: number | null
  onRevert?: (turnCount: number) => void
}

interface FloatingDiffPillProps {
  threadId: string | null
  summaries: OrchestrationCheckpointSummary[]
  workspaceDiffVersion: number
  open: boolean
  onToggle: () => void
}

interface DiffReviewSidebarProps {
  open: boolean
  embedded?: boolean
  threadId: string | null
  summaries: OrchestrationCheckpointSummary[]
  mode: DiffPanelMode
  diffStyle: DiffStyleMode
  wrapLines: boolean
  selectedTurnId: string | null
  selectedFilePath: string | null
  workspaceDiffVersion: number
  onModeChange: (mode: DiffPanelMode) => void
  onDiffStyleChange: (style: DiffStyleMode) => void
  onWrapLinesChange: (wrap: boolean) => void
  onSelectTurn: (turnId: string | null) => void
  onSelectFile: (path: string | null) => void
  onCommitFull: () => void
  onRefresh: () => void
  onClose: () => void
  resizeLabel: string
  resizeMin: number
  resizeMax: number
  resizeValue: number
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  onResizeMove: (event: PointerEvent<HTMLDivElement>) => void
  onResizeEnd: (event: PointerEvent<HTMLDivElement>) => void
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

interface DiffPreviewPopoverProps {
  preview: DiffPreviewState | null
  threadId: string | null
  onClose: () => void
  onOpenSidebar: (turnId: string, filePath: string) => void
}

interface EmbeddedDiffViewProps {
  diff: string
  title: string
  subtitle?: string
  actions?: ReactNode
  status?: ReactNode
  compactTitle?: boolean
}

interface DiffToolbarPillProps {
  as?: 'button' | 'span'
  active?: boolean
  iconOnly?: boolean
  className?: string
  children: ReactNode
  title?: string
  ariaLabel?: string
  onClick?: () => void
}

const diffWorkerPool = {
  poolOptions: {
    workerFactory: () =>
      new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' }),
    poolSize: Math.min(4, Math.max(2, navigator.hardwareConcurrency ?? 2)),
    totalASTLRUCacheSize: 96
  },
  highlighterOptions: {
    theme: 'pierre-dark' as const,
    lineDiffType: 'word-alt' as const,
    tokenizeMaxLineLength: 2_000,
    langs: ['typescript', 'javascript', 'json', 'css', 'bash', 'markdown', 'python', 'rust', 'yaml']
  }
}

const diffOptionsBase = {
  theme: 'pierre-dark' as const,
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  hunkSeparators: 'line-info-basic' as const,
  lineDiffType: 'word-alt' as const,
  tokenizeMaxLineLength: 2_000,
  maxLineDiffLength: 1_200
}

const diffCache = new Map<string, Promise<CheckpointDiffResult>>()

export const ChangedFilePills = memo(function ChangedFilePills({
  summary,
  onPreview,
  onOpenDiff,
  revertTurnCount,
  onRevert
}: ChangedFilePillsProps): React.JSX.Element | null {
  if (summary.status === 'error') {
    return (
      <div className="changed-files-strip error" aria-label="Diff unavailable">
        <span>Diff unavailable</span>
        {summary.errorMessage ? <code>{summary.errorMessage}</code> : null}
      </div>
    )
  }
  if (summary.files.length === 0) return null

  const totals = summarizeFiles(summary.files)
  return (
    <div className="changed-files-strip" aria-label="Changed files">
      <div className="changed-file-pills">
        <button
          type="button"
          className="changed-files-total"
          style={{ '--pill-index': 0 } as CSSProperties}
          onClick={() => onOpenDiff(undefined)}
          title="Open turn diff"
        >
          <span>{summary.files.length} files</span>
          <DiffStats additions={totals.additions} deletions={totals.deletions} />
        </button>
        {summary.files.slice(0, 8).map((file, index) => (
          <button
            key={`${file.path}:${file.oldPath ?? ''}`}
            type="button"
            className="changed-file-pill"
            style={{ '--pill-index': index + 1 } as CSSProperties}
            onClick={(event) => onPreview(file, event.currentTarget.getBoundingClientRect())}
            onDoubleClick={() => onOpenDiff(file.path)}
            title={`${file.path} • click to preview, double-click to open`}
          >
            <span className={`file-kind ${file.kind}`} aria-hidden="true" />
            <span className="changed-file-name">{basename(file.path)}</span>
            <DiffStats additions={file.additions} deletions={file.deletions} />
          </button>
        ))}
        {summary.files.length > 8 ? (
          <button
            type="button"
            className="changed-file-more"
            style={{ '--pill-index': Math.min(summary.files.length, 8) + 1 } as CSSProperties}
            onClick={() => onOpenDiff(undefined)}
          >
            +{summary.files.length - 8}
          </button>
        ) : null}
        {typeof revertTurnCount === 'number' && onRevert ? (
          <button
            type="button"
            className="changed-file-undo"
            style={{ '--pill-index': Math.min(summary.files.length, 8) + 2 } as CSSProperties}
            onClick={() => onRevert(revertTurnCount)}
            title="Undo changes from this turn"
          >
            <Undo2 size={11} strokeWidth={2} aria-hidden="true" />
            Undo
          </button>
        ) : null}
      </div>
    </div>
  )
})

export const FloatingDiffPill = memo(function FloatingDiffPill({
  threadId,
  summaries,
  workspaceDiffVersion,
  open,
  onToggle
}: FloatingDiffPillProps): React.JSX.Element | null {
  const ready = summaries.filter((summary) => summary.status === 'ready')
  const refreshKey = `${workspaceDiffVersion}:${buildCheckpointRefreshKey(ready)}`
  const { result } = useCheckpointWorktreeDiff(threadId, 0, ready.length > 0, refreshKey)
  if (ready.length === 0) return null
  const files = result?.files ?? ready.flatMap((summary) => summary.files)
  const totals = summarizeFiles(files)
  if (totals.additions === 0 && totals.deletions === 0) return null
  return (
    <button
      type="button"
      className={`header-diff-pill ${open ? 'active' : ''}`}
      onClick={onToggle}
      aria-label={open ? 'Close review diff' : 'Open review diff'}
      title={open ? 'Close review diff' : 'Open review diff'}
    >
      <DiffStats additions={totals.additions} deletions={totals.deletions} />
    </button>
  )
})

export const DiffReviewSidebar = memo(function DiffReviewSidebar({
  open,
  embedded = false,
  threadId,
  summaries,
  mode,
  diffStyle,
  wrapLines,
  selectedTurnId,
  selectedFilePath,
  workspaceDiffVersion,
  onModeChange,
  onDiffStyleChange,
  onWrapLinesChange,
  onSelectTurn,
  onSelectFile,
  onCommitFull,
  onRefresh,
  onClose,
  resizeLabel,
  resizeMin,
  resizeMax,
  resizeValue,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown
}: DiffReviewSidebarProps): React.JSX.Element | null {
  const readySummaries = useMemo(
    () =>
      summaries
        .filter((summary) => summary.status === 'ready')
        .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount),
    [summaries]
  )
  const latest = readySummaries[readySummaries.length - 1] ?? null
  const selectedTurn = readySummaries.find((summary) => summary.turnId === selectedTurnId) ?? latest
  const [treeOpen, setTreeOpen] = useState(false)
  const range =
    mode === 'turn' && selectedTurn
      ? {
          fromTurnCount: selectedTurn.checkpointTurnCount - 1,
          toTurnCount: selectedTurn.checkpointTurnCount
        }
      : latest
        ? { fromTurnCount: 0, toTurnCount: latest.checkpointTurnCount }
        : null
  const worktreeDiff = useCheckpointWorktreeDiff(
    threadId,
    0,
    open && mode !== 'turn' && readySummaries.length > 0,
    `${workspaceDiffVersion}:${buildCheckpointRefreshKey(readySummaries)}`
  )
  const headerCopy =
    mode === 'turn' && selectedTurn
      ? {
          title:
            selectedTurn === latest ? 'Latest turn' : `Turn ${selectedTurn.checkpointTurnCount}`,
          subtitle: summarizeFiles(selectedTurn.files)
        }
      : {
          title: 'All changes',
          subtitle: summarizeFiles(
            worktreeDiff.result?.files ?? readySummaries.flatMap((summary) => summary.files)
          )
        }
  const checkpointDiff = useCheckpointDiff(
    threadId,
    range,
    open && mode === 'turn',
    workspaceDiffVersion
  )
  const result = mode === 'turn' ? checkpointDiff.result : worktreeDiff.result
  const loading = mode === 'turn' ? checkpointDiff.loading : worktreeDiff.loading
  const error = mode === 'turn' ? checkpointDiff.error : worktreeDiff.error
  const files = useMemo(() => parsePatch(result?.diff ?? '', range), [result?.diff, range])
  const summaryFiles = useMemo(
    () =>
      mode === 'turn' && selectedTurn
        ? selectedTurn.files
        : (worktreeDiff.result?.files ?? readySummaries.flatMap((summary) => summary.files)),
    [mode, readySummaries, selectedTurn, worktreeDiff.result?.files]
  )
  const visibleFiles = useMemo(
    () => filterDiffFiles(files, selectedFilePath),
    [files, selectedFilePath]
  )
  const fileChoices = useMemo<DiffChangedFileChoice[]>(() => {
    if (files.length > 0) {
      return files.map((file) => ({
        path: file.name,
        label: basename(file.name),
        detail: file.name
      }))
    }
    const byPath = new Map<string, DiffChangedFileChoice>()
    for (const file of summaryFiles) {
      byPath.set(file.path, {
        path: file.path,
        label: basename(file.path),
        detail: file.path
      })
    }
    return [...byPath.values()]
  }, [files, summaryFiles])
  const options = useMemo(
    () => ({
      ...diffOptionsBase,
      diffStyle,
      overflow: wrapLines ? ('wrap' as const) : ('scroll' as const)
    }),
    [diffStyle, wrapLines]
  )
  const canCommitFull =
    mode === 'full' &&
    range !== null &&
    headerCopy.subtitle.additions + headerCopy.subtitle.deletions > 0
  const hasTreeFiles = fileChoices.length > 0

  useEffect(() => {
    if (hasTreeFiles) return
    setTreeOpen(false)
  }, [hasTreeFiles])

  const content = (
    <>
      {embedded ? null : (
        <div
          className="diff-review-resize-handle"
          role="separator"
          aria-label={resizeLabel}
          aria-orientation="vertical"
          aria-valuemin={resizeMin}
          aria-valuemax={resizeMax}
          aria-valuenow={resizeValue}
          tabIndex={open ? 0 : -1}
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      )}
      <div className="diff-review-header">
        {range ? (
          <DiffStats
            additions={headerCopy.subtitle.additions}
            deletions={headerCopy.subtitle.deletions}
          />
        ) : (
          <span className="diff-header-empty">No completed changes yet</span>
        )}
        <div className="diff-review-controls">
          <SegmentedControl
            label="Diff range"
            value={mode}
            options={[
              { value: 'full', label: 'Full' },
              { value: 'turn', label: 'Last turn' }
            ]}
            onChange={(value) => onModeChange(value as DiffPanelMode)}
          />
          <SegmentedControl
            label="Layout"
            value={diffStyle}
            options={[
              { value: 'unified', label: 'Inline' },
              { value: 'split', label: 'Split' }
            ]}
            onChange={(value) => onDiffStyleChange(value as DiffStyleMode)}
          />
          {canCommitFull ? (
            <DiffToolbarPill
              className="diff-commit-button"
              onClick={onCommitFull}
              title="Commit all current changes"
            >
              <GitCommitHorizontal size={13} strokeWidth={1.8} aria-hidden="true" />
              Commit
            </DiffToolbarPill>
          ) : null}

          {mode === 'turn' && readySummaries.length > 1 ? (
            <DiffTurnPager
              summaries={readySummaries}
              selectedTurn={selectedTurn}
              latest={latest}
              onSelectTurn={onSelectTurn}
            />
          ) : null}
        </div>
        <DiffTreeToggleButton
          active={treeOpen}
          disabled={!hasTreeFiles}
          onClick={() => setTreeOpen((isOpen) => !isOpen)}
        />
        <DiffToolbarPill
          iconOnly
          className={`diff-toggle diff-header-wrap ${wrapLines ? 'active' : ''}`}
          onClick={() => onWrapLinesChange(!wrapLines)}
          ariaLabel={wrapLines ? 'Disable line wrapping' : 'Enable line wrapping'}
          title={wrapLines ? 'Disable line wrapping' : 'Enable line wrapping'}
        >
          <TextWrap size={13} strokeWidth={1.8} aria-hidden="true" />
        </DiffToolbarPill>
        <DiffToolbarPill
          iconOnly
          className={`diff-refresh-button ${loading ? 'loading' : ''}`}
          onClick={onRefresh}
          ariaLabel="Refresh review diff"
          title="Refresh review"
        >
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
        </DiffToolbarPill>
        {embedded ? null : (
          <button
            type="button"
            className="diff-close-button"
            onClick={onClose}
            aria-label="Close diff"
          >
            ×
          </button>
        )}
      </div>

      <div className="diff-review-main">
        <DiffChangedFilesTree
          mode={mode}
          threadId={threadId}
          fileChoices={fileChoices}
          summaryFiles={summaryFiles}
          selectedFilePath={selectedFilePath}
          open={treeOpen && hasTreeFiles}
          onSelectFile={onSelectFile}
          onClose={() => setTreeOpen(false)}
        />
        <div className="diff-review-body">
          <div className="diff-review-body-layout">
            <div className="diff-review-content">
              {!range ? <DiffEmptyState label="No completed checkpoint diffs yet." /> : null}
              {loading ? <DiffEmptyState label="Loading diff..." /> : null}
              {error ? <DiffEmptyState label={error} tone="error" /> : null}
              {result && result.diff.trim().length === 0 ? (
                <DiffEmptyState label="No net changes in this range." />
              ) : null}
              {!loading &&
              !error &&
              result &&
              result.diff.trim().length > 0 &&
              selectedFilePath &&
              visibleFiles.length === 0 ? (
                <DiffEmptyState
                  label={`No changed files match "${formatSelectedPath(selectedFilePath)}".`}
                />
              ) : null}
              {visibleFiles.length > 0 ? (
                <WorkerPoolContextProvider {...diffWorkerPool}>
                  <div className="diff-file-stack">
                    {visibleFiles.map((file) => (
                      <CollapsibleFileDiff
                        key={`${file.prevName ?? ''}:${file.name}`}
                        fileDiff={file}
                        options={options}
                      />
                    ))}
                  </div>
                </WorkerPoolContextProvider>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  )

  if (embedded) {
    return <div className="diff-review-panel">{content}</div>
  }

  return (
    <aside className={`diff-review-sidebar ${open ? 'open' : ''}`} aria-hidden={!open}>
      {content}
    </aside>
  )
})

function CollapsibleFileDiff({
  fileDiff,
  options
}: {
  fileDiff: FileDiffMetadata
  options: typeof diffOptionsBase & { diffStyle: DiffStyleMode; overflow: 'wrap' | 'scroll' }
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [contentVisible, setContentVisible] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const totals = summarizeFileDiff(fileDiff)
  const title = fileDiff.prevName ? `${fileDiff.prevName} -> ${fileDiff.name}` : fileDiff.name

  // The <diffs-container> web component starts empty (height 0) and fills in once its
  // internal worker finishes syntax highlighting. Watch for the first non-zero height
  // to fade the content in only after it's actually rendered.
  useEffect(() => {
    if (collapsed) return
    setContentVisible(false)
    const el = contentRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (el.offsetHeight > 0) {
        setContentVisible(true)
        observer.disconnect()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapsed, fileDiff])

  return (
    <section className={`diff-file-panel ${collapsed ? 'collapsed' : ''}`}>
      <button
        type="button"
        className="diff-file-collapse-header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((isCollapsed) => !isCollapsed)}
        title={title}
      >
        <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="diff-file-collapse-name">{title}</span>
        <DiffStatsPill additions={totals.additions} deletions={totals.deletions} />
      </button>
      {!collapsed ? (
        <div
          ref={contentRef}
          className={`diff-file-content ${contentVisible ? 'visible' : ''}`}
        >
          <FileDiff
            fileDiff={fileDiff}
            options={{
              ...options,
              disableFileHeader: true
            }}
          />
        </div>
      ) : null}
    </section>
  )
}

export const EmbeddedDiffView = memo(function EmbeddedDiffView({
  diff,
  title,
  subtitle,
  actions,
  status,
  compactTitle = false
}: EmbeddedDiffViewProps): React.JSX.Element {
  const files = useMemo(() => parsePatch(diff, null), [diff])
  const lineCount = useMemo(() => diff.split('\n').length, [diff])
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => {
          const fileTotals = summarizeFileDiff(file)
          return {
            additions: sum.additions + fileTotals.additions,
            deletions: sum.deletions + fileTotals.deletions
          }
        },
        { additions: 0, deletions: 0 }
      ),
    [files]
  )
  const autoCollapsed = lineCount > 400 || files.length > 5 || diff.length > 80_000
  const displayFileCount = files.length || 1
  const displayTitle = compactTitle ? basename(title) : title
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    setCollapsed(true)
  }, [diff])

  return (
    <section className={`embedded-diff-card ${collapsed ? 'collapsed' : ''}`}>
      <div className="embedded-diff-header">
        <button
          type="button"
          className="embedded-diff-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={title}
        >
          <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
          <span className="embedded-diff-title">{displayTitle}</span>
          {!compactTitle ? (
            <>
              <span className="embedded-diff-meta">
                {displayFileCount} {displayFileCount === 1 ? 'file' : 'files'}
              </span>
              <DiffStats additions={totals.additions} deletions={totals.deletions} />
              {autoCollapsed ? <span className="embedded-diff-meta">large</span> : null}
            </>
          ) : null}
        </button>
        {status ? <div className="embedded-diff-status">{status}</div> : null}
        {actions ? <div className="embedded-diff-actions">{actions}</div> : null}
      </div>
      {subtitle ? <p className="embedded-diff-subtitle">{subtitle}</p> : null}
      {!collapsed ? (
        <div className="embedded-diff-body">
          {files.length > 0 ? (
            <WorkerPoolContextProvider {...diffWorkerPool}>
              <div className="diff-file-stack">
                {files.map((file) => (
                  <CollapsibleFileDiff
                    key={`${file.prevName ?? ''}:${file.name}`}
                    fileDiff={file}
                    options={{
                      ...diffOptionsBase,
                      diffStyle: 'unified',
                      overflow: 'scroll'
                    }}
                  />
                ))}
              </div>
            </WorkerPoolContextProvider>
          ) : (
            <RawEmbeddedDiff diff={diff} />
          )}
        </div>
      ) : null}
    </section>
  )
})

function RawEmbeddedDiff({ diff }: { diff: string }): React.JSX.Element {
  return (
    <pre className="embedded-diff-raw">
      {diff.split('\n').map((line, index) => (
        <span
          key={`${index}:${line}`}
          className={`embedded-diff-raw-line ${rawDiffLineTone(line)}`}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

function rawDiffLineTone(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'addition'
  if (line.startsWith('-')) return 'deletion'
  if (line.startsWith('@@')) return 'hunk'
  return 'context'
}

export const DiffPreviewPopover = memo(function DiffPreviewPopover({
  preview,
  threadId,
  onClose,
  onOpenSidebar
}: DiffPreviewPopoverProps): React.JSX.Element | null {
  const range = preview
    ? {
        fromTurnCount: preview.summary.checkpointTurnCount - 1,
        toTurnCount: preview.summary.checkpointTurnCount
      }
    : null
  const { result, loading, error } = useCheckpointDiff(
    preview ? threadId : null,
    range,
    Boolean(preview)
  )
  const file = useMemo(() => {
    if (!result?.diff || !preview) return null
    const trimmed = trimPatchContext(result.diff, 2)
    return parsePatch(trimmed, range).find(
      (candidate) =>
        candidate.name === preview.file.path || candidate.prevName === preview.file.path
    )
  }, [preview, range, result?.diff])
  const style = useMemo<CSSProperties>(() => {
    if (!preview) return {}
    return {
      left: Math.min(preview.rect.left, window.innerWidth - 520),
      top: Math.min(preview.rect.bottom + 10, window.innerHeight - 420)
    }
  }, [preview])

  useEffect(() => {
    if (!preview) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, preview])

  if (!preview) return null
  return (
    <>
      <button className="diff-popover-scrim" aria-label="Close preview" onClick={onClose} />
      <div className="diff-preview-popover" style={style} role="dialog" aria-label="Diff preview">
        <div className="diff-preview-header">
          <div>
            <p>{basename(preview.file.path)}</p>
            <span>{preview.file.path}</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenSidebar(preview.summary.turnId, preview.file.path)}
          >
            View
          </button>
        </div>
        <div className="diff-preview-body">
          {loading ? <DiffEmptyState label="Loading preview..." /> : null}
          {error ? <DiffEmptyState label={error} tone="error" /> : null}
          {file ? (
            <WorkerPoolContextProvider {...diffWorkerPool}>
              <FileDiff
                fileDiff={file}
                options={{
                  ...diffOptionsBase,
                  diffStyle: 'unified',
                  overflow: 'wrap',
                  disableFileHeader: true
                }}
              />
            </WorkerPoolContextProvider>
          ) : null}
        </div>
      </div>
    </>
  )
})

function useCheckpointDiff(
  threadId: string | null,
  range: { fromTurnCount: number; toTurnCount: number } | null,
  enabled: boolean,
  version: string | number = 0
): { result: CheckpointDiffResult | null; loading: boolean; error: string | null } {
  const [result, setResult] = useState<CheckpointDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key =
    threadId && range ? `${threadId}:${range.fromTurnCount}:${range.toTurnCount}:${version}` : null
  const latestKeyRef = useRef<string | null>(null)

  const fromTurnCount = range?.fromTurnCount
  const toTurnCount = range?.toTurnCount

  useEffect(() => {
    if (!enabled || !threadId || !range || !key) {
      setResult(null)
      setLoading(false)
      setError(null)
      return
    }
    latestKeyRef.current = key
    setLoading(true)
    setError(null)
    let promise = diffCache.get(key)
    if (!promise) {
      promise = window.agentApi.getCheckpointDiff({ threadId, ...range })
      diffCache.set(key, promise)
    }
    void promise
      .then((nextResult) => {
        if (latestKeyRef.current !== key) return
        setResult(nextResult)
      })
      .catch((loadError) => {
        if (latestKeyRef.current !== key) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (latestKeyRef.current === key) setLoading(false)
      })
  }, [enabled, fromTurnCount, key, threadId, toTurnCount])

  return { result, loading, error }
}

function useCheckpointWorktreeDiff(
  threadId: string | null,
  fromTurnCount: number,
  enabled: boolean,
  version: string | number
): { result: CheckpointWorktreeDiffResult | null; loading: boolean; error: string | null } {
  const [result, setResult] = useState<CheckpointWorktreeDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestKeyRef = useRef<string | null>(null)
  const key = threadId ? `${threadId}:${fromTurnCount}:worktree:${version}` : null

  useEffect(() => {
    if (!enabled || !threadId || !key) {
      setResult(null)
      setLoading(false)
      setError(null)
      return
    }
    latestKeyRef.current = key
    setLoading(true)
    setError(null)
    void window.agentApi
      .getCheckpointWorktreeDiff({ threadId, fromTurnCount })
      .then((nextResult) => {
        if (latestKeyRef.current !== key) return
        setResult(nextResult)
      })
      .catch((loadError) => {
        if (latestKeyRef.current !== key) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (latestKeyRef.current === key) setLoading(false)
      })
  }, [enabled, fromTurnCount, key, threadId])

  return { result, loading, error }
}

function parsePatch(
  patch: string,
  range: { fromTurnCount: number; toTurnCount: number } | null
): FileDiffMetadata[] {
  if (!patch.trim()) return []
  try {
    return parsePatchFiles(
      patch,
      range ? `checkpoint-${range.fromTurnCount}-${range.toTurnCount}` : undefined,
      true
    ).flatMap((parsed) => parsed.files)
  } catch (error) {
    console.error('[cobel:parse-diff]', error)
    return []
  }
}

function DiffStatsPill({
  additions,
  deletions
}: {
  additions: number
  deletions: number
}): React.JSX.Element {
  return (
    <span className="diff-stats-pill">
      <DiffStats additions={additions} deletions={deletions} />
    </span>
  )
}

function DiffStats({
  additions,
  deletions
}: {
  additions: number
  deletions: number
}): React.JSX.Element {
  return (
    <span className="diff-stats">
      <span className="additions">+{additions}</span>
      <span className="deletions">-{deletions}</span>
    </span>
  )
}

function DiffToolbarPill({
  as = 'button',
  active = false,
  iconOnly = false,
  className,
  children,
  title,
  ariaLabel,
  onClick
}: DiffToolbarPillProps): React.JSX.Element {
  const classes = [
    'diff-toolbar-pill',
    active ? 'active' : '',
    iconOnly ? 'icon-only' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  if (as === 'span') {
    return (
      <span className={classes} title={title} aria-label={ariaLabel}>
        {children}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )
}

function SegmentedControl({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="diff-segmented-control" aria-label={label}>
      {options.map((option) => (
        <DiffToolbarPill
          key={option.value}
          active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </DiffToolbarPill>
      ))}
    </div>
  )
}

function DiffEmptyState({ label, tone }: { label: string; tone?: 'error' }): React.JSX.Element {
  return <div className={`diff-empty-state ${tone ?? ''}`}>{label}</div>
}

function filterDiffFiles(
  files: FileDiffMetadata[],
  selectedPath: string | null
): FileDiffMetadata[] {
  if (!selectedPath) return files
  const normalizedPrefix = selectedPath.endsWith('/') ? selectedPath : `${selectedPath}/`
  return files.filter(
    (file) =>
      file.name === selectedPath ||
      file.prevName === selectedPath ||
      file.name.startsWith(normalizedPrefix) ||
      file.prevName?.startsWith(normalizedPrefix) === true
  )
}

function formatSelectedPath(path: string): string {
  return path.endsWith('/') ? path : path
}

function buildCheckpointRefreshKey(summaries: OrchestrationCheckpointSummary[]): string {
  if (summaries.length === 0) return 'none'
  return summaries
    .map((summary) =>
      [
        summary.id,
        summary.status,
        summary.checkpointTurnCount,
        summary.completedAt,
        summary.files.length,
        summary.errorMessage ?? ''
      ].join(':')
    )
    .join('|')
}

function summarizeFiles(files: CheckpointFileChange[]): {
  additions: number
  deletions: number
} {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions
    }),
    { additions: 0, deletions: 0 }
  )
}

function summarizeFileDiff(file: FileDiffMetadata): {
  additions: number
  deletions: number
} {
  return file.hunks.reduce(
    (totals, hunk) => ({
      additions: totals.additions + hunk.additionLines,
      deletions: totals.deletions + hunk.deletionLines
    }),
    { additions: 0, deletions: 0 }
  )
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

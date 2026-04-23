import { memo, useEffect, useMemo, useRef } from 'react'
import {
  FileTree as FileTreeModel,
  prepareFileTreeInput,
  themeToTreeStyles,
  type FileTreeRowDecorationRenderer,
  type GitStatusEntry
} from '@pierre/trees'
import { FileTree as ChangedFilesTree, useFileTreeSearch } from '@pierre/trees/react'
import { FolderTree, Search, X } from 'lucide-react'
import type { CheckpointFileChange } from '../../../../shared/agent'

export interface DiffChangedFileChoice {
  path: string
  label: string
  detail: string
}

interface DiffChangedFilesTreeProps {
  mode: 'full' | 'turn'
  threadId: string | null
  fileChoices: DiffChangedFileChoice[]
  summaryFiles: CheckpointFileChange[]
  selectedFilePath: string | null
  open: boolean
  onSelectFile: (path: string | null) => void
  onClose: () => void
}

interface DiffTreeToggleButtonProps {
  active: boolean
  disabled?: boolean
  onClick: () => void
}

const treeTheme = themeToTreeStyles({
  type: 'dark',
  bg: 'rgba(9, 9, 11, 0.98)',
  fg: 'rgba(228, 229, 235, 0.82)',
  colors: {
    'sideBar.background': 'rgba(9, 9, 11, 0.98)',
    'sideBar.foreground': 'rgba(228, 229, 235, 0.82)',
    'sideBar.border': 'transparent',
    'sideBarSectionHeader.foreground': 'rgba(200, 201, 212, 0.58)',
    'list.hoverBackground': 'rgba(255, 255, 255, 0.032)',
    'list.activeSelectionBackground': 'rgba(255, 255, 255, 0.04)',
    'list.activeSelectionForeground': 'rgba(245, 245, 246, 0.94)',
    'list.focusOutline': 'rgba(255, 255, 255, 0.1)',
    'input.background': 'transparent',
    'input.border': 'transparent',
    'scrollbarSlider.background': 'rgba(255, 255, 255, 0.1)',
    'gitDecoration.addedResourceForeground': 'rgba(228, 229, 235, 0.42)',
    'gitDecoration.modifiedResourceForeground': 'rgba(228, 229, 235, 0.42)',
    'gitDecoration.deletedResourceForeground': 'rgba(228, 229, 235, 0.42)'
  }
})

const treeUnsafeCss = `
  :host {
    height: 100%;
    background: rgba(9, 9, 11, 0.98);
    --trees-padding-inline-override: 4px;
    --trees-level-gap-override: 4px;
    --trees-item-padding-x-override: 4px;
    --trees-item-margin-x-override: 0px;
    --trees-item-row-gap-override: 4px;
    --trees-icon-width-override: 12px;
  }

  button[data-type='item'] {
    color: rgba(228, 229, 235, 0.82);
    border-radius: 7px;
  }

  button[data-type='item']:hover {
    background: rgba(255, 255, 255, 0.032);
  }

  button[data-type='item'][data-item-selected] {
    background: rgba(255, 255, 255, 0.04);
    color: rgba(245, 245, 246, 0.94);
  }
`

export const DiffTreeToggleButton = memo(function DiffTreeToggleButton({
  active,
  disabled = false,
  onClick
}: DiffTreeToggleButtonProps): React.JSX.Element | null {
  if (disabled) return null

  return (
    <button
      type="button"
      className={`diff-toolbar-pill diff-tree-toggle ${active ? 'active' : ''}`}
      onClick={onClick}
      aria-label={active ? 'Hide changed files tree' : 'Show changed files tree'}
      title={active ? 'Hide changed files tree' : 'Show changed files tree'}
    >
      <FolderTree size={13} strokeWidth={1.8} aria-hidden="true" />
      <span>Tree</span>
    </button>
  )
})

export const DiffChangedFilesTree = memo(function DiffChangedFilesTree({
  mode,
  threadId,
  fileChoices,
  summaryFiles,
  selectedFilePath,
  open,
  onSelectFile,
  onClose
}: DiffChangedFilesTreeProps): React.JSX.Element | null {
  const selectedFilePathRef = useRef(selectedFilePath)
  const onSelectFileRef = useRef(onSelectFile)
  const treePaths = useMemo(() => fileChoices.map((file) => file.path), [fileChoices])
  const treePreparedInput = useMemo(() => prepareFileTreeInput(treePaths), [treePaths])
  const fileChangesByPath = useMemo(() => {
    const byPath = new Map<string, CheckpointFileChange>()
    for (const file of summaryFiles) byPath.set(file.path, file)
    return byPath
  }, [summaryFiles])
  const treeGitStatus = useMemo<GitStatusEntry[]>(
    () =>
      fileChoices.flatMap((file) => {
        const change = fileChangesByPath.get(file.path)
        return change ? [{ path: file.path, status: change.kind }] : []
      }),
    [fileChoices, fileChangesByPath]
  )
  const treeRowDecoration = useMemo<FileTreeRowDecorationRenderer>(
    () => ({ item }) => {
      const change = fileChangesByPath.get(item.path)
      if (!change) return null
      return {
        text: changeKindDecoration(change.kind),
        title: changeKindTitle(change)
      }
    },
    [fileChangesByPath]
  )
  const treeInitialExpandedPaths = useMemo(
    () => getInitialExpandedTreePaths(treePaths, selectedFilePath),
    [selectedFilePath, treePaths]
  )
  const changedFilesTree = useMemo(
    () =>
      new FileTreeModel({
        id: `diff-review-tree-${threadId ?? 'detached'}-${mode}`,
        search: false,
        initialExpansion: 'open',
        stickyFolders: false,
        initialVisibleRowCount: 11,
        preparedInput: treePreparedInput,
        initialExpandedPaths: treeInitialExpandedPaths,
        initialSelectedPaths: selectedFilePath ? [selectedFilePath] : [],
        gitStatus: treeGitStatus,
        renderRowDecoration: treeRowDecoration,
        unsafeCSS: treeUnsafeCss,
        onSelectionChange: (paths: readonly string[]) => {
          const nextPath = paths[0] ?? null
          if (nextPath?.endsWith('/')) {
            const folderItem = changedFilesTree.getItem(nextPath)
            folderItem?.deselect()

            const previousPath = selectedFilePathRef.current
            if (previousPath) {
              const previousItem = changedFilesTree.getItem(previousPath)
              previousItem?.select()
              previousItem?.focus()
            }
            return
          }
          if (nextPath === selectedFilePathRef.current) return
          onSelectFileRef.current(nextPath)
        }
      }),
    [mode, threadId]
  )
  const search = useFileTreeSearch(changedFilesTree)
  useEffect(() => {
    selectedFilePathRef.current = selectedFilePath
  }, [selectedFilePath])

  useEffect(() => {
    onSelectFileRef.current = onSelectFile
  }, [onSelectFile])

  useEffect(() => {
    changedFilesTree.resetPaths(treePaths, {
      preparedInput: treePreparedInput,
      initialExpandedPaths: treeInitialExpandedPaths
    })
    changedFilesTree.setGitStatus(treeGitStatus)
  }, [
    changedFilesTree,
    treeGitStatus,
    treeInitialExpandedPaths,
    treePaths,
    treePreparedInput
  ])

  useEffect(() => {
    const currentSelection = changedFilesTree.getSelectedPaths()[0] ?? null
    if (currentSelection === selectedFilePath) return
    if (currentSelection) changedFilesTree.getItem(currentSelection)?.deselect()
    if (selectedFilePath) {
      const item = changedFilesTree.getItem(selectedFilePath)
      if (item) {
        item.select()
        item.focus()
      } else {
        changedFilesTree.focusNearestPath(selectedFilePath)
      }
    }
  }, [changedFilesTree, selectedFilePath])

  useEffect(() => {
    if (!open && search.value) search.setValue(null)
  }, [open, search])

  useEffect(() => () => changedFilesTree.cleanUp(), [changedFilesTree])

  if (fileChoices.length === 0) return null

  return (
    <>
      <button
        type="button"
        className={`diff-review-tree-scrim ${open ? 'open' : ''}`}
        aria-label="Close changed files drawer"
        onClick={onClose}
      />
      <section
        className={`diff-review-tree-drawer ${open ? 'open' : ''}`}
        aria-label="Changed files tree"
      >
        <div className="diff-review-tree-header">
          <div className="diff-review-tree-actions">
            {selectedFilePath ? (
              <button
                type="button"
                className="diff-review-tree-reset"
                onClick={() => onSelectFile(null)}
              >
                All files
              </button>
            ) : null}
            <button
              type="button"
              className="diff-review-tree-close"
              aria-label="Close changed files drawer"
              onClick={onClose}
            >
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>
        <label className="diff-file-search diff-review-tree-search">
          <Search size={11} strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">Search changed files tree</span>
          <input
            value={search.value ?? ''}
            onChange={(event) => search.setValue(event.target.value || null)}
            placeholder="Search files"
            autoFocus={open}
          />
        </label>
        <div className="diff-review-tree-shell">
          <ChangedFilesTree
            aria-label="Changed files tree"
            className="diff-review-tree"
            model={changedFilesTree}
            style={{ ...treeTheme, height: '100%' }}
          />
        </div>
      </section>
    </>
  )
})

function getInitialExpandedTreePaths(paths: readonly string[], selectedPath: string | null): string[] {
  const expanded = new Set<string>()
  const topLevel = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/').filter(Boolean)
    if (segments.length > 1) topLevel.add(segments[0] ?? path)
  }
  if (topLevel.size > 0 && topLevel.size <= 3) {
    for (const path of topLevel) expanded.add(path)
  }
  if (selectedPath) {
    const segments = selectedPath.split('/').filter(Boolean)
    for (let index = 1; index < segments.length; index += 1) {
      expanded.add(segments.slice(0, index).join('/'))
    }
  }
  return [...expanded]
}

function changeKindDecoration(kind: CheckpointFileChange['kind']): string {
  switch (kind) {
    case 'added':
      return '+'
    case 'deleted':
      return '-'
    case 'renamed':
      return '->'
    default:
      return '~'
  }
}

function changeKindTitle(file: CheckpointFileChange): string {
  switch (file.kind) {
    case 'added':
      return 'Added file'
    case 'deleted':
      return 'Deleted file'
    case 'renamed':
      return file.oldPath ? `Renamed from ${file.oldPath}` : 'Renamed file'
    default:
      return 'Modified file'
  }
}

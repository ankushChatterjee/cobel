import { useState, type ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCheckpointSummary } from '../../../../shared/agent'
import {
  ChangedFilePills,
  DiffReviewSidebar,
  EmbeddedDiffView,
  FloatingDiffPill,
  type DiffPanelMode,
  type DiffStyleMode
} from './DiffReview'

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string; prevName?: string } }) => (
    <div data-testid="mock-file-diff">
      {fileDiff.prevName ? `${fileDiff.prevName} -> ${fileDiff.name}` : fileDiff.name}
    </div>
  ),
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}))

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

const fullDiff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old app
+new app
diff --git a/src/components/Button.tsx b/src/components/Button.tsx
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/components/Button.tsx
@@ -0,0 +1 @@
+export const Button = () => null
diff --git a/docs/guide.md b/docs/guide.md
deleted file mode 100644
index 4444444..0000000
--- a/docs/guide.md
+++ /dev/null
@@ -1 +0,0 @@
-legacy docs
`

const lastTurnDiff = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/components/Button.tsx
@@ -0,0 +1 @@
+export const Button = () => null
diff --git a/web/index.ts b/web/index.ts
index 5555555..6666666 100644
--- a/web/index.ts
+++ b/web/index.ts
@@ -1 +1 @@
-export const page = 'old'
+export const page = 'new'
`

const summaries: OrchestrationCheckpointSummary[] = [
  {
    id: 'checkpoint-1',
    turnId: 'turn-1',
    checkpointTurnCount: 1,
    status: 'ready',
    files: [
      {
        path: 'src/app.ts',
        kind: 'modified',
        additions: 1,
        deletions: 1
      },
      {
        path: 'docs/guide.md',
        kind: 'deleted',
        additions: 0,
        deletions: 1
      }
    ],
    completedAt: '2026-04-23T10:00:00.000Z'
  },
  {
    id: 'checkpoint-2',
    turnId: 'turn-2',
    checkpointTurnCount: 2,
    status: 'ready',
    files: [
      {
        path: 'src/components/Button.tsx',
        kind: 'added',
        additions: 1,
        deletions: 0
      },
      {
        path: 'web/index.ts',
        kind: 'modified',
        additions: 1,
        deletions: 1
      }
    ],
    completedAt: '2026-04-23T10:01:00.000Z'
  }
]

function DiffReviewHarness({
  open = true,
  initialMode = 'full',
  initialSelectedFilePath = null,
  summariesOverride = summaries,
  threadId = 'thread:test',
  workspacePath = '/tmp/project'
}: {
  open?: boolean
  initialMode?: DiffPanelMode
  initialSelectedFilePath?: string | null
  summariesOverride?: OrchestrationCheckpointSummary[]
  threadId?: string | null
  workspacePath?: string | null
}): React.JSX.Element {
  const [mode, setMode] = useState<DiffPanelMode>(initialMode)
  const [diffStyle, setDiffStyle] = useState<DiffStyleMode>('unified')
  const [wrapLines, setWrapLines] = useState(false)
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(initialSelectedFilePath)

  return (
    <DiffReviewSidebar
      open={open}
      workspacePath={workspacePath}
      threadId={threadId}
      summaries={summariesOverride}
      mode={mode}
      diffStyle={diffStyle}
      wrapLines={wrapLines}
      selectedTurnId={selectedTurnId}
      selectedFilePath={selectedFilePath}
      workspaceDiffVersion={0}
      workspaceDiffRefreshKey={0}
      onModeChange={setMode}
      onDiffStyleChange={setDiffStyle}
      onWrapLinesChange={setWrapLines}
      onSelectTurn={setSelectedTurnId}
      onSelectFile={setSelectedFilePath}
      onCommitFull={() => {}}
      onRefresh={() => {}}
      onClose={() => {}}
      resizeLabel="Resize review panel"
      resizeMin={420}
      resizeMax={920}
      resizeValue={640}
      onResizeStart={() => {}}
      onResizeMove={() => {}}
      onResizeEnd={() => {}}
      onResizeKeyDown={() => {}}
    />
  )
}

function getTreeShadowRoot(container: HTMLElement): ShadowRoot {
  const treeHost = container.querySelector<HTMLElement>('.diff-review-tree')
  expect(treeHost).not.toBeNull()
  expect(treeHost?.shadowRoot).not.toBeNull()
  return treeHost?.shadowRoot as ShadowRoot
}

describe('DiffReviewSidebar tree integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.agentApi.getWorkspaceDiff = vi.fn(async (input) => ({
      ...input,
      diff: fullDiff,
      files: [...summaries[0].files, ...summaries[1].files],
      truncated: false
    }))
    window.agentApi.getCheckpointDiff = vi.fn(async (input) => ({
      ...input,
      diff: lastTurnDiff,
      truncated: false
    }))
  })

  it('shows the tree toggle and opens the changed-files drawer', async () => {
    const user = userEvent.setup()
    const { container } = render(<DiffReviewHarness />)

    const toggle = await screen.findByRole('button', { name: /show changed files tree/i })
    await user.click(toggle)

    expect((await screen.findAllByLabelText('Changed files tree')).length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('.diff-review-tree-drawer.open')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search files')).toBeInTheDocument()
    expect(container.querySelector('.diff-review-tree')).toBeInTheDocument()
    expect(getTreeShadowRoot(container)).toBeInstanceOf(ShadowRoot)
  })

  it('filters the diff body when a specific file is selected', async () => {
    render(<DiffReviewHarness initialSelectedFilePath="src/components/Button.tsx" />)

    await waitFor(() => {
      const renderedDiffs = screen.getAllByTestId('mock-file-diff')
      expect(renderedDiffs).toHaveLength(1)
      expect(renderedDiffs[0]).toHaveTextContent('src/components/Button.tsx')
    })
  })

  it('updates the diff body when switching from full diff to the last turn', async () => {
    const user = userEvent.setup()
    render(<DiffReviewHarness />)

    await waitFor(() => {
      const renderedDiffs = screen.getAllByTestId('mock-file-diff')
      expect(renderedDiffs).toHaveLength(3)
      expect(renderedDiffs.some((diff) => diff.textContent === 'docs/guide.md')).toBe(true)
    })

    await user.click(screen.getByRole('button', { name: 'Last turn' }))

    await waitFor(() => {
      const renderedDiffs = screen.getAllByTestId('mock-file-diff')
      expect(renderedDiffs).toHaveLength(2)
      const renderedNames = renderedDiffs.map((diff) => diff.textContent)
      expect(renderedNames).toContain('web/index.ts')
      expect(renderedNames).toContain('src/components/Button.tsx')
      expect(renderedNames).not.toContain('docs/guide.md')
    })
  })

  it('keeps the diff controls intact with the tree rail open and hides the toggle when no files exist', async () => {
    const user = userEvent.setup()
    const { container } = render(<DiffReviewHarness />)
    expect(
      await screen.findByRole('button', { name: /show changed files tree/i })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show changed files tree/i }))
    expect(container.querySelector('.diff-review-controls')).toBeInTheDocument()
    expect(container.querySelector('.diff-review-tree-drawer.open')).toBeInTheDocument()
  })

  it('filters the changed files tree with the custom drawer search input', async () => {
    const user = userEvent.setup()
    const { container } = render(<DiffReviewHarness />)

    await user.click(await screen.findByRole('button', { name: /show changed files tree/i }))

    const searchInput = screen.getByPlaceholderText('Search files')
    await user.type(searchInput, 'button')

    expect(searchInput).toHaveValue('button')
    expect(container.querySelector('.diff-review-tree-drawer.open')).toBeInTheDocument()
  })

  it('shows a scoped empty state when the selected path has no diff matches', async () => {
    render(<DiffReviewHarness initialSelectedFilePath="src/missing" />)

    expect(await screen.findByText('No changed files match "src/missing".')).toBeInTheDocument()
  })

  it('treats trailing-slash selections as folder filters', async () => {
    render(<DiffReviewHarness initialSelectedFilePath="src/components/" />)

    await waitFor(() => {
      const renderedDiffs = screen.getAllByTestId('mock-file-diff')
      expect(renderedDiffs).toHaveLength(1)
      expect(renderedDiffs[0]).toHaveTextContent('src/components/Button.tsx')
    })
  })

  it('does not render a tree toggle when the diff has no changed files', async () => {
    window.agentApi.getWorkspaceDiff = vi.fn(async (input) => ({
      ...input,
      diff: '',
      files: [],
      truncated: false
    }))

    render(<DiffReviewHarness summariesOverride={[]} />)

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /show changed files tree/i })
      ).not.toBeInTheDocument()
      expect(screen.getByText('No unstaged workspace changes.')).toBeInTheDocument()
    })
  })

  it('allows full diff without an active thread and keeps last turn unavailable', async () => {
    const user = userEvent.setup()
    render(<DiffReviewHarness threadId={null} summariesOverride={[]} />)

    await waitFor(() => {
      const renderedDiffs = screen.getAllByTestId('mock-file-diff')
      expect(renderedDiffs).toHaveLength(3)
    })

    expect(screen.getByRole('button', { name: 'Last turn' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Last turn' }))

    await waitFor(() => {
      expect(screen.queryByText('No turn-specific diff is available yet.')).not.toBeInTheDocument()
    })
  })

  it('shows workspace stats in full mode instead of the checkpoint empty-copy', async () => {
    render(<DiffReviewHarness />)

    expect(await screen.findByText('+3')).toBeInTheDocument()
    expect(screen.getByText('-3')).toBeInTheDocument()
    expect(screen.queryByText('No completed changes yet')).not.toBeInTheDocument()
  })

  it('disables last turn and hides the pager when no turn diff summaries are available', async () => {
    const emptyTurnSummaries: OrchestrationCheckpointSummary[] = [
      {
        id: 'checkpoint-empty',
        turnId: 'turn-empty',
        checkpointTurnCount: 1,
        status: 'ready',
        files: [],
        completedAt: '2026-04-23T10:00:00.000Z'
      }
    ]

    render(<DiffReviewHarness summariesOverride={emptyTurnSummaries} />)

    expect(await screen.findByRole('button', { name: 'Last turn' })).toBeDisabled()
    expect(screen.queryByLabelText(/latest turn/i)).not.toBeInTheDocument()
  })
})

describe('ChangedFilePills', () => {
  it('places the total files pill in the same wrapping row as changed file pills', () => {
    const manyFileSummary: OrchestrationCheckpointSummary = {
      id: 'checkpoint-many',
      turnId: 'turn-many',
      checkpointTurnCount: 3,
      status: 'ready',
      files: Array.from({ length: 10 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        kind: 'modified',
        additions: index + 1,
        deletions: index % 2
      })),
      completedAt: '2026-04-23T10:02:00.000Z'
    }

    const { container } = render(
      <ChangedFilePills
        summary={manyFileSummary}
        onPreview={() => {}}
        onOpenDiff={() => {}}
        revertTurnCount={3}
        onRevert={() => {}}
      />
    )

    const pillRow = container.querySelector('.changed-file-pills')
    expect(pillRow).not.toBeNull()
    expect(pillRow?.querySelector('.changed-files-total')).toHaveTextContent('10 files')
    expect(pillRow?.querySelectorAll('.changed-file-pill')).toHaveLength(8)
    expect(pillRow?.querySelector('.changed-file-more')).toHaveTextContent('+2')
    expect(pillRow?.querySelector('.changed-file-undo')).toHaveTextContent('Undo')
  })
})

describe('EmbeddedDiffView', () => {
  it('renders a compact embedded diff expanded by default', async () => {
    const { container } = render(
      <EmbeddedDiffView diff={lastTurnDiff} title="src/components/Button.tsx" />
    )
    const toggle = container.querySelector<HTMLButtonElement>('.embedded-diff-toggle')

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryAllByTestId('mock-file-diff')).toHaveLength(2)
  })

  it('collapses expanded diffs on demand', async () => {
    const user = userEvent.setup()
    const hugeDiff = Array.from({ length: 410 }, (_, index) => `+line ${index}`).join('\n')

    render(<EmbeddedDiffView diff={hugeDiff} title="large patch" />)

    const toggle = screen.getByRole('button', { name: /large patch/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('+line 1')).toBeInTheDocument()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/\+line 1/i)).not.toBeInTheDocument()
  })

  it('colors added and removed lines in raw embedded diffs', async () => {
    const { container } = render(
      <EmbeddedDiffView diff={'@@ -1 +1 @@\n-old\n+new\n context'} title="raw patch" />
    )

    expect(container.querySelector('.embedded-diff-raw-line.hunk')).toHaveTextContent('@@')
    expect(container.querySelector('.embedded-diff-raw-line.deletion')).toHaveTextContent('-old')
    expect(container.querySelector('.embedded-diff-raw-line.addition')).toHaveTextContent('+new')
  })

  it('compact single-file embedded diff has no inner file header row', async () => {
    const { container } = render(
      <EmbeddedDiffView diff={`diff --git a/src/components/layout/Sidebar.tsx b/src/components/layout/Sidebar.tsx
--- a/src/components/layout/Sidebar.tsx
+++ b/src/components/layout/Sidebar.tsx
@@ -1,1 +1,1 @@
-old
+new
`} title="/abs/src/components/layout/Sidebar.tsx" compactTitle />
    )
    expect(container.querySelector('.diff-file-collapse-header')).toBeNull()
    expect(container.querySelector('.embedded-diff-single-file')).not.toBeNull()
  })
})

describe('FloatingDiffPill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refreshes when workspace diffs change and stays visible when empty', async () => {
    const getWorkspaceDiff = vi
      .fn()
      .mockResolvedValueOnce({
        cwd: '/tmp/project',
        diff: fullDiff,
        files: summaries[0].files,
        truncated: false
      })
      .mockResolvedValueOnce({
        cwd: '/tmp/project',
        diff: '',
        files: [],
        truncated: false
      })

    window.agentApi.getWorkspaceDiff = getWorkspaceDiff

    const { rerender } = render(
      <FloatingDiffPill
        workspacePath="/tmp/project"
        workspaceDiffVersion={0}
        open={false}
        onToggle={() => {}}
      />
    )

    expect(await screen.findByRole('button', { name: /workspace diff/i })).toHaveTextContent('+1')
    expect(screen.getByRole('button', { name: /workspace diff/i })).toHaveTextContent('-2')

    rerender(
      <FloatingDiffPill
        workspacePath="/tmp/project"
        workspaceDiffVersion={1}
        open={false}
        onToggle={() => {}}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /workspace diff/i })).toHaveTextContent('•')
      expect(screen.getByRole('button', { name: /workspace diff/i })).toHaveClass('empty')
    })
    expect(getWorkspaceDiff).toHaveBeenCalledTimes(2)
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptList } from './TranscriptList'
import type { ActivityTranscriptItem, TranscriptItem } from '../types'
import type { OrchestrationCheckpointSummary } from '../../../../../shared/agent'

const t0 = '2026-04-19T00:00:00.000Z'

function toolItem(id: string, sequence: number): ActivityTranscriptItem {
  return {
    id: `activity:${id}`,
    kind: 'activity',
    sequence,
    createdAt: t0,
    activity: {
      id,
      kind: 'tool.completed',
      tone: 'tool',
      summary: `tool ${sequence}`,
      payload: {
        itemType: 'command_execution',
        status: 'completed',
        title: `tool ${sequence}`,
        detail: '/tmp'
      },
      turnId: 'turn-1',
      sequence,
      createdAt: t0
    }
  }
}

function fileChangeItem({
  id,
  sequence,
  status,
  diff,
  title = 'src/app.ts',
  stateInput
}: {
  id: string
  sequence: number
  status: 'inProgress' | 'completed'
  diff?: string
  title?: string
  stateInput?: Record<string, unknown>
}): ActivityTranscriptItem {
  return {
    id: `activity:${id}`,
    kind: 'activity',
    sequence,
    createdAt: t0,
    activity: {
      id,
      kind: status === 'completed' ? 'tool.completed' : 'tool.updated',
      tone: 'tool',
      summary: title,
      payload: {
        itemType: 'file_change',
        status,
        title,
        ...(diff ? { fileEditChanges: [{ path: 'src/app.ts', diff }] } : {}),
        ...(stateInput ? { data: { tool: 'edit', state: { input: stateInput } } } : {})
      },
      turnId: 'turn-1',
      sequence,
      resolved: status === 'completed',
      createdAt: t0
    }
  }
}

function assistantMessage(sequence: number): TranscriptItem {
  return {
    id: 'message:assistant:1',
    kind: 'message',
    sequence,
    createdAt: t0,
    workDurationMs: null,
    message: {
      id: 'assistant:1',
      role: 'assistant',
      text: 'Still working',
      turnId: 'turn-1',
      streaming: false,
      sequence,
      createdAt: t0,
      updatedAt: t0
    }
  }
}

function userMessageWithAttachments(sequence: number, count: number): TranscriptItem {
  return {
    id: 'message:user:1',
    kind: 'message',
    sequence,
    createdAt: t0,
    workDurationMs: null,
    message: {
      id: 'user:1',
      role: 'user',
      text: 'What is in these images?',
      turnId: null,
      streaming: false,
      sequence,
      createdAt: t0,
      updatedAt: t0,
      attachments: Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        url: `file:///tmp/image-${index}.png`,
        name: `image-${index}.png`
      }))
    }
  }
}

function thinkingItem(
  id: string,
  sequence: number,
  turnId: string | null = null
): ActivityTranscriptItem {
  return {
    id: `activity:${id}`,
    kind: 'activity',
    sequence,
    createdAt: t0,
    activity: {
      id,
      kind: 'task.started',
      tone: 'thinking',
      summary: 'Exploring',
      payload: { status: 'inProgress' },
      turnId,
      resolved: false,
      sequence,
      createdAt: t0
    }
  }
}

function renderTranscript(
  items: TranscriptItem[],
  turnInProgress: boolean,
  checkpointByAssistantMessageId = new Map<string, OrchestrationCheckpointSummary>()
): ReturnType<typeof render> {
  return render(
    <TranscriptList
      items={items}
      showTranscriptTailRow={false}
      transcriptTailLabel={{ aria: '', text: '' }}
      transcriptTailSpinner={false}
      turnInProgress={turnInProgress}
      providerName="codex"
      expandedToolIds={new Set()}
      checkpointByAssistantMessageId={checkpointByAssistantMessageId}
      onOpenPlan={vi.fn()}
      onToggleTool={vi.fn()}
      onPreviewDiff={vi.fn()}
      onOpenDiff={vi.fn()}
      onRevert={vi.fn()}
    />
  )
}

describe('TranscriptList tool groups', () => {
  it('keeps the latest completed tool group open during an active turn', () => {
    renderTranscript([toolItem('tool:1', 1), toolItem('tool:2', 2)], true)

    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
  })

  it('allows a prior completed tool group to collapse after a later transcript item appears', () => {
    renderTranscript([toolItem('tool:1', 1), toolItem('tool:2', 2), assistantMessage(3)], true)

    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  })

  it('does not keep stale thinking rows active after the turn is no longer running', () => {
    renderTranscript([assistantMessage(1), thinkingItem('thinking:stale', 2)], false)

    expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('thinking…')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Model reasoning')).toBeInTheDocument()
  })

  it('does not open an empty reasoning body for active Codex thinking without text', () => {
    const { container } = renderTranscript([thinkingItem('thinking:codex', 1, 'turn-1')], true)

    expect(screen.getByLabelText('Model reasoning')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reasoning/i })).toBeInTheDocument()
    expect(container.querySelector('.transcript-reasoning-shell')).toBeNull()
  })

  it('shows an in-progress file change as a closed tile with a spinner', () => {
    const { container } = renderTranscript(
      [
        fileChangeItem({
          id: 'tool:file-change',
          sequence: 1,
          status: 'inProgress',
          diff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
        })
      ],
      true
    )

    const diffToggle = screen.getByRole('button', { name: /app\.ts/i })
    expect(diffToggle).toHaveAttribute('aria-expanded', 'false')
    expect(diffToggle).toHaveAttribute('aria-disabled', 'true')
    expect(container.querySelector('.tool-line-spinner')).toBeInTheDocument()
    expect(screen.queryByText('+new')).not.toBeInTheDocument()
  })

  it('shows a running OpenCode edit without a diff as a file tile', () => {
    const { container } = renderTranscript(
      [
        fileChangeItem({
          id: 'tool:opencode-edit',
          sequence: 1,
          status: 'inProgress',
          title: 'Edited edit',
          stateInput: { filePath: 'src/lib/themes.ts' }
        })
      ],
      true
    )

    const diffToggle = screen.getByRole('button', { name: /themes\.ts/i })
    expect(diffToggle).toHaveAttribute('aria-expanded', 'false')
    expect(diffToggle).toHaveAttribute('aria-disabled', 'true')
    expect(container.querySelector('.embedded-diff-card')).toBeInTheDocument()
    expect(container.querySelector('.tool-line-spinner')).toBeInTheDocument()
    expect(screen.queryByText('Edited edit')).not.toBeInTheDocument()
    expect(screen.queryByText('running')).not.toBeInTheDocument()
  })

  it('keeps completed file changes closed by default while showing diff stats', async () => {
    const { container } = renderTranscript(
      [
        fileChangeItem({
          id: 'tool:file-change',
          sequence: 1,
          status: 'completed',
          diff: 'not a parseable patch\n-old\n+new\n'
        })
      ],
      false
    )

    const diffToggle = screen.getByRole('button', { name: /app\.ts/i })
    expect(diffToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
    expect(screen.queryByText('+new')).not.toBeInTheDocument()

    fireEvent.click(diffToggle)

    expect(await screen.findByText('+new')).toBeInTheDocument()
    expect(container.querySelector('.tool-line-spinner')).not.toBeInTheDocument()
  })

  it('shows the attachment count on sent user messages', () => {
    renderTranscript([userMessageWithAttachments(1, 2)], false)

    expect(screen.getByLabelText('2 attachments')).toBeInTheDocument()
    expect(screen.getByText('2 attachments')).toBeInTheDocument()
  })

  it('renders changed file pills at the end of an assistant message', () => {
    const checkpoint: OrchestrationCheckpointSummary = {
      id: 'checkpoint:turn-1',
      turnId: 'turn-1',
      assistantMessageId: 'assistant:1',
      checkpointTurnCount: 1,
      status: 'ready',
      files: [
        {
          path: 'src/app.ts',
          kind: 'modified',
          additions: 2,
          deletions: 1
        }
      ],
      completedAt: t0
    }

    renderTranscript(
      [assistantMessage(1)],
      false,
      new Map([['assistant:1', checkpoint]])
    )

    const message = screen.getByText('Still working').closest('article')
    expect(message).not.toBeNull()
    expect(message).toContainElement(screen.getByLabelText('Changed files'))
    expect(screen.getByRole('button', { name: /1 files/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /app\.ts/i })).toBeInTheDocument()
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0)
  })
})

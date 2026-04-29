import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptList } from './TranscriptList'
import type { ActivityTranscriptItem, TranscriptItem } from '../types'

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

function renderTranscript(items: TranscriptItem[], turnInProgress: boolean): void {
  render(
    <TranscriptList
      items={items}
      showPendingThinking={false}
      turnInProgress={turnInProgress}
      providerName="codex"
      expandedToolIds={new Set()}
      submittingApprovals={new Map()}
      checkpointByAssistantMessageId={new Map()}
      onToggleTool={vi.fn()}
      onApprove={vi.fn()}
      onAnswer={vi.fn()}
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
})

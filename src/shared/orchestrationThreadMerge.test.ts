import { describe, expect, it } from 'vitest'
import type { OrchestrationThread, OrchestrationThreadActivity } from './agent'
import { mergeActivities, mergeThreadActivity, mergeThreadSnapshot } from './orchestrationThreadMerge'

const now = '2026-05-14T00:00:00.000Z'

function activity(
  overrides: Partial<OrchestrationThreadActivity> & { id?: string } = {}
): OrchestrationThreadActivity {
  return {
    id: overrides.id ?? 'tool:edit',
    kind: overrides.kind ?? 'tool.updated',
    tone: overrides.tone ?? 'tool',
    summary: overrides.summary ?? 'Edit file',
    payload: overrides.payload ?? { itemType: 'file_change', status: 'inProgress' },
    turnId: overrides.turnId ?? 'turn-1',
    sequence: overrides.sequence ?? 1,
    createdAt: overrides.createdAt ?? now,
    ...overrides
  }
}

function thread(activities: OrchestrationThreadActivity[]): OrchestrationThread {
  return {
    id: 'thread-1',
    title: 'Thread',
    cwd: '/tmp/project',
    branch: 'main',
    messages: [],
    activities,
    proposedPlans: [],
    todoLists: [],
    session: null,
    latestTurn: null,
    activeTurn: null,
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  }
}

describe('orchestrationThreadMerge', () => {
  it('does not overwrite a completed activity with a stale running update', () => {
    const completed = activity({
      kind: 'tool.completed',
      payload: { itemType: 'file_change', status: 'completed', fileEditChanges: [{ path: 'a.ts' }] }
    })
    const running = activity({
      kind: 'tool.updated',
      payload: { itemType: 'file_change', status: 'inProgress' },
      sequence: 2
    })

    expect(mergeThreadActivity(completed, running)).toMatchObject({
      kind: 'tool.completed',
      payload: expect.objectContaining({ status: 'completed', fileEditChanges: [{ path: 'a.ts' }] })
    })
  })

  it('keeps rich fields when a simple completed update arrives', () => {
    const richRunning = activity({
      payload: {
        itemType: 'file_change',
        status: 'inProgress',
        title: 'themes.ts',
        fileEditChanges: [{ path: 'themes.ts' }]
      }
    })
    const simpleCompleted = activity({
      kind: 'tool.completed',
      payload: { itemType: 'file_change', status: 'completed' },
      sequence: 2
    })

    expect(mergeThreadActivity(richRunning, simpleCompleted)).toMatchObject({
      kind: 'tool.completed',
      payload: expect.objectContaining({
        status: 'completed',
        title: 'themes.ts',
        fileEditChanges: [{ path: 'themes.ts' }]
      })
    })
  })

  it('preserves current live activities when snapshots omit them', () => {
    const live = activity()
    const merged = mergeThreadSnapshot(thread([live]), thread([]))
    expect(merged.activities).toEqual([live])
  })

  it('dedupes duplicate activities to the terminal rich version', () => {
    const running = activity({ payload: { itemType: 'file_change', status: 'inProgress' } })
    const completed = activity({
      kind: 'tool.completed',
      payload: { itemType: 'file_change', status: 'completed', title: 'Edited' }
    })

    const merged = mergeActivities([running], [completed, running])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      kind: 'tool.completed',
      payload: expect.objectContaining({ status: 'completed', title: 'Edited' })
    })
  })
})

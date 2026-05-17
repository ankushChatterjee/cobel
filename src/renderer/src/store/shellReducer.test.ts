import { describe, expect, it } from 'vitest'
import type { OrchestrationShellSnapshot, ProjectSummary, ThreadShellSummary } from '../../../shared/agent'
import {
  applyShellEvent,
  applyShellSnapshot,
  createShellState,
  selectProjects,
  selectThreadsForProject
} from './shellReducer'

const t0 = '2026-01-01T00:00:00.000Z'

function project(id: string): ProjectSummary {
  return { id, name: `Project ${id}`, path: `/tmp/${id}`, createdAt: t0, updatedAt: t0, archivedAt: null }
}

function thread(id: string, projectId: string): ThreadShellSummary {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    branch: 'main',
    latestTurnId: null,
    sessionStatus: 'idle',
    createdAt: t0,
    updatedAt: t0,
    archivedAt: null
  }
}

function snapshot(projects: ProjectSummary[], threads: ThreadShellSummary[]): OrchestrationShellSnapshot {
  return { projects, threads }
}

describe('shellReducer', () => {
  it('applyShellSnapshot populates normalized state', () => {
    const state = createShellState()
    const next = applyShellSnapshot(state, snapshot([project('p1')], [thread('t1', 'p1')]))
    expect(next.projectIds).toEqual(['p1'])
    expect(next.projectsById['p1']?.name).toBe('Project p1')
    expect(next.threadIds).toEqual(['t1'])
    expect(selectProjectsById(next, 'p1')).toBeDefined()
  })

  it('applyShellEvent shell.project-upserted adds new project', () => {
    const state = applyShellSnapshot(createShellState(), snapshot([], []))
    const next = applyShellEvent(state, { type: 'shell.project-upserted', project: project('p1') })
    expect(next.projectIds).toEqual(['p1'])
    expect(next.projectsById['p1']).toBeDefined()
  })

  it('applyShellEvent shell.project-removed removes project', () => {
    const state = applyShellSnapshot(createShellState(), snapshot([project('p1')], []))
    const next = applyShellEvent(state, { type: 'shell.project-removed', projectId: 'p1' })
    expect(next.projectIds).toEqual([])
    expect(next.projectsById['p1']).toBeUndefined()
  })

  it('applyShellEvent shell.thread-upserted adds thread', () => {
    const state = applyShellSnapshot(createShellState(), snapshot([project('p1')], []))
    const next = applyShellEvent(state, {
      type: 'shell.thread-upserted',
      thread: thread('t1', 'p1')
    })
    expect(next.threadIds).toEqual(['t1'])
    expect(next.threadsById['t1']).toBeDefined()
  })

  it('applyShellEvent shell.thread-removed removes thread', () => {
    const state = applyShellSnapshot(createShellState(), snapshot([project('p1')], [thread('t1', 'p1')]))
    const next = applyShellEvent(state, { type: 'shell.thread-removed', threadId: 't1' })
    expect(next.threadIds).toEqual([])
    expect(next.threadsById['t1']).toBeUndefined()
  })

  it('selectProjects returns projects in insertion order', () => {
    const state = applyShellSnapshot(
      createShellState(),
      snapshot([project('p1'), project('p2')], [])
    )
    expect(selectProjects(state).map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('selectThreadsForProject filters by projectId', () => {
    const state = applyShellSnapshot(
      createShellState(),
      snapshot([project('p1'), project('p2')], [thread('t1', 'p1'), thread('t2', 'p2'), thread('t3', 'p1')])
    )
    const threads = selectThreadsForProject(state, 'p1')
    expect(threads.map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('upserting the same project updates it without duplicating the id', () => {
    let state = applyShellSnapshot(createShellState(), snapshot([project('p1')], []))
    state = applyShellEvent(state, {
      type: 'shell.project-upserted',
      project: { ...project('p1'), name: 'Updated' }
    })
    expect(state.projectIds).toEqual(['p1'])
    expect(state.projectsById['p1']?.name).toBe('Updated')
  })
})

function selectProjectsById(state: ReturnType<typeof createShellState>, id: string) {
  return state.projectsById[id]
}

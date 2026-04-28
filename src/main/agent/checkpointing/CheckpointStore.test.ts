import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CheckpointStore } from './CheckpointStore'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('CheckpointStore', () => {
  it('captures, diffs, summarizes, and restores Git-backed checkpoints', async () => {
    const cwd = await createGitRepo()
    const store = new CheckpointStore()

    await writeFile(join(cwd, 'a.txt'), 'one\n')
    await git(cwd, ['add', 'a.txt'])
    await git(cwd, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'init'
    ])

    await store.captureCheckpoint(cwd, 'thread:test', 0)
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(cwd, 'b.txt'), 'new\n')
    await store.captureCheckpoint(cwd, 'thread:test', 1)

    await expect(store.hasCheckpoint(cwd, 'thread:test', 0)).resolves.toBe(true)
    const summary = await store.summarizeDiff(cwd, 'thread:test', 0, 1)
    expect(summary).toEqual([
      { path: 'a.txt', kind: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'b.txt', kind: 'added', additions: 1, deletions: 0, binary: false }
    ])

    const diff = await store.diffCheckpoints(cwd, 'thread:test', 0, 1)
    expect(diff.truncated).toBe(false)
    expect(diff.diff).toContain('+two')

    await store.restoreCheckpoint(cwd, 'thread:test', 0)
    await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('one\n')
    await expect(readFile(join(cwd, 'b.txt'), 'utf8')).rejects.toThrow()

    await writeFile(join(cwd, 'a.txt'), 'one\nlive\n')
    await writeFile(join(cwd, 'c.txt'), 'current\n')

    const worktreeDiff = await store.diffCheckpointToWorktree(cwd, 'thread:test', 0)
    expect(worktreeDiff.truncated).toBe(false)
    expect(worktreeDiff.files).toEqual([
      { path: 'a.txt', kind: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'c.txt', kind: 'added', additions: 1, deletions: 0, binary: false }
    ])
    expect(worktreeDiff.diff).toContain('+live')
    expect(worktreeDiff.diff).toContain('+current')

    const commitSha = await store.commitWorktree(cwd, 'commit review changes')
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/u)
    const status = await gitOutput(cwd, ['status', '--porcelain', '--untracked-files=all'])
    expect(status).toBe('')
    const subject = await gitOutput(cwd, ['log', '-1', '--format=%s'])
    expect(subject).toBe('commit review changes')

    await store.captureCheckpoint(cwd, 'thread:test', 0)
    const clearedDiff = await store.diffCheckpointToWorktree(cwd, 'thread:test', 0)
    expect(clearedDiff.files).toEqual([])
    expect(clearedDiff.diff).toBe('')
  })

  it('diffs the current workspace against the current index state', async () => {
    const cwd = await createGitRepo()
    const store = new CheckpointStore()

    await writeFile(join(cwd, 'tracked.txt'), 'base\n')
    await git(cwd, ['add', 'tracked.txt'])
    await git(cwd, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'init'
    ])

    await store.captureCheckpoint(cwd, 'thread:test', 0)
    await writeFile(join(cwd, 'tracked.txt'), 'base\nunstaged\n')
    await writeFile(join(cwd, 'new.txt'), 'untracked\n')
    await writeFile(join(cwd, 'staged-only.txt'), 'staged\n')
    await git(cwd, ['add', 'staged-only.txt'])

    const diff = await store.diffWorkspace(cwd)
    expect(diff.truncated).toBe(false)
    expect(diff.files).toEqual([
      { path: 'new.txt', kind: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'tracked.txt', kind: 'modified', additions: 1, deletions: 0, binary: false }
    ])
    expect(diff.diff).toContain('+++ b/new.txt')
    expect(diff.diff).toContain('+unstaged')
    expect(diff.diff).not.toContain('staged-only.txt')

    await git(cwd, ['add', 'tracked.txt', 'new.txt'])
    const cleared = await store.diffWorkspace(cwd)
    expect(cleared.files).toEqual([])
    expect(cleared.diff).toBe('')
  })
})

async function createGitRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'cobel-checkpoint-test-'))
  tempDirs.push(cwd)
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.name', 'Test'])
  await git(cwd, ['config', 'user.email', 'test@example.invalid'])
  return cwd
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd })
  return result.stdout.trim()
}

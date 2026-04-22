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
  })
})

async function createGitRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'cobel-checkpoint-test-'))
  tempDirs.push(cwd)
  await git(cwd, ['init'])
  return cwd
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

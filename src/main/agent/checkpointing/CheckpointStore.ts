import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CheckpointFileChange } from '../../../shared/agent'

const execFileAsync = promisify(execFile)
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000
const TRUNCATED_DIFF_SENTINEL = '\n\n[diff output truncated]\n'

export class CheckpointStore {
  async isGitRepository(cwd: string): Promise<boolean> {
    const result = await this.git(cwd, ['rev-parse', '--is-inside-work-tree'], {
      allowNonZeroExit: true
    })
    return result.code === 0 && result.stdout.trim() === 'true'
  }

  checkpointRef(threadId: string, turnCount: number): string {
    if (!Number.isInteger(turnCount) || turnCount < 0) {
      throw new Error('checkpoint turn count must be a non-negative integer.')
    }
    return `refs/cobel/checkpoints/${safeRefSegment(threadId)}/${turnCount}`
  }

  async hasCheckpoint(cwd: string, threadId: string, turnCount: number): Promise<boolean> {
    const commit = await this.resolveCheckpointCommit(cwd, threadId, turnCount)
    return Boolean(commit)
  }

  async captureCheckpoint(cwd: string, threadId: string, turnCount: number): Promise<void> {
    const ref = this.checkpointRef(threadId, turnCount)
    const commitOid = await this.captureWorktreeCommit(cwd, `cobel checkpoint ${turnCount}`)
    await this.git(cwd, ['update-ref', ref, commitOid])
  }

  async diffCheckpointToWorktree(
    cwd: string,
    threadId: string,
    fromTurnCount: number
  ): Promise<{ diff: string; files: CheckpointFileChange[]; truncated: boolean }> {
    const fromCommit = await this.requireCheckpointCommit(cwd, threadId, fromTurnCount)
    const worktreeCommit = await this.captureWorktreeCommit(
      cwd,
      `cobel worktree snapshot from ${fromTurnCount}`
    )
    const [diff, files] = await Promise.all([
      this.diffCommits(cwd, fromCommit, worktreeCommit),
      this.summarizeCommits(cwd, fromCommit, worktreeCommit)
    ])
    return { ...diff, files }
  }

  private async captureWorktreeCommit(cwd: string, message: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'cobel-checkpoint-'))
    const tempIndexPath = join(tempDir, `index-${randomUUID()}`)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
      GIT_AUTHOR_NAME: 'Cobel',
      GIT_AUTHOR_EMAIL: 'cobel@example.invalid',
      GIT_COMMITTER_NAME: 'Cobel',
      GIT_COMMITTER_EMAIL: 'cobel@example.invalid'
    }

    try {
      if (await this.hasHeadCommit(cwd)) {
        await this.git(cwd, ['read-tree', 'HEAD'], { env })
      }
      await this.git(cwd, ['add', '-A', '--', '.'], { env })
      const treeOid = (await this.git(cwd, ['write-tree'], { env })).stdout.trim()
      if (!treeOid) throw new Error('git write-tree returned an empty tree oid.')
      const commitOid = (
        await this.git(cwd, ['commit-tree', treeOid, '-m', message], {
          env
        })
      ).stdout.trim()
      if (!commitOid) throw new Error('git commit-tree returned an empty commit oid.')
      return commitOid
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async diffCheckpoints(
    cwd: string,
    threadId: string,
    fromTurnCount: number,
    toTurnCount: number
  ): Promise<{ diff: string; truncated: boolean }> {
    const fromCommit = await this.requireCheckpointCommit(cwd, threadId, fromTurnCount)
    const toCommit = await this.requireCheckpointCommit(cwd, threadId, toTurnCount)
    return this.diffCommits(cwd, fromCommit, toCommit)
  }

  async summarizeDiff(
    cwd: string,
    threadId: string,
    fromTurnCount: number,
    toTurnCount: number
  ): Promise<CheckpointFileChange[]> {
    const fromCommit = await this.requireCheckpointCommit(cwd, threadId, fromTurnCount)
    const toCommit = await this.requireCheckpointCommit(cwd, threadId, toTurnCount)
    return this.summarizeCommits(cwd, fromCommit, toCommit)
  }

  private async diffCommits(
    cwd: string,
    fromCommit: string,
    toCommit: string
  ): Promise<{ diff: string; truncated: boolean }> {
    const result = await this.git(
      cwd,
      ['diff', '--patch', '--minimal', '--find-renames', '--no-color', fromCommit, toCommit],
      { maxBuffer: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES + TRUNCATED_DIFF_SENTINEL.length }
    )
    const truncated = Buffer.byteLength(result.stdout, 'utf8') > CHECKPOINT_DIFF_MAX_OUTPUT_BYTES
    return {
      diff: truncated
        ? `${result.stdout.slice(0, CHECKPOINT_DIFF_MAX_OUTPUT_BYTES)}${TRUNCATED_DIFF_SENTINEL}`
        : result.stdout,
      truncated
    }
  }

  private async summarizeCommits(
    cwd: string,
    fromCommit: string,
    toCommit: string
  ): Promise<CheckpointFileChange[]> {
    const [nameStatus, numStat] = await Promise.all([
      this.git(cwd, [
        'diff',
        '--name-status',
        '--find-renames',
        '--no-color',
        fromCommit,
        toCommit
      ]),
      this.git(cwd, ['diff', '--numstat', '--find-renames', '--no-color', fromCommit, toCommit])
    ])
    const statsByPath = parseNumstat(numStat.stdout)
    return parseNameStatus(nameStatus.stdout).map((file) => ({
      ...file,
      ...(statsByPath.get(file.path) ?? { additions: 0, deletions: 0, binary: false })
    }))
  }

  async restoreCheckpoint(cwd: string, threadId: string, turnCount: number): Promise<void> {
    const commit = await this.requireCheckpointCommit(cwd, threadId, turnCount)
    await this.git(cwd, ['restore', '--source', commit, '--worktree', '--staged', '--', '.'])
    await this.git(cwd, ['clean', '-fd', '--', '.'])
    if (await this.hasHeadCommit(cwd)) {
      await this.git(cwd, ['reset', '--quiet', '--', '.'])
    }
  }

  async commitWorktree(cwd: string, message: string): Promise<string> {
    const trimmedMessage = message.trim()
    if (!trimmedMessage) throw new Error('Commit message is required.')
    const status = await this.git(cwd, ['status', '--porcelain', '--untracked-files=all'])
    if (!status.stdout.trim()) throw new Error('There are no worktree changes to commit.')

    await this.git(cwd, ['add', '-A', '--', '.'])
    const staged = await this.git(cwd, ['diff', '--cached', '--quiet', '--exit-code'], {
      allowNonZeroExit: true
    })
    if (staged.code === 0) throw new Error('There are no staged changes to commit.')

    await this.git(cwd, ['commit', '-m', trimmedMessage])
    return (await this.git(cwd, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  }

  async deleteCheckpointsNewerThan(
    cwd: string,
    threadId: string,
    turnCount: number
  ): Promise<void> {
    const prefix = `refs/cobel/checkpoints/${safeRefSegment(threadId)}/`
    const refs = await this.git(cwd, ['for-each-ref', '--format=%(refname)', prefix], {
      allowNonZeroExit: true
    })
    const toDelete = refs.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((ref) => {
        const rawCount = Number(ref.slice(prefix.length))
        return Number.isInteger(rawCount) && rawCount > turnCount
      })
    await Promise.all(toDelete.map((ref) => this.git(cwd, ['update-ref', '-d', ref])))
  }

  private async resolveCheckpointCommit(
    cwd: string,
    threadId: string,
    turnCount: number
  ): Promise<string | null> {
    const ref = this.checkpointRef(threadId, turnCount)
    const result = await this.git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      allowNonZeroExit: true
    })
    if (result.code !== 0) return null
    const commit = result.stdout.trim()
    return commit.length > 0 ? commit : null
  }

  private async requireCheckpointCommit(
    cwd: string,
    threadId: string,
    turnCount: number
  ): Promise<string> {
    const commit = await this.resolveCheckpointCommit(cwd, threadId, turnCount)
    if (!commit) {
      throw new Error(`Filesystem checkpoint is unavailable for turn ${turnCount}.`)
    }
    return commit
  }

  private async hasHeadCommit(cwd: string): Promise<boolean> {
    const result = await this.git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      allowNonZeroExit: true
    })
    return result.code === 0 && result.stdout.trim().length > 0
  }

  private async git(
    cwd: string,
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv
      allowNonZeroExit?: boolean
      maxBuffer?: number
    } = {}
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        env: options.env,
        maxBuffer: options.maxBuffer ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES + 1024 * 1024
      })
      return { stdout: result.stdout, stderr: result.stderr, code: 0 }
    } catch (error) {
      const maybeError = error as {
        stdout?: string
        stderr?: string
        code?: number
        message?: string
      }
      if (options.allowNonZeroExit) {
        return {
          stdout: maybeError.stdout ?? '',
          stderr: maybeError.stderr ?? '',
          code: typeof maybeError.code === 'number' ? maybeError.code : 1
        }
      }
      const detail = maybeError.stderr?.trim() || maybeError.message || 'git command failed'
      throw new Error(`git ${args.join(' ')} failed: ${detail}`)
    }
  }
}

function parseNameStatus(
  output: string
): Array<Omit<CheckpointFileChange, 'additions' | 'deletions'>> {
  const files: Array<Omit<CheckpointFileChange, 'additions' | 'deletions'>> = []
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const columns = line.split('\t')
    const status = columns[0] ?? ''
    if (status.startsWith('R')) {
      const oldPath = columns[1]
      const path = columns[2]
      if (oldPath && path) files.push({ path, oldPath, kind: 'renamed' })
      continue
    }
    const path = columns[1]
    if (!path) continue
    if (status === 'A') files.push({ path, kind: 'added' })
    else if (status === 'D') files.push({ path, kind: 'deleted' })
    else files.push({ path, kind: 'modified' })
  }
  return files
}

function parseNumstat(
  output: string
): Map<string, Pick<CheckpointFileChange, 'additions' | 'deletions' | 'binary'>> {
  const stats = new Map<string, Pick<CheckpointFileChange, 'additions' | 'deletions' | 'binary'>>()
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const columns = line.split('\t')
    const additions = parseStat(columns[0])
    const deletions = parseStat(columns[1])
    const binary = columns[0] === '-' || columns[1] === '-'
    const path = columns.length >= 4 ? columns[3] : columns[2]
    if (!path) continue
    stats.set(path, { additions, deletions, binary })
  }
  return stats
}

function parseStat(value: string | undefined): number {
  if (!value || value === '-') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function safeRefSegment(value: string): string {
  return Buffer.from(value).toString('base64url')
}

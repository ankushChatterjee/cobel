import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const cwd = process.cwd()
const isWindows = process.platform === 'win32'
const bunCommand = isWindows ? 'bun.cmd' : 'bun'
const binDir = path.join(cwd, 'node_modules', '.bin')

function localBin(name) {
  return path.join(binDir, isWindows ? `${name}.cmd` : name)
}

function runSetup() {
  const result = spawnSync(bunCommand, ['run', 'rebuild:electron'], {
    cwd,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function startProcess(command, args, label) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit'
  })

  child.on('error', (error) => {
    console.error(`[${label}] failed to start`, error)
    shutdown(1)
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (signal) {
      console.error(`[${label}] exited with signal ${signal}`)
      shutdown(1)
      return
    }
    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`)
      shutdown(code ?? 1)
      return
    }
    if (label === 'electron-vite') {
      shutdown(0)
    }
  })

  return child
}

const processes = []
let shuttingDown = false

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of processes) {
    if (!child.killed) child.kill('SIGTERM')
  }

  setTimeout(() => {
    for (const child of processes) {
      if (!child.killed) child.kill('SIGKILL')
    }
    process.exit(exitCode)
  }, 250)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

runSetup()

processes.push(
  startProcess(localBin('tsc'), ['--noEmit', '-p', 'tsconfig.node.json', '--composite', 'false', '--watch'], 'typecheck:node'),
  startProcess(localBin('tsc'), ['--noEmit', '-p', 'tsconfig.web.json', '--composite', 'false', '--watch'], 'typecheck:web'),
  startProcess(localBin('electron-vite'), ['dev'], 'electron-vite')
)

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import * as FS from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import * as OS from 'node:os'
import * as Path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  Agent,
  FilePartInput,
  Model,
  OpencodeClient,
  PermissionAction,
  PermissionRule,
  PermissionRuleset,
  Provider,
  ProviderListResponse,
  QuestionAnswer,
  QuestionRequest
} from '@opencode-ai/sdk/v2'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  ChatAttachment,
  ModelInfo,
  ProviderApprovalDecision,
  ReasoningEffort,
  RuntimeMode
} from '../../../../shared/agent'

const OPENCODE_SERVER_READY_PREFIX = 'opencode server listening'
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000
const DEFAULT_HOSTNAME = '127.0.0.1'

export interface OpenCodeServerProcess {
  readonly url: string
  readonly process: ChildProcess
  close(): void
}

export interface OpenCodeServerConnection {
  readonly url: string
  readonly process: ChildProcess | null
  readonly external: boolean
  close(): void
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse
  /**
   * From `client.config.providers()` (see `@opencode-ai/sdk` / opencode-sdk-js `Config.providers`).
   * Configured providers often include `Model.variants` that the live `/provider` list omits.
   */
  readonly configProviders?: ReadonlyArray<Provider>
  readonly agents: ReadonlyArray<Agent>
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string
  readonly modelID: string
}

function buildOpenCodeBasicAuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split('\n')) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
    return match?.[1] ?? null
  }
  return null
}

/**
 * Provider directory persistence uses the same `{ threadId }` shape as Codex: here `threadId` is the
 * OpenCode server session id (`sessionID`) returned from `session.create` / `session.get`.
 */
export function readOpencodeResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== 'object') return undefined
  const id = (resumeCursor as { threadId?: unknown }).threadId
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined
}

export function parseOpenCodeModelSlug(slug: string | null | undefined): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== 'string') {
    return null
  }
  const trimmed = slug.trim()
  const separator = trimmed.indexOf('/')
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null
  }
  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1)
  }
}

export function toOpenCodeModelSlug(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest['questions'][number]
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = []
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment)
    if (!attachmentPath) continue
    parts.push({
      type: 'file',
      mime: attachment.type === 'image' ? 'image/*' : 'application/octet-stream',
      filename: Path.basename(attachmentPath),
      url: pathToFileURL(attachmentPath).href
    })
  }
  return parts
}

/**
 * `PermissionRule.permission` values — must match `PermissionConfig` in `@opencode-ai/sdk/v2`
 * (see opencode.ai/docs/permissions). All lowercase; multi-word guards use `snake_case`.
 * OpenCode applies the **last** matching rule, so the `*` default comes first, then overrides.
 */
const OPENCODE_PERM = {
  wildcard: '*',
  bash: 'bash',
  read: 'read',
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
  list: 'list',
  lsp: 'lsp',
  question: 'question',
  webfetch: 'webfetch',
  websearch: 'websearch',
  codesearch: 'codesearch',
  task: 'task',
  skill: 'skill',
  external_directory: 'external_directory',
  doom_loop: 'doom_loop',
  todowrite: 'todowrite'
} as const

type OpenCodePermissionKey = (typeof OPENCODE_PERM)[keyof typeof OPENCODE_PERM]

function openCodePermissionRule(permission: OpenCodePermissionKey, action: PermissionAction): PermissionRule {
  return { permission, pattern: '*', action }
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  switch (runtimeMode) {
    case 'full-access':
      return [openCodePermissionRule(OPENCODE_PERM.wildcard, 'allow')]
    case 'auto-accept-edits':
      return [
        openCodePermissionRule(OPENCODE_PERM.wildcard, 'ask'),
        openCodePermissionRule(OPENCODE_PERM.question, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.todowrite, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.read, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.glob, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.grep, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.list, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.lsp, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.edit, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.websearch, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.webfetch, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.codesearch, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.task, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.skill, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.bash, 'ask'),
        openCodePermissionRule(OPENCODE_PERM.external_directory, 'ask'),
        openCodePermissionRule(OPENCODE_PERM.doom_loop, 'ask')
      ]
    case 'approval-required':
      return [
        openCodePermissionRule(OPENCODE_PERM.wildcard, 'ask'),
        openCodePermissionRule(OPENCODE_PERM.question, 'allow'),
        openCodePermissionRule(OPENCODE_PERM.todowrite, 'allow')
      ]
    default: {
      const _exhaustive: never = runtimeMode
      return _exhaustive
    }
  }
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision
): 'once' | 'always' | 'reject' {
  switch (decision) {
    case 'accept':
      return 'once'
    case 'acceptForSession':
      return 'always'
    case 'decline':
    case 'cancel':
    default:
      return 'reject'
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question]
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === 'string')
    }
    if (typeof raw === 'string') {
      return raw.trim().length > 0 ? [raw] : []
    }
    return []
  })
}

export async function findAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, DEFAULT_HOSTNAME, () => resolve())
  })
  const address = server.address() as AddressInfo
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

export function resolveOpenCodeBinaryPath(binaryPath: string): string {
  const trimmed = binaryPath.trim()
  if (!trimmed) {
    throw new Error('OpenCode CLI path is empty.')
  }
  for (const candidate of openCodeBinaryCandidates(trimmed)) {
    if (isExecutableBinary(candidate)) return candidate
  }
  const searchLabel =
    trimmed.includes(Path.sep) || trimmed.includes('\\')
      ? trimmed
      : `${trimmed} (PATH + common install locations)`
  throw new Error(`OpenCode CLI was not found: ${searchLabel}`)
}

export function detectMacosSigkillHint(binaryPath: string): string | null {
  try {
    const resolvedPath = resolveOpenCodeBinaryPath(binaryPath)
    const xattr = execFileSync('xattr', ['-l', resolvedPath], {
      encoding: 'utf8',
      timeout: 3_000
    })
    if (xattr.includes('com.apple.quarantine')) {
      return `macOS quarantine is blocking the OpenCode binary. Run: xattr -d com.apple.quarantine ${resolvedPath}`
    }
    const crashDir = Path.join(OS.homedir(), 'Library/Logs/DiagnosticReports')
    const binaryName = Path.basename(resolvedPath)
    let recentReports: string[] = []
    try {
      recentReports = FS.readdirSync(crashDir)
        .filter((f) => f.startsWith(binaryName) && f.endsWith('.ips'))
        .sort()
        .reverse()
        .slice(0, 1)
    } catch {
      return null
    }
    for (const report of recentReports) {
      const content = FS.readFileSync(Path.join(crashDir, report), 'utf8')
      if (content.includes('"namespace":"CODESIGNING"')) {
        return 'macOS killed the process due to an invalid code signature. Try reinstalling OpenCode.'
      }
    }
  } catch {
    // best-effort
  }
  return null
}

export async function startOpenCodeServerProcess(input: {
  readonly binaryPath: string
  readonly port?: number
  readonly hostname?: string
  readonly timeoutMs?: number
}): Promise<OpenCodeServerProcess> {
  const hostname = input.hostname ?? DEFAULT_HOSTNAME
  const port = input.port ?? (await findAvailablePort())
  const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS
  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`]
  const child = spawn(input.binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({})
    }
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stdout = ''
  let stderr = ''
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    child.kill()
  }

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      close()
      reject(new Error(`Timed out waiting for OpenCode server start after ${timeoutMs}ms.`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
    }

    const onStdout = (chunk: string) => {
      stdout += chunk
      const parsed = parseServerUrlFromOutput(stdout)
      if (!parsed) return
      cleanup()
      resolve(parsed)
    }

    const onStderr = (chunk: string) => {
      stderr += chunk
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      const exitReason = signal ? `signal: ${signal}` : `code: ${code ?? 'unknown'}`
      const hint =
        signal === 'SIGKILL' && process.platform === 'darwin'
          ? detectMacosSigkillHint(input.binaryPath)
          : null
      reject(
        new Error(
          [
            `OpenCode server exited before startup completed (${exitReason}).`,
            hint,
            stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
            stderr.trim() ? `stderr:\n${stderr.trim()}` : null
          ]
            .filter(Boolean)
            .join('\n\n')
        )
      )
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
  })

  return {
    url,
    process: child,
    close
  }
}

export interface OpenCodeCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export async function runOpenCodeCommand(input: {
  readonly binaryPath: string
  readonly args: ReadonlyArray<string>
}): Promise<OpenCodeCommandResult> {
  const child = spawn(input.binaryPath, [...input.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  const stdoutChunks: Array<string> = []
  const stderrChunks: Array<string> = []

  child.stdout?.on('data', (chunk: string) => stdoutChunks.push(chunk))
  child.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk))

  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode) => resolve(exitCode ?? 0))
  })

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    code
  }
}

export async function connectToOpenCodeServer(input: {
  readonly binaryPath: string
  readonly serverUrl?: string | null
  readonly port?: number
  readonly hostname?: string
  readonly timeoutMs?: number
}): Promise<OpenCodeServerConnection> {
  const serverUrl = input.serverUrl?.trim()
  if (serverUrl) {
    return {
      url: serverUrl,
      process: null,
      external: true,
      close() {}
    }
  }
  const server = await startOpenCodeServerProcess({
    binaryPath: input.binaryPath,
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
  })
  return {
    url: server.url,
    process: server.process,
    external: false,
    close: () => server.close()
  }
}

export function createOpenCodeSdkClient(input: {
  readonly baseUrl: string
  readonly directory: string
  readonly serverPassword?: string
}): OpencodeClient {
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    directory: input.directory,
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: buildOpenCodeBasicAuthorizationHeader(input.serverPassword)
          }
        }
      : {}),
    throwOnError: true
  })
}

export async function loadOpenCodeInventory(client: OpencodeClient): Promise<OpenCodeInventory> {
  const [providerListResult, configProvidersResult, agentsResult] = await Promise.all([
    client.provider.list(),
    client.config.providers(),
    client.app.agents()
  ])
  if (!providerListResult.data) {
    throw new Error('OpenCode provider inventory was empty.')
  }
  const configProviders = configProvidersResult.data?.providers
  return {
    providerList: providerListResult.data,
    ...(configProviders && configProviders.length > 0 ? { configProviders } : {}),
    agents: agentsResult.data ?? []
  }
}

/** Prefer config-sourced `Model` (richer `variants`) over `/provider` list entries. */
export function mergeOpenCodeModelDefinition(
  providerId: string,
  modelId: string,
  providerList: ProviderListResponse,
  configProviders: ReadonlyArray<Provider> | undefined
): Model {
  const listProv = providerList.all.find((p) => p.id === providerId)
  const listModel = listProv?.models[modelId]
  const cfgProv = configProviders?.find((p) => p.id === providerId)
  const cfgModel = cfgProv?.models[modelId]
  if (!listModel && !cfgModel) {
    throw new Error(`OpenCode: missing model definition for ${providerId}/${modelId}`)
  }
  if (!cfgModel) return listModel as Model
  if (!listModel) return cfgModel
  return { ...listModel, ...cfgModel }
}

const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
  'xhigh'
]

function isReasoningEffortString(value: string): value is ReasoningEffort {
  return (REASONING_EFFORT_ORDER as readonly string[]).includes(value)
}

/**
 * Map an OpenCode `Model.variants` **key** to composer `ReasoningEffort` (normalized lowercase).
 * The original key string is passed to the SDK as `variant` via `openCodeVariantByEffort`.
 */
function variantKeyToEffort(key: string): ReasoningEffort | null {
  const k = key.trim().toLowerCase()
  return isReasoningEffortString(k) ? k : null
}

function findVariantEntryKey(
  variants: Record<string, unknown>,
  needle: string
): string | null {
  if (Object.prototype.hasOwnProperty.call(variants, needle)) return needle
  const lower = needle.trim().toLowerCase()
  for (const k of Object.keys(variants)) {
    if (k.trim().toLowerCase() === lower) return k
  }
  return null
}

function readDefaultVariantKey(model: Model): string | null {
  const o = model.options
  if (!o || typeof o !== 'object') return null
  const od = o as Record<string, unknown>
  const v = od.defaultVariant ?? od.default_variant ?? od.variant
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/**
 * Derive composer reasoning options **only** from `Model.variants` **keys** (insertion order).
 * Nested `reasoningEffort` on variant values is ignored — the map key is both UI effort and wire `variant`.
 */
export function openCodeSdkModelToEffortFields(model: Model): {
  supportedReasoningEfforts?: NonNullable<ModelInfo['supportedReasoningEfforts']>
  defaultReasoningEffort?: ReasoningEffort
  openCodeVariantByEffort?: Partial<Record<ReasoningEffort, string>>
} {
  const openCodeVariantByEffort: Partial<Record<ReasoningEffort, string>> = {}
  const effortKeys = new Map<ReasoningEffort, string>()
  const orderedEfforts: ReasoningEffort[] = []

  const variants = model.variants
  if (variants && typeof variants === 'object') {
    const variantRecord = variants as Record<string, unknown>
    for (const variantKey of Object.keys(variantRecord)) {
      const effort = variantKeyToEffort(variantKey)
      if (!effort) continue
      if (!effortKeys.has(effort)) {
        effortKeys.set(effort, variantKey)
        openCodeVariantByEffort[effort] = variantKey
        orderedEfforts.push(effort)
      }
    }
  }

  if (effortKeys.size === 0) {
    return {}
  }

  const supportedReasoningEfforts = orderedEfforts.map((reasoningEffort) => ({ reasoningEffort }))
  const defaultKey = readDefaultVariantKey(model)
  let defaultReasoningEffort: ReasoningEffort =
    supportedReasoningEfforts[0]?.reasoningEffort ?? 'medium'
  if (defaultKey && variants && typeof variants === 'object') {
    const matched = findVariantEntryKey(variants as Record<string, unknown>, defaultKey)
    if (matched) {
      const resolved = variantKeyToEffort(matched)
      if (resolved && effortKeys.has(resolved)) {
        defaultReasoningEffort = resolved
      }
    }
  }
  return { supportedReasoningEfforts, defaultReasoningEffort, openCodeVariantByEffort }
}

export function inventoryToModelInfos(inventory: OpenCodeInventory): ModelInfo[] {
  const connected = new Set(inventory.providerList.connected)
  const models: ModelInfo[] = []
  for (const provider of inventory.providerList.all) {
    if (!connected.has(provider.id)) continue
    for (const model of Object.values(provider.models)) {
      const slug = toOpenCodeModelSlug(provider.id, model.id)
      const merged = mergeOpenCodeModelDefinition(
        provider.id,
        model.id,
        inventory.providerList,
        inventory.configProviders
      )
      const effortFields = openCodeSdkModelToEffortFields(merged)
      models.push({
        id: slug,
        name: `${provider.name} · ${merged.name}`,
        providerId: 'opencode',
        upstreamVendor: provider.id,
        description: merged.id,
        ...(effortFields.supportedReasoningEfforts
          ? { supportedReasoningEfforts: effortFields.supportedReasoningEfforts }
          : {}),
        ...(effortFields.defaultReasoningEffort
          ? { defaultReasoningEffort: effortFields.defaultReasoningEffort }
          : {}),
        ...(effortFields.openCodeVariantByEffort &&
        Object.keys(effortFields.openCodeVariantByEffort).length > 0
          ? { openCodeVariantByEffort: effortFields.openCodeVariantByEffort }
          : {})
      })
    }
  }
  return models.toSorted((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1
  }
  return index
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length)
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length
    }
  }
  return 0
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText
  }
  return nextText
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string
): {
  readonly latestText: string
  readonly deltaToEmit: string
} {
  const latestText = resolveLatestAssistantText(previousText, nextText)
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? '', latestText))
  }
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string
): {
  readonly nextText: string
  readonly deltaToEmit: string
} {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta))
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit
  }
}

export interface OpenCodeEnvConfig {
  binaryPath: string
  serverUrl: string
  serverPassword: string
}

export function readOpenCodeConfigFromEnv(): OpenCodeEnvConfig {
  return {
    binaryPath: (process.env.OPENCODE_BINARY_PATH ?? 'opencode').trim() || 'opencode',
    serverUrl: (process.env.OPENCODE_SERVER_URL ?? '').trim(),
    serverPassword: (process.env.OPENCODE_SERVER_PASSWORD ?? '').trim()
  }
}

function openCodeBinaryCandidates(binaryPath: string): string[] {
  const candidates = new Set<string>()
  const add = (candidate: string | null | undefined): void => {
    const trimmed = candidate?.trim()
    if (!trimmed) return
    candidates.add(trimmed)
  }

  if (Path.isAbsolute(binaryPath)) {
    add(binaryPath)
    return [...candidates]
  }

  if (binaryPath.includes('/') || binaryPath.includes('\\')) {
    add(Path.resolve(binaryPath))
  }

  for (const entry of (process.env.PATH ?? '').split(Path.delimiter)) {
    if (!entry) continue
    add(Path.join(entry, binaryPath))
  }

  const home = OS.homedir()
  const commonDirs =
    process.platform === 'win32'
      ? [
          Path.join(home, 'AppData', 'Local', 'Programs', 'opencode'),
          Path.join(home, 'AppData', 'Roaming', 'npm'),
          Path.join(home, '.bun', 'bin')
        ]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
        '/usr/bin',
        '/bin',
        Path.join(home, '.local', 'bin'),
        Path.join(home, '.opencode', 'bin'),
        Path.join(home, 'bin'),
        Path.join(home, '.bun', 'bin'),
        Path.join(home, 'Library', 'pnpm'),
          Path.join(home, '.npm-global', 'bin')
        ]

  for (const dir of commonDirs) {
    add(Path.join(dir, binaryPath))
  }

  if (process.platform === 'win32' && Path.extname(binaryPath) === '') {
    for (const candidate of [...candidates]) {
      add(`${candidate}.exe`)
      add(`${candidate}.cmd`)
      add(`${candidate}.bat`)
    }
  }

  return [...candidates]
}

function isExecutableBinary(candidate: string): boolean {
  try {
    const stat = FS.statSync(candidate)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    FS.accessSync(candidate, FS.constants.X_OK)
    return true
  } catch {
    return false
  }
}

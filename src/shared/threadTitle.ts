export const DEFAULT_THREAD_TITLE = 'New thread'
const MAX_THREAD_TITLE_LENGTH = 50

export const THREAD_TITLE_SYSTEM_PROMPT = `You write concise thread titles for coding conversations.
Use this:

Return only a JSON object with this shape:
{"title":"<thread title>"}

Rules:
- The title should summarize the user's request, not restate it verbatim.
- Keep it short and specific, ideally 3-8 words.
- Use plain language.
- DO NOT USE quotes, filler words, prefixes, markdown, and trailing punctuation.
- Do not include file paths unless the path is the main subject of the request.
- Do not include implementation details that are not present in the user's message.
- If the request is vague, name the likely task category rather than inventing specifics.`

export const THREAD_TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }
  },
  required: ['title'],
  additionalProperties: false
} as const

export function sanitizeThreadTitle(title: string): string {
  const firstLine = title.trim().split(/\r?\n/u)[0]?.trim() ?? ''
  const unwrapped = firstLine.replace(/^['"`]+|['"`]+$/gu, '')
  const collapsed = unwrapped.replace(/\s+/gu, ' ').replace(/[.!?]+$/u, '').trim()
  if (!collapsed) return DEFAULT_THREAD_TITLE
  if (collapsed.length <= MAX_THREAD_TITLE_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_THREAD_TITLE_LENGTH - 3).trimEnd()}...`
}

export function deriveTitleSeed(input: string): string {
  const firstLine = input.trim().split(/\r?\n/u)[0] ?? ''
  return sanitizeThreadTitle(firstLine)
}

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const normalizedCurrentTitle = sanitizeThreadTitle(currentTitle)
  if (normalizedCurrentTitle === DEFAULT_THREAD_TITLE) return true
  if (typeof titleSeed !== 'string') return false
  const normalizedSeed = sanitizeThreadTitle(titleSeed)
  return normalizedSeed.length > 0 && normalizedCurrentTitle === normalizedSeed
}

export function buildThreadTitlePrompt(userMessage: string): string {
  return `${THREAD_TITLE_SYSTEM_PROMPT}

User message:
${userMessage.trim()}`
}

export function parseThreadTitleResponse(response: string): string | null {
  const parsed = tryParseTitleJson(response)
  if (!parsed) return null
  return sanitizeThreadTitle(parsed.title)
}

function tryParseTitleJson(response: string): { title: string } | null {
  const trimmed = response.trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim()
  if (fenced) candidates.push(fenced)
  const objectMatch = trimmed.match(/\{[\s\S]*\}/u)?.[0]
  if (objectMatch) candidates.push(objectMatch)

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { title?: unknown }).title === 'string'
      ) {
        return { title: (parsed as { title: string }).title }
      }
    } catch {
      // Keep trying less strict candidates.
    }
  }

  return null
}

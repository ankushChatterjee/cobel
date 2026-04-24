import { describe, expect, it } from 'vitest'
import {
  buildThreadTitlePrompt,
  parseThreadTitleResponse,
  THREAD_TITLE_OUTPUT_SCHEMA,
  THREAD_TITLE_SYSTEM_PROMPT
} from '../../shared/threadTitle'

describe('thread title prompt', () => {
  it('uses the configured title-writing instructions', () => {
    expect(THREAD_TITLE_SYSTEM_PROMPT).toContain(
      'You write concise thread titles for coding conversations.'
    )
    expect(THREAD_TITLE_SYSTEM_PROMPT).toContain('Return only a JSON object')
    expect(buildThreadTitlePrompt('Fix the sidebar')).toContain('User message:\nFix the sidebar')
  })

  it('defines the structured output schema expected from capable providers', () => {
    expect(THREAD_TITLE_OUTPUT_SCHEMA).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' }
      },
      required: ['title'],
      additionalProperties: false
    })
  })

  it('parses and sanitizes the JSON title response', () => {
    expect(parseThreadTitleResponse('{"title":"Fix Sidebar."}')).toBe('Fix Sidebar')
    expect(parseThreadTitleResponse('```json\n{"title":"Provider Layer"}\n```')).toBe(
      'Provider Layer'
    )
    expect(parseThreadTitleResponse('Fix Sidebar')).toBeNull()
  })
})

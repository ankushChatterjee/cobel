import { memo, useDeferredValue, useMemo, useState, useEffect, useRef } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/hljs/diff'
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json'
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python'
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust'
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript'
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml'
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml'
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs'
import { languageFromClassName, normalizeHighlightLanguage, inferCodeLanguage } from './formatUtils'
import { normalizeGfmTableDelimiters } from './markdownNormalize'

SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('diff', diff)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('xml', xml)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)

const markdownRemarkPlugins = [remarkGfm]

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  isStreaming
}: {
  text: string
  isStreaming: boolean
}): React.JSX.Element {
  const normalizedText = useMemo(() => normalizeGfmTableDelimiters(text), [text])
  const deferredText = useDeferredValue(normalizedText)
  const components = useMemo<Components>(
    () => ({
      a({ children, href }) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      },
      table({ children }) {
        return (
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        )
      },
      code({ children, className }) {
        const code = String(children).replace(/\n$/u, '')
        const language = languageFromClassName(className)
        const isBlock = Boolean(language) || code.includes('\n')
        if (!isBlock) return <code className="markdown-inline-code">{children}</code>
        return <CodeBlock code={code} language={language} isStreaming={isStreaming} />
      },
      pre({ children }) {
        return <>{children}</>
      }
    }),
    [isStreaming]
  )

  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={components}>
        {deferredText}
      </ReactMarkdown>
    </div>
  )
})

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  isStreaming
}: {
  code: string
  language: string | null
  isStreaming: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    }
  }, [])

  function copyCode(): void {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1200)
    })
  }

  if (isStreaming) return <code className="markdown-code-block">{code}</code>

  const highlightedLanguage = normalizeHighlightLanguage(language ?? inferCodeLanguage(code))

  return (
    <div className="markdown-code-wrap">
      <button
        type="button"
        className={`code-copy-button ${copied ? 'copied' : ''}`}
        aria-label={copied ? 'Copied code' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        onClick={copyCode}
      >
        {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
      </button>
      <SyntaxHighlighter
        PreTag="pre"
        CodeTag="code"
        className="markdown-code-pre"
        codeTagProps={{ className: 'markdown-code-block highlighted' }}
        customStyle={{
          margin: 0,
          background: '#24292e',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: '12px 14px'
        }}
        language={highlightedLanguage}
        style={atomOneDark}
        wrapLongLines={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
})

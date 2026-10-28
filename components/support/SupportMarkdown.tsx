'use client'

/**
 * Markdown for support replies: Backenly AI and the team write Markdown, with
 * commands in fenced blocks, and those used to render as raw text with the
 * backticks showing. Customers' own messages are not rendered through this:
 * they paste errors and paths, where an underscore is not emphasis.
 *
 * Safe by construction: react-markdown renders no raw HTML and its URL
 * transform drops dangerous protocols. Images render as links, so an answer
 * cannot load a remote resource into the console.
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from '@/components/inspector/kit'

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: string[] | string }
  children?: HastNode[]
}

function textOf(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function languageOf(node: HastNode | undefined): string | null {
  const cls = node?.properties?.className
  const list = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(' ') : []
  const lang = list.find((c) => c.startsWith('language-'))
  return lang ? lang.slice('language-'.length) : null
}

function CodeBlock({ code, language }: { code: string; language: string | null }) {
  return (
    <div className="my-3 overflow-hidden rounded-[7px] border border-white/[0.07] bg-[#08090a]">
      <div className="flex h-[30px] items-center justify-between border-b border-white/[0.06] pl-3 pr-1">
        <span className="font-mono text-[11px] text-faint" translate="no">
          {language ?? 'text'}
        </span>
        <CopyButton value={code} label="Copy code" />
      </div>
      {/* Wrapped, not scrolled: a support answer's command has to be readable
          whole, and the copy button takes it exactly as written. */}
      <pre
        className="whitespace-pre-wrap px-3 py-2.5 font-mono text-[12px] leading-[19px] text-zinc-200 [overflow-wrap:anywhere]"
        translate="no"
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

function isExternal(href: string | undefined): boolean {
  if (!href) return false
  if (typeof window === 'undefined') return /^https?:\/\//.test(href)
  try {
    return new URL(href, window.location.href).origin !== window.location.origin
  } catch {
    return false
  }
}

export function SupportMarkdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 text-[13.5px] leading-[22px] text-zinc-200 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 marker:text-zinc-600">{children}</ul>,
          // `start` carries the numbering on after a code block splits a list,
          // which is how most answers with commands are written.
          ol: ({ children, start }) => (
            <ol start={start} className="my-2.5 list-decimal space-y-1.5 pl-5 marker:text-faint">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-zinc-50">{children}</strong>,
          em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
          h1: ({ children }) => <p className="mb-1.5 mt-4 font-semibold text-zinc-50 first:mt-0">{children}</p>,
          h2: ({ children }) => <p className="mb-1.5 mt-4 font-semibold text-zinc-50 first:mt-0">{children}</p>,
          h3: ({ children }) => <p className="mb-1.5 mt-3 font-semibold text-zinc-100 first:mt-0">{children}</p>,
          h4: ({ children }) => <p className="mb-1 mt-3 font-medium text-zinc-100 first:mt-0">{children}</p>,
          hr: () => <hr className="my-4 border-white/[0.07]" />,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-white/[0.12] pl-3 text-zinc-300">{children}</blockquote>
          ),
          a: ({ href, children }) => {
            const external = isExternal(href)
            return (
              <a
                href={href}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="rounded-[3px] text-violet-300 underline decoration-violet-300/40 underline-offset-[3px] transition-colors duration-150 hover:text-violet-200 hover:decoration-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
              >
                {children}
              </a>
            )
          },
          img: ({ src, alt }) =>
            typeof src === 'string' ? (
              <a href={src} target="_blank" rel="noopener noreferrer" className="text-violet-300 underline underline-offset-[3px]">
                {alt || src}
              </a>
            ) : null,
          code: ({ children }) => (
            <code className="rounded-[4px] border border-white/[0.06] bg-white/[0.05] px-[5px] py-px font-mono text-[12px] text-zinc-100" translate="no">
              {children}
            </code>
          ),
          pre: ({ node }) => {
            const codeNode = (node as unknown as HastNode | undefined)?.children?.find((c) => c.tagName === 'code')
            return <CodeBlock code={textOf(codeNode).replace(/\n$/, '')} language={languageOf(codeNode)} />
          },
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-[7px] border border-white/[0.07]">
              <table className="w-full border-collapse text-left text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-white/[0.07] bg-white/[0.02] px-3 py-2 font-medium text-zinc-300">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-white/[0.05] px-3 py-2 align-top text-zinc-300">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

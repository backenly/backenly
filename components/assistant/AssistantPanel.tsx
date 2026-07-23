'use client'

/**
 * AssistantPanel — the platform Q&A helper.
 *
 * A slim right panel, kit language (#16171d, hairlines, violet only for the
 * send action). It streams answers from /api/projects/[id]/assistant — a
 * conversation-only endpoint grounded in the platform manifest + this
 * project's connect context. It answers "how do I…/where is…/can Backenly…"
 * questions and points at the right section; it NEVER builds or mutates.
 * Building happens through the user's coding agent over MCP (Connect) or the
 * Database section UI.
 *
 * History is per-session React state — deliberately not persisted. This is a
 * help surface, not a build journal (the Overview's agent journal owns the
 * record of change).
 */

import { useEffect, useRef, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import { X, ArrowUp, RotateCcw, Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'

export const ASSISTANT_PANEL_WIDTH = 380

interface Message {
  role: 'user' | 'assistant'
  content: string
}

/** Guidance-flavored starters per section — questions, never build commands. */
function suggestionsFor(pathname: string): string[] {
  if (pathname.includes('/connect')) {
    return [
      'How do I wire Claude Code to this project?',
      'What can my agent do over MCP, and what needs my approval?',
      'How do I use the SDK from my frontend?',
    ]
  }
  if (pathname.includes('/auth')) {
    return [
      'How does end-user auth work here?',
      'How do I turn on Google sign-in?',
      'What are RLS policies and where do I manage them?',
    ]
  }
  if (pathname.includes('/database')) {
    return [
      'How do I create or change tables?',
      'How do the generated APIs relate to my tables?',
      'How do I browse and edit my data?',
    ]
  }
  if (pathname.includes('/autonomy')) {
    return [
      'What does the autonomy loop actually do?',
      'Which fixes need my approval?',
      'How often does my plan run the loop?',
    ]
  }
  if (pathname.includes('/deploy') || pathname.includes('/monitoring')) {
    return [
      'How do I publish this backend?',
      'Where do I see request logs and errors?',
      'How do rollbacks work?',
    ]
  }
  return [
    'How do I connect Cursor or Claude Code to this project?',
    'Where do I manage API keys?',
    'What does Backenly watch and fix on its own?',
  ]
}

export function AssistantPanel() {
  const params = useParams()
  const pathname = usePathname() || ''
  const projectId = params.id as string

  const open = useAssistantStore((s) => s.open)
  const setOpen = useAssistantStore((s) => s.setOpen)
  const hydrate = useAssistantStore((s) => s.hydrate)

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (projectId) hydrate(projectId)
  }, [projectId, hydrate])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = async (raw: string) => {
    const text = raw.trim()
    if (!text || streaming || !projectId) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const history = [...messages, { role: 'user' as const, content: text }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)

    const appendToAnswer = (chunk: string) =>
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, content: last.content + chunk }
        return next
      })

    try {
      const res = await fetch(`/api/projects/${projectId}/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        // Send a bounded window — the server grounds every turn itself.
        body: JSON.stringify({ messages: history.slice(-12) }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const fallback =
          res.status === 429
            ? 'You have hit the rate limit (20 questions per minute). Give it a moment and ask again.'
            : 'Something went wrong answering that. Try again in a moment.'
        let detail = ''
        try {
          const j = await res.json()
          detail = typeof j?.error === 'string' ? j.error : ''
        } catch { /* non-JSON error body */ }
        appendToAnswer(detail || fallback)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        appendToAnswer(decoder.decode(value, { stream: true }))
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        appendToAnswer('Connection dropped mid-answer. Ask again.')
      }
    } finally {
      setStreaming(false)
    }
  }

  if (!open) return null

  const suggestions = suggestionsFor(pathname)

  return (
    <aside
      className="fixed top-12 right-0 bottom-0 z-20 w-full sm:w-[380px] bg-[#16171d] border-l border-white/[0.07] flex flex-col"
      aria-label="Assistant"
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2 h-11 px-3.5 border-b border-white/[0.07] flex-shrink-0">
        <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
        <span className="text-[12.5px] font-semibold text-zinc-100">Assistant</span>
        <span className="text-[10px] font-mono text-zinc-600 mt-px">answers only</span>
        <div className="ml-auto flex items-center gap-0.5">
          {messages.length > 0 && (
            <button
              onClick={() => { abortRef.current?.abort(); setMessages([]); setStreaming(false) }}
              title="Clear conversation"
              aria-label="Clear conversation"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            title="Close (⌘J)"
            aria-label="Close assistant"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-4">
        {messages.length === 0 ? (
          <div className="pt-6">
            <p className="text-[12.5px] text-zinc-300 font-medium mb-1">
              Ask about the platform.
            </p>
            <p className="text-[11.5px] text-zinc-500 leading-relaxed mb-5">
              How features work, where things live, how to wire your coding
              agent or frontend to this project. Building itself happens
              through your agent (Connect) or the Database section.
            </p>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-left px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.06] text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:border-white/[0.14] transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="self-end max-w-[85%] rounded-lg bg-white/[0.06] border border-white/[0.08] px-3 py-2">
                  <p className="text-[12px] text-zinc-100 whitespace-pre-wrap leading-relaxed">{m.content}</p>
                </div>
              ) : (
                <div key={i} className="max-w-full text-[12px] text-zinc-300 leading-relaxed">
                  {m.content === '' && streaming && i === messages.length - 1 ? (
                    <span className="inline-flex gap-1 items-center h-4" aria-label="Thinking">
                      <span className="w-1 h-1 rounded-full bg-zinc-500 animate-pulse" />
                      <span className="w-1 h-1 rounded-full bg-zinc-600 animate-pulse [animation-delay:150ms]" />
                      <span className="w-1 h-1 rounded-full bg-zinc-700 animate-pulse [animation-delay:300ms]" />
                    </span>
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: (props: any) => <p className="mb-2 last:mb-0" {...props} />,
                        ul: (props: any) => <ul className="list-disc pl-4 mb-2 space-y-0.5" {...props} />,
                        ol: (props: any) => <ol className="list-decimal pl-4 mb-2 space-y-0.5" {...props} />,
                        strong: (props: any) => <strong className="font-semibold text-zinc-100" {...props} />,
                        a: (props: any) => <a className="text-violet-300 underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
                        code: ({ className, children, ...props }: any) =>
                          /language-/.test(className || '') ? (
                            <code className={`${className} text-[11px]`} {...props}>{children}</code>
                          ) : (
                            <code className="px-1 py-0.5 rounded bg-white/[0.06] font-mono text-[11px] text-zinc-200" {...props}>{children}</code>
                          ),
                        pre: (props: any) => (
                          <pre className="rounded-md bg-[#0f1015] border border-white/[0.06] p-2.5 mb-2 overflow-x-auto font-mono text-[11px] leading-relaxed" {...props} />
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  )}
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* ── Input ── */}
      <div className="border-t border-white/[0.07] p-3 flex-shrink-0">
        <div className="flex items-end gap-1.5 rounded-lg bg-white/[0.03] border border-white/[0.08] focus-within:border-white/[0.16] transition-colors px-2.5 py-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
            placeholder="Ask how something works…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[12px] text-zinc-100 placeholder-zinc-600 focus:outline-none leading-relaxed max-h-24 py-1"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || streaming}
            aria-label="Send"
            className="inline-flex items-center justify-center w-[26px] h-[26px] rounded-md bg-white text-black hover:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-[10px] text-zinc-600 mt-1.5 px-0.5">
          Answers questions only. Building happens through your connected agent.
        </p>
      </div>
    </aside>
  )
}

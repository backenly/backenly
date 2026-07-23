'use client'

/**
 * CodeSurface — the terminal/config chrome + monochrome syntax highlighting for
 * every code block on the Connect › Agents tab (commands, JSON config, prompts).
 *
 * Highlighting is deliberately restrained to fit the flat inspector language:
 * meaning is carried by BRIGHTNESS TIERS (bright anchor → muted flags), not a
 * rainbow. Violet is spent on exactly one token — the scoped key — because that
 * is the only thing on screen the reader must act on. This keeps the surface
 * consistent with "violet only for action" while still reading like a real
 * terminal at a funded-platform level of finish.
 */

import type { ReactNode } from 'react'
import { Copy, Check } from 'lucide-react'

/* A scoped key or its placeholder — the one token worth accenting. */
function isSecret(t: string): boolean {
  return t.startsWith('<') || t.startsWith('mcp_')
}
function isUuid(t: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(t)
}

const EXECS = new Set(['claude', 'codex', 'cursor', 'npx'])

/** A single shell command line, tokenized and brightness-tiered. */
export function CliText({ text }: { text: string }) {
  const tokens = text.split(/(\s+)/)
  return (
    <>
      {tokens.map((t, i) => {
        if (t === '' || /^\s+$/.test(t)) return <span key={i}>{t}</span>
        let cls = 'text-zinc-400'
        if (EXECS.has(t)) cls = 'text-zinc-100 font-medium'
        else if (t === 'mcp' || t === 'add' || t === 'backenly' || t.startsWith('@backenly')) cls = 'text-zinc-300'
        else if (t === '--' || t === '-y' || t.startsWith('--')) cls = 'text-zinc-600'
        else if (isSecret(t)) cls = 'text-violet-300'
        else if (isUuid(t)) cls = 'text-zinc-400'
        return (
          <span key={i} className={cls}>
            {t}
          </span>
        )
      })}
    </>
  )
}

/** Pretty-printed JSON config, tokenized. Keys bright, secret values violet. */
export function JsonText({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|([{}[\],])/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<span key={k++}>{text.slice(last, m.index)}</span>)
    if (m[1] !== undefined) {
      const isKey = m[2] !== undefined
      const raw = m[1].slice(1, -1)
      const cls = isKey ? 'text-zinc-200' : isSecret(raw) ? 'text-violet-300' : 'text-zinc-400'
      nodes.push(
        <span key={k++} className={cls}>
          {m[1]}
        </span>,
      )
      if (m[2] !== undefined)
        nodes.push(
          <span key={k++} className="text-zinc-600">
            {m[2]}
          </span>,
        )
    } else if (m[3] !== undefined) {
      nodes.push(
        <span key={k++} className="text-zinc-600">
          {m[3]}
        </span>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>)
  return <>{nodes}</>
}

function renderPromptLine(line: string): ReactNode {
  // A bare command line inside the prompt gets full shell highlighting.
  if (line.trimStart().startsWith('claude ')) return <CliText text={line} />
  // Otherwise: plain prose, with `inline code` and URLs lifted out.
  const parts = line.split(/(`[^`]+`|https?:\/\/\S+)/g)
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`'))
      return (
        <span key={i} className="rounded bg-white/[0.06] px-1 py-px text-zinc-200">
          {p.slice(1, -1)}
        </span>
      )
    if (/^https?:\/\//.test(p))
      return (
        <span key={i} className="text-zinc-500 underline decoration-white/20 underline-offset-2">
          {p}
        </span>
      )
    return (
      <span key={i} className="text-zinc-400">
        {p}
      </span>
    )
  })
}

/** A multi-line agent prompt: prose + an embedded command + backticked tools. */
export function PromptText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {renderPromptLine(line)}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </>
  )
}

export function CopyButton({
  onClick,
  copied,
  disabled = false,
  compact = false,
}: {
  onClick: () => void
  copied: boolean
  disabled?: boolean
  compact?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        compact ? 'h-7 w-7 justify-center' : 'h-7 px-2.5'
      } ${
        copied
          ? 'bg-emerald-500/[0.10] text-emerald-300'
          : 'bg-white/[0.05] text-zinc-400 hover:bg-white/[0.09] hover:text-zinc-100'
      }`}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {!compact && (copied ? 'Copied' : 'Copy')}
    </button>
  )
}

/**
 * The framed code block: a slim terminal bar (window dots + a mono label) over a
 * highlighted body. `label` names the surface — a shell (`bash`) or a config
 * path (`.cursor/mcp.json`).
 */
export function CodeSurface({
  label,
  onCopy,
  copied,
  disabled = false,
  children,
}: {
  label?: string
  onCopy: () => void
  copied: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.07] bg-[#0f1015]">
      <div className="flex h-9 items-center justify-between gap-3 border-b border-white/[0.06] px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex items-center gap-[5px]">
            <span className="h-[7px] w-[7px] rounded-full bg-white/[0.11]" />
            <span className="h-[7px] w-[7px] rounded-full bg-white/[0.11]" />
            <span className="h-[7px] w-[7px] rounded-full bg-white/[0.11]" />
          </span>
          {label && (
            <span className="truncate font-mono text-[11px] tracking-tight text-zinc-500">{label}</span>
          )}
        </div>
        <CopyButton onClick={onCopy} copied={copied} disabled={disabled} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3.5 font-mono text-[12px] leading-[1.7] tracking-[-0.01em] text-zinc-400 [font-variant-ligatures:none]">
        {children}
      </pre>
    </div>
  )
}

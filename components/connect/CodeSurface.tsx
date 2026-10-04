'use client'

/**
 * CodeSurface — the terminal/config chrome + monochrome syntax highlighting for
 * every code block on the Connect › Agents tab (commands and JSON config).
 *
 * Highlighting is deliberately restrained to fit the flat inspector language:
 * meaning is carried by BRIGHTNESS TIERS (bright anchor → muted flags), not a
 * rainbow. Violet is spent on exactly one token — the scoped key — because that
 * is the only thing on screen the reader must act on. This keeps the surface
 * consistent with "violet only for action" while still reading like a real
 * terminal at a funded-platform level of finish.
 */

import type { ClipboardEvent, ReactNode } from 'react'
import { Copy, Check } from 'lucide-react'

/* A scoped key or its placeholder — the one token worth accenting. */
function isSecret(t: string): boolean {
  return t.startsWith('<') || t.startsWith('mcp_')
}
function isUuid(t: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(t)
}

const EXECS = new Set(['claude', 'codex', 'cursor', 'npx'])

/**
 * One block per line, with a hanging indent: a line too long for the panel
 * wraps two columns in from where it starts, so a wrapped command or config
 * line reads as one line continuing, not a new line at the margin.
 */
function Lines({ text, render }: { text: string; render: (line: string) => ReactNode }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const hang = `${line.length - line.trimStart().length + 2}ch`
        return (
          <span key={i} className="block" style={{ paddingLeft: hang, textIndent: `-${hang}` }}>
            {render(line)}
          </span>
        )
      })}
    </>
  )
}

/** A shell command line, tokenized and brightness-tiered. */
export function CliText({ text }: { text: string }) {
  return <Lines text={text} render={cliLine} />
}

function cliLine(line: string): ReactNode {
  return line.split(/(\s+)/).map((t, i) => {
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
  })
}

/** Pretty-printed JSON config, tokenized. Keys bright, secret values violet. */
export function JsonText({ text }: { text: string }) {
  return <Lines text={text} render={jsonLine} />
}

function jsonLine(line: string): ReactNode {
  const nodes: ReactNode[] = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|([{}[\],])/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) nodes.push(<span key={k++}>{line.slice(last, m.index)}</span>)
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
  if (last < line.length) nodes.push(<span key={k++}>{line.slice(last)}</span>)
  return nodes
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
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={copied ? 'Copied' : 'Copy'}
      className={`inline-flex items-center gap-1.5 rounded-[6px] text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60 disabled:cursor-not-allowed disabled:opacity-40 ${
        compact ? 'h-[26px] w-[26px] justify-center' : 'h-[26px] px-2'
      } ${
        copied
          ? 'text-emerald-300'
          : 'text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100'
      }`}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {!compact && (copied ? 'Copied' : 'Copy')}
    </button>
  )
}

/**
 * The framed code block: a slim bar over a highlighted body, with an optional
 * footer line. `bar` fills the left of the top bar (on the Agents tab, the
 * agent picker); `actions` sit just before the copy button at its right. The
 * copy button is icon-only so the picker keeps the width. No window dots: this
 * is a code block, not a picture of a terminal.
 *
 * `onSelectionCopy` sees a copy made by selecting the body by hand, so a body
 * that shows a stand-in (a masked key) can put the real text on the clipboard.
 */
export function CodeSurface({
  bar,
  actions,
  footer,
  onCopy,
  copied,
  disabled = false,
  onSelectionCopy,
  children,
}: {
  bar?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  onCopy: () => void
  copied: boolean
  disabled?: boolean
  onSelectionCopy?: (event: ClipboardEvent<HTMLPreElement>) => void
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#08090a]">
      <div className="flex min-h-[40px] items-center justify-between gap-2 border-b border-white/[0.06] pr-1.5">
        <div className="min-w-0 flex-1">{bar}</div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {actions}
          <CopyButton onClick={onCopy} copied={copied} disabled={disabled} compact />
        </div>
      </div>
      <pre
        onCopy={onSelectionCopy}
        className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3.5 font-mono text-[12px] leading-[20px] text-zinc-400 [font-variant-ligatures:none]"
      >
        {children}
      </pre>
      {footer && <div className="border-t border-white/[0.06] px-4 py-2.5">{footer}</div>}
    </div>
  )
}

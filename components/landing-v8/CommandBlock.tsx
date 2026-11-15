'use client'

import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy } from 'lucide-react'
import { EASE_OUT } from './tokens'

/* ─────────────────────────────────────────────────────────────
   The one command a developer really runs (founder, 2026-11-15: a bare link
   "is fake, show real code"), set like Blaxel's install line. It is the
   published installer, @backenly/mcp-server (packages/mcp-server, src/init.ts):
   it asks for the project's MCP key, checks it, keeps it in ~/.backenly/mcp.json
   and prints the exact setup for Claude Code, Codex, Cursor or Cline. It runs
   the same on every OS, so there are no OS tabs, and it names no agent
   (founder, 2026-11-14); the band under the hero names the hosts.
───────────────────────────────────────────────────────────── */

const COMMAND = 'npx @backenly/mcp-server init'

export function CommandBlock({ className = '' }: { className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND)
    } catch {
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div
      className={`flex h-[48px] min-w-0 items-center gap-[14px] rounded-[8px] border border-white/[0.12] bg-[#0b0b0e]/90 pl-[18px] pr-[6px] shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] transition-[border-color] duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.20] ${className}`}
    >
      {/* select-all: a click on the command takes the whole command, as developers expect. */}
      <code className="min-w-0 flex-1 select-all truncate font-mono text-[14.5px] text-zinc-100 [font-variant-ligatures:none]">{COMMAND}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy the setup command'}
        className="relative flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[5px] text-zinc-300 transition-colors duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/[0.07] [@media(hover:hover)_and_(pointer:fine)]:hover:text-white active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]"
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? 'done' : 'copy'}
            initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className="flex"
          >
            {copied ? <Check aria-hidden className="h-[16px] w-[16px] text-violet-300" /> : <Copy aria-hidden className="h-[16px] w-[16px]" />}
          </motion.span>
        </AnimatePresence>
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Command copied' : ''}
      </span>
    </div>
  )
}

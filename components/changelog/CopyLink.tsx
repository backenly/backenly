'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Link2 } from 'lucide-react'

/** Copies the address of one change, its stable anchor on /changelog, and says so. */
export function CopyLink({ slug, title }: { slug: string; title: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    const url = `${window.location.origin}/changelog#${slug}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // No clipboard (an insecure origin, a refused permission): go to the anchor, so the address bar holds it.
      window.location.hash = slug
      return
    }
    window.history.replaceState(null, '', `#${slug}`)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy a link to “${title}”`}
        className="inline-flex h-[26px] items-center gap-[6px] rounded-[6px] px-[6px] text-[12.5px] text-zinc-400 opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-white/[0.05] hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 group-hover/entry:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {copied ? <Check aria-hidden className="h-[14px] w-[14px] text-white" /> : <Link2 aria-hidden className="h-[14px] w-[14px]" />}
        <span aria-hidden>{copied ? 'Copied' : 'Link'}</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </>
  )
}

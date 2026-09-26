'use client'

/**
 * The first thing a connected user asks their agent for, in the same framed
 * block the Connect page uses for its setup prompt. The label says where it
 * goes, because pasting it into this dashboard is the mistake it exists to
 * prevent.
 */

import { useState } from 'react'
import { CodeSurface, PromptText } from '@/components/connect/CodeSurface'
import { useGuideStore } from '@/lib/stores/use-guide-store'
import { STARTER_PROMPT } from './guide-copy'

export function StarterPrompt() {
  const [copied, setCopied] = useState(false)
  const track = useGuideStore((s) => s.track)

  async function copy() {
    try {
      await navigator.clipboard.writeText(STARTER_PROMPT)
      setCopied(true)
      track('starter_prompt_copied', 'backend')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — the text is still selectable */
    }
  }

  return (
    <div className="space-y-1.5">
      <CodeSurface label="paste into your coding agent" onCopy={copy} copied={copied}>
        <PromptText text={STARTER_PROMPT} />
      </CodeSurface>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Run it in the agent you connected, not here. Change the app to whatever you are building; the more
        decisions the description makes, the closer the first build lands.
      </p>
    </div>
  )
}

'use client'

/**
 * The empty state of a section the coding agent builds into: what the section
 * holds, the first thing to ask the agent for, and the way there.
 *
 * Database, Auth & Users, Storage, Functions, Realtime and Deploy each used to
 * end their empty state in their own way: a white button in one, a bordered
 * link in another, a Sparkles button, underlined text. The same step now reads
 * the same everywhere, worded like the top bar's control ("Connect agent"),
 * and only until the agent is connected (useAgentConnection). After that the
 * request itself is the next step.
 *
 * The docs link opens the section's page in /docs, which exists to say what
 * the section is for.
 */

import Link from 'next/link'
import { ArrowUpRight, Cable, type LucideIcon } from 'lucide-react'
import type { DocSlug } from '@/app/docs/content'
import { AgentPrompt, BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS, EmptyState } from '@/components/inspector/kit'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'

interface AgentEmptyStateProps {
  projectId: string | null | undefined
  icon: LucideIcon
  title: string
  description: string
  /** The first request to send the agent: one concrete sentence. */
  prompt: string
  /** The /docs page for this section. */
  docs: DocSlug
  className?: string
}

export function AgentEmptyState({
  projectId,
  icon,
  title,
  description,
  prompt,
  docs,
  className = '',
}: AgentEmptyStateProps) {
  const agent = useAgentConnection(projectId)
  // Full width, so the request is the same width in every section rather
  // than the width of its own sentence.
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      className={`w-full ${className}`}
      action={
        <div className="flex w-full flex-col items-center gap-5">
          <AgentPrompt prompt={prompt} className="max-w-[440px]" />
          <div className="flex flex-wrap items-center justify-center gap-2">
            {agent.needsConnect && <ConnectAgentLink projectId={projectId} />}
            <DocsLink slug={docs} />
          </div>
        </div>
      }
    />
  )
}

/** The Connect step, styled and worded as the top bar's. */
export function ConnectAgentLink({ projectId, className = '' }: { projectId: string | null | undefined; className?: string }) {
  return (
    <Link
      href={projectId ? `/app/projects/${projectId}/connect` : '/app'}
      className={`${BUTTON_BASE} ${BUTTON_SIZES.md} ${BUTTON_VARIANTS.primary} ${className}`}
    >
      <Cable className="h-[15px] w-[15px]" strokeWidth={2} />
      Connect agent
    </Link>
  )
}

/** A section's docs page, in a new tab so the console keeps its place. */
export function DocsLink({ slug }: { slug: DocSlug }) {
  return (
    <a
      href={`/docs/${slug}`}
      target="_blank"
      rel="noreferrer"
      className={`${BUTTON_BASE} ${BUTTON_SIZES.md} ${BUTTON_VARIANTS.ghost}`}
    >
      View docs
      <ArrowUpRight className="h-[15px] w-[15px]" strokeWidth={2} />
    </a>
  )
}

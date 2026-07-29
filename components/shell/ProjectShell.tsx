'use client'

/**
 * ProjectShell — the one project-workspace frame.
 *
 * Composes the persistent TopBar + the single ProjectSidebar + the global
 * AssistantPanel and renders the active section as page content between them.
 * This is the "one layout.tsx that wraps ALL project pages" from
 * the IA restructure §4/§6.1: the `(inspector)` group layout, the
 * monolith's private chrome and every per-page header collapse into this.
 *
 * The Assistant (Q&A helper — answers, never builds) mounts HERE, not per
 * page, so a conversation survives navigation between sections. Content
 * shifts right when the panel is open on large screens; on smaller screens
 * the panel overlays instead of squeezing the content to nothing.
 *
 * The autonomy toaster + welcome-back banner ride along here so they persist
 * across section navigation (they used to live in the inspector group layout).
 */

import { type ReactNode } from 'react'
import { TopBar } from './TopBar'
import { ProjectSidebar } from './ProjectSidebar'
import { AssistantPanel } from '@/components/assistant/AssistantPanel'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'
import AutonomyToaster from '@/components/autonomy/AutonomyToaster'
import AutonomyWelcomeBackBanner from '@/components/autonomy/AutonomyWelcomeBackBanner'

export function ProjectShell({ children }: { children: ReactNode }) {
  const assistantOpen = useAssistantStore((s) => s.open)

  return (
    <div className="min-h-screen bg-[#101116]">
      <TopBar />
      <ProjectSidebar />

      {/* Content region — offset by the fixed top bar (48px), sidebar (248px),
          and the assistant panel (380px) when it's open on large screens. */}
      <div
        className={`pt-12 pl-[248px] transition-[padding] duration-150 ${
          assistantOpen ? 'lg:pr-[380px]' : ''
        }`}
      >
        <div className="relative min-h-[calc(100vh-48px)]">
          {/* One violet hairline along the content's top edge (kept from the
              inspector frame — reads as an instrument, not decoration). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.30),transparent)]"
          />
          <AutonomyWelcomeBackBanner />
          {children}
          <AutonomyToaster />
        </div>
      </div>

      {/* Assistant — chrome, not a place. Renders nothing while closed. */}
      <AssistantPanel />
    </div>
  )
}

'use client'

/**
 * ProjectShell: the one project-workspace frame.
 *
 * Composes the persistent TopBar, the single ProjectSidebar and the global
 * AssistantPanel around the active section (IA restructure §4/§6.1). The
 * frame itself (chrome, lit canvas, phone drawer) is ConsoleFrame, shared with
 * the account-level OrgShell.
 *
 * The Assistant (Q&A helper: answers, never builds) mounts HERE, not per
 * page, so a conversation survives navigation between sections. From 1536px
 * the canvas makes room for it; below that it overlays the page rather than
 * squeezing it.
 *
 * The autonomy toaster and welcome-back row ride along here so they persist
 * across section navigation (the row hides itself on Overview and Autonomy).
 */

import { type ReactNode } from 'react'
import { TopBar } from './TopBar'
import { ProjectSidebar } from './ProjectSidebar'
import { ConsoleFrame } from './ConsoleChrome'
import { AssistantPanel } from '@/components/assistant/AssistantPanel'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'
import AutonomyToaster from '@/components/autonomy/AutonomyToaster'
import AutonomyWelcomeBackBanner from '@/components/autonomy/AutonomyWelcomeBackBanner'
import { ProjectAvailabilityGate } from '@cloud/project-availability'
import { ProjectActivityBeacon } from './ProjectActivityBeacon'
import { ConsoleTour } from '@/components/tour/ConsoleTour'

export function ProjectShell({ children }: { children: ReactNode }) {
  const assistantOpen = useAssistantStore((s) => s.open)

  return (
    <>
      <ConsoleFrame bar={<TopBar />} sidebar={<ProjectSidebar />} rightInset={assistantOpen} drawerLabel="Project navigation">
        <AutonomyWelcomeBackBanner />
        {/* Cloud swaps a paused project's pages for the paused screen; a
            self-hosted build renders the page, because nothing pauses. */}
        <ProjectAvailabilityGate>{children}</ProjectAvailabilityGate>
        <AutonomyToaster />
        <ProjectActivityBeacon />
      </ConsoleFrame>

      {/* Assistant — chrome, not a place. Renders nothing while closed. */}
      <AssistantPanel />
      <ConsoleTour />
    </>
  )
}

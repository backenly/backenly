'use client'

/**
 * The project availability gate, as resolved WITHOUT the private overlay.
 *
 * `@cloud/project-availability` resolves here only when
 * `lib/cloud/project-availability.tsx` is absent. The Cloud version replaces a
 * paused project's pages with the paused screen (resume, export, upgrade) and
 * shows the pause warning banner. This one renders the project, always.
 *
 * ---- WHY A PASSTHROUGH AND NOT NOTHING --------------------------------------
 *
 * A self-hosted project never pauses: nothing public sets `pausedAt`, and
 * `selfHostedEntitlements()` says so in so many words. So there is no state for
 * this build to show and nothing to gate. Rendering the children, rather than
 * making ProjectShell check the edition, keeps the seam at the import and the
 * shell edition-unaware, the same shape as `oss/org-switcher.tsx`.
 */
import type { ReactNode } from 'react'

export function ProjectAvailabilityGate({ children }: { children: ReactNode }) {
  return <>{children}</>
}

'use client'

/**
 * Project workspace layout — the single frame for everything under
 * /app/projects/[id], per the IA restructure §4/§6.1/§7.
 *
 * The restructure is complete here: ONE shell (TopBar + ProjectSidebar +
 * ChatDock) wraps every project page, Overview included. The old monolith's
 * private chrome, the `(inspector)` group, the Control Hub overlay and its
 * `?hub=` deep links are all gone.
 *
 * Legacy `?hub=<section>` links (emails, bookmarks, old buttons) are honored
 * with a permanent client redirect to the section's real page (§14 param
 * redirect map).
 */

import { useEffect } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ProjectShell } from '@/components/shell/ProjectShell'

// Old Control-Hub sections → their real pages (§14).
const HUB_REDIRECTS: Record<string, string> = {
  'autonomy': '/autonomy',
  'client-keys': '/settings',
  'integrations': '/integrations',
  'connect-frontend': '/connect',
  'mcp': '/connect',
}

export default function ProjectWorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectId = params.id as string

  useEffect(() => {
    const hub = searchParams.get('hub')
    if (!hub) return
    const target = HUB_REDIRECTS[hub] ?? ''
    router.replace(`/app/projects/${projectId}${target}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, projectId, pathname])

  return <ProjectShell>{children}</ProjectShell>
}

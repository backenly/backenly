'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { AppHeader } from '@/components/app/AppHeader'
import { AppSidebar } from '@/components/app/AppSidebar'
import { Logo } from '@/components/Logo'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import { getProjects } from '@/lib/api/projects'
import { isAuthenticated, logout } from '@/lib/api/auth'
import { VerifyEmailWall } from '@/components/app/VerifyEmailWall'

// Inner component for layout
function AppLayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  
  // Hide sidebar and header on overview page (/app)
  const isOverviewPage = pathname === '/app' || pathname === '/app/'
  
  // Hide sidebar and header on all project pages (/app/projects/*)
  // Users should only see: main prompt, "See what changed", "Undo last change", and hidden Advanced Mode
  const isProjectPage = pathname?.startsWith('/app/projects/')

  // Hide sidebar and header on settings page
  const isSettingsPage = pathname === '/app/settings'

  // Org-shell pages provide their own chrome (OrgShell) — suppress the legacy
  // AppHeader/AppSidebar so it doesn't double up (§5).
  const isOrgShellPage = ['/app/usage', '/app/billing', '/app/members', '/app/referral'].some(
    (p) => pathname?.startsWith(p),
  )

  const bare = isOverviewPage || isProjectPage || isSettingsPage || isOrgShellPage

  return (
    <div className="min-h-screen bg-bg-base">
      {!bare && <AppHeader />}
      <div className="flex">
        {!bare && <AppSidebar />}
        <main
          className="flex-1"
          style={{ marginLeft: bare ? '0' : '64px' }}
        >
          {children}
        </main>
      </div>
    </div>
  )
}

function AppLayoutInternal({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [sidebarWidth, setSidebarWidth] = useState(256) // 64 * 4 = 256px (w-64)
  const [isCheckingProject, setIsCheckingProject] = useState(true)
  // Signup-trust standing. `null` until /api/auth/me answers; the wall must
  // never flash before we know, and must never block if the check itself fails.
  const [standing, setStanding] = useState<{ walled: boolean; email: string } | null>(null)

  // Handle OAuth token sync to localStorage
  useEffect(() => {
    const token = searchParams.get('token')
    if (token) {
      console.log('🔄 Syncing OAuth token to localStorage...')
      localStorage.setItem('auth-token', token)
      
      // Remove token from URL for clean look and security
      const params = new URLSearchParams(searchParams.toString())
      params.delete('token')
      const newUrl = `${pathname}${params.toString() ? '?' + params.toString() : ''}`
      window.history.replaceState({}, '', newUrl)
    }
  }, [searchParams, pathname])

  // Check if user has projects and redirect if needed
  useEffect(() => {
    const checkProject = async () => {
      // Skip check for app overview page, settings page, or any project page
      // Project pages handle their own auth and data fetching
      // Org-shell + project pages handle their own auth/data — never bounce
      // them through the "no projects → /app" redirect.
      const selfGuardedPrefixes = ['/app/projects/', '/app/api-builder', '/app/deploy', '/app/usage', '/app/billing', '/app/members', '/app/referral']
      if (
        pathname === '/app' || pathname === '/app/' || pathname === '/app/settings' || pathname === '/app/connect' ||
        selfGuardedPrefixes.some((p) => pathname?.startsWith(p))
      ) {
        setIsCheckingProject(false)
        return
      }

      // Check if user is authenticated
      if (!isAuthenticated()) {
        router.push('/auth/login')
        return
      }

      try {
        const projects = await getProjects()
        if (projects.length === 0) {
          // No projects found, redirect to app overview (has create modal)
          router.push('/app')
          return
        }
        
        // User has projects, cache the first one
        const firstProject = projects[0]
        const { setCurrentProjectId } = await import('@/lib/api/client')
        setCurrentProjectId(firstProject.id)
      } catch (error) {
        console.error('Failed to check projects:', error)
        // If it's a 401/403, might need to login again
        if (error instanceof Error && (error.message.includes('401') || error.message.includes('Unauthorized'))) {
          router.push('/auth/login')
          return
        }
      } finally {
        setIsCheckingProject(false)
      }
    }

    checkProject()
  }, [router, pathname])

  // Signup-trust standing. Only accounts flagged untrusted at signup AND still
  // unverified are walled — 21 pre-existing accounts are unverified but trusted,
  // and gating on `emailVerified` alone would lock every one of them out.
  //
  // Fails OPEN on any error: a flaky /me must never wall a paying customer out
  // of their own dashboard. The real boundary is the server gate in
  // lib/trust/account-standing.ts, which this only mirrors for UX.
  useEffect(() => {
    let cancelled = false
    const checkStanding = async () => {
      if (!isAuthenticated()) return
      try {
        const token = localStorage.getItem('auth-token')
        const res = await fetch('/api/auth/me', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        })
        if (!res.ok) return
        const me = await res.json()
        if (cancelled) return
        setStanding({
          walled: me?.trustLevel === 'untrusted' && me?.emailVerified === false,
          email: me?.email ?? '',
        })
      } catch {
        // Leave `standing` null — renders the app, never the wall.
      }
    }
    checkStanding()
    return () => { cancelled = true }
  }, [pathname])

  // Sync with sidebar state from localStorage
  useEffect(() => {
    const updateSidebarWidth = () => {
      const savedState = localStorage.getItem('sidebarCollapsed')
      if (savedState !== null) {
        const isCollapsed = JSON.parse(savedState)
        setSidebarWidth(isCollapsed ? 64 : 256) // w-16 = 64px, w-64 = 256px
      } else {
        setSidebarWidth(256) // Default to expanded
      }
    }

    updateSidebarWidth()
    
    // Listen for storage changes (when sidebar state changes in other tabs)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'sidebarCollapsed') {
        updateSidebarWidth()
      }
    }

    // Listen for custom event (for same-tab updates)
    const handleSidebarToggle = (e: Event) => {
      const customEvent = e as CustomEvent<boolean>
      if (customEvent.detail !== undefined) {
        setSidebarWidth(customEvent.detail ? 64 : 256)
      }
    }

    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('sidebarToggle', handleSidebarToggle)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('sidebarToggle', handleSidebarToggle as EventListener)
    }
  }, [])

  // Show loading state while checking for projects
  if (isCheckingProject) {
    return <GlobalLoading />
  }

  // Verification wall. Replaces the old behaviour where an untrusted account
  // roamed the dashboard freely and only hit a 403 once it tried to create a
  // project — an error at the worst moment, with no way to resolve it.
  if (standing?.walled) {
    return (
      <VerifyEmailWall
        email={standing.email}
        onLogout={async () => {
          try {
            await logout()
          } finally {
            router.push('/auth/login')
          }
        }}
      />
    )
  }

  return (
    <AppLayoutContent>{children}</AppLayoutContent>
  )
}

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <AppLayoutInternal>{children}</AppLayoutInternal>
    </Suspense>
  )
}

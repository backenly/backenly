'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home } from 'lucide-react'
import { cn } from '@/lib/utils'

export function AppSidebar() {
  const pathname = usePathname()
  const [isHovered, setIsHovered] = useState(false)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const isExpanded = isHovered
  
  useEffect(() => {
    const getProjectId = async () => {
      const stored = localStorage.getItem('current-project-id')
      if (stored) {
        setCurrentProjectId(stored)
        return
      }
      
      const match = pathname?.match(/\/projects\/([a-f0-9-]+)/)
      if (match) {
        setCurrentProjectId(match[1])
        localStorage.setItem('current-project-id', match[1])
        return
      }
      
      try {
        const { getProjects } = await import('@/lib/api/projects')
        const projects = await getProjects()
        if (projects.length > 0) {
          setCurrentProjectId(projects[0].id)
          localStorage.setItem('current-project-id', projects[0].id)
        }
      } catch (error) {
        console.error('Failed to get project ID:', error)
      }
    }
    
    getProjectId()
  }, [pathname])
  
  const normalizedPathname = pathname?.replace(/\/$/, '') || ''
  const overviewHref = currentProjectId ? `/app/projects/${currentProjectId}` : '/app'
  const isOverviewActive = normalizedPathname === overviewHref.replace(/\/$/, '')

  return (
    <aside 
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'fixed left-0 top-12 bottom-0 bg-bg-surface border-r border-border-default overflow-y-auto transition-all duration-200 z-50',
        'flex flex-col scrollbar-hide',
        isExpanded ? 'w-64' : 'w-16'
      )}
    >
      <nav className={cn('flex-1 overflow-y-auto p-3 pb-6 space-y-1 scrollbar-hide', !isExpanded && 'px-2')}>
        <ul className="space-y-1">
          <li className="relative group">
            <Link
              href={overviewHref}
              className={cn(
                'flex items-center rounded-lg transition-all duration-200 relative',
                !isExpanded ? 'justify-center px-3 py-3' : 'px-3 py-2.5',
                isOverviewActive ? 'bg-accent-primary text-white font-medium shadow-sm' : 'text-text-secondary hover:text-text-primary hover:bg-bg-base'
              )}
            >
              <Home className={cn('w-4 h-4 flex-shrink-0', isOverviewActive && 'text-white')} />
              {isExpanded && <span className="ml-3 text-sm">Overview</span>}
            </Link>
            {!isExpanded && (
              <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-50">
                <div className="bg-bg-surface border border-border-default rounded-lg px-3 py-2 text-xs text-text-primary whitespace-nowrap shadow-lg">
                  <div className="font-medium">Overview</div>
                </div>
              </div>
            )}
          </li>
        </ul>
      </nav>
    </aside>
  )
}

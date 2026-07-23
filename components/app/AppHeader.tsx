'use client'

import { User, HelpCircle, LogOut, ChevronDown, Check, FolderOpen, Search } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { Logo } from '@/components/Logo'
import { getProjects, type Project } from '@/lib/api/projects'
import { setCurrentProjectId as setProjectId, clearProjectCache } from '@/lib/api/client'

export function AppHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useParams()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [userData, setUserData] = useState<{ email: string; name: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const userMenuRef = useRef<HTMLDivElement>(null)
  const projectDropdownRef = useRef<HTMLDivElement>(null)

  // Check if we're in a project context
  const isInProject = pathname?.includes('/app/projects/')

  // Fetch current user data, project ID, and all projects
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await fetch('/api/auth/me')
        if (response.ok) {
          const data = await response.json()
          setUserData({
            email: data.user?.email || data.email || 'user@example.com',
            name: data.user?.name || data.name || null
          })
        }
      } catch (error) {
        console.error('Failed to fetch user:', error)
      } finally {
        setLoading(false)
      }
    }
    fetchUser()
    
    // Fetch all projects
    const fetchProjectsList = async () => {
      try {
        const fetchedProjects = await getProjects()
        setProjects(fetchedProjects)
      } catch (error) {
        console.error('Failed to fetch projects:', error)
      }
    }
    fetchProjectsList()
    
    // Get current project ID from localStorage or URL params
    const projectId = (params?.projectId as string) || localStorage.getItem('current-project-id')
    if (projectId) {
      setCurrentProjectId(projectId)
    }
  }, [params])

  // Handle logout
  const handleLogout = async () => {
    try {
      setUserMenuOpen(false)
      
      // Call logout API
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      })
      
      // Clear localStorage
      localStorage.removeItem('auth-token')
      localStorage.removeItem('current-project-id')
      
      // Redirect to login
      router.push('/auth/login')
    } catch (error) {
      console.error('Logout failed:', error)
      // Force redirect even if API fails
      localStorage.clear()
      router.push('/auth/login')
    }
  }

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false)
      }
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(event.target as Node)) {
        setProjectDropdownOpen(false)
      }
    }

    if (userMenuOpen || projectDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [userMenuOpen, projectDropdownOpen])

  // Handle project switch
  const handleProjectSwitch = (projectId: string) => {
    setCurrentProjectId(projectId)
    setProjectId(projectId)
    localStorage.setItem('current-project-id', projectId)
    clearProjectCache()
    setProjectDropdownOpen(false)
    setProjectSearchQuery('')
    
    // If we're in a project context, update the URL to the new project
    if (isInProject && pathname) {
      // Extract the current route after /app/projects/{projectId}/
      const match = pathname.match(/\/app\/projects\/[^\/]+\/(.+)/)
      if (match) {
        const subRoute = match[1]
        router.push(`/app/projects/${projectId}/${subRoute}`)
      } else {
        // If we're just at /app/projects/{projectId}, go to the project overview
        router.push(`/app/projects/${projectId}`)
      }
    } else {
      // If not in project context, navigate to the project overview
      router.push(`/app/projects/${projectId}`)
    }
  }

  // Get current project data
  const currentProject = projects.find(p => p.id === currentProjectId)

  // Filter projects based on search
  const filteredProjects = projects.filter(project =>
    project.name.toLowerCase().includes(projectSearchQuery.toLowerCase())
  )

  return (
    <header className="h-12 border-b border-border-default bg-bg-surface sticky top-0 z-40 shadow-sm">
      <div className="h-full px-6 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {/* Backenly Logo - Simple, No Dropdown */}
          <Link href="/app" className="flex items-center space-x-2 px-3 py-1.5">
            <Logo />
            <span className="text-lg font-semibold text-text-primary">Backenly</span>
          </Link>

          {/* Divider */}
          {isInProject && currentProject && (
            <div className="h-6 w-px bg-border-default"></div>
          )}

          {/* Project Switcher Dropdown (only show in project context) */}
          {isInProject && currentProject && (
            <div className="relative" ref={projectDropdownRef}>
              <button
                onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                className="flex items-center space-x-2 px-3 py-1.5 text-sm text-text-primary hover:bg-bg-base rounded-lg transition-colors border border-border-default hover:border-border-default"
                aria-label="Switch project"
                aria-expanded={projectDropdownOpen}
              >
                <FolderOpen className="w-4 h-4 text-accent-primary" />
                <span className="font-medium">{currentProject.name}</span>
                <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${
                  projectDropdownOpen ? 'rotate-180' : ''
                }`} />
              </button>

              <AnimatePresence>
                {projectDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="absolute left-0 top-full mt-2 w-80 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50 max-h-[400px] overflow-hidden flex flex-col"
                  >
                    {/* Search */}
                    <div className="p-3 border-b border-border-default">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                        <input
                          type="text"
                          placeholder="Search projects..."
                          value={projectSearchQuery}
                          onChange={(e) => setProjectSearchQuery(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 bg-bg-base border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-primary"
                          autoFocus
                        />
                      </div>
                    </div>

                    {/* Project List */}
                    <div className="overflow-y-auto flex-1">
                      <div className="p-2">
                        {filteredProjects.length > 0 ? (
                          filteredProjects.map((project) => (
                            <button
                              key={project.id}
                              onClick={() => handleProjectSwitch(project.id)}
                              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm hover:bg-bg-base transition-colors group"
                            >
                              <div className="flex items-center space-x-3 flex-1 min-w-0">
                                <FolderOpen className="w-4 h-4 text-accent-primary flex-shrink-0" />
                                <div className="flex-1 min-w-0 text-left">
                                  <p className="text-text-primary font-medium truncate">
                                    {project.name}
                                  </p>
                                  {project.description && (
                                    <p className="text-xs text-text-muted truncate">
                                      {project.description}
                                    </p>
                                  )}
                                </div>
                              </div>
                              {project.id === currentProjectId && (
                                <Check className="w-4 h-4 text-accent-primary flex-shrink-0" />
                              )}
                            </button>
                          ))
                        ) : (
                          <div className="px-3 py-8 text-center text-sm text-text-muted">
                            No projects found
                          </div>
                        )}
                      </div>
                    </div>

                    {/* New Project Button */}
                    <div className="p-2 border-t border-border-default">
                      <button
                        onClick={() => {
                          setProjectDropdownOpen(false)
                          router.push('/app')
                        }}
                        className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded-lg text-sm text-accent-primary hover:bg-blue-50 transition-colors font-medium"
                      >
                        <span>View All Projects</span>
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
        
        <div className="flex items-center space-x-4">
          {/* User Menu */}
          <div className="relative" ref={userMenuRef}>
            <button 
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="p-2 text-text-muted hover:text-text-primary hover:bg-bg-base rounded-lg transition-colors"
              aria-label="User menu"
              aria-expanded={userMenuOpen}
            >
              <User className="w-5 h-5" />
            </button>

            <AnimatePresence>
              {userMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="absolute right-0 top-full mt-2 w-64 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50"
                >
                  <div className="p-4 border-b border-border-default">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center">
                        <User className="w-5 h-5 text-accent-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {loading ? 'Loading...' : userData?.email || 'user@example.com'}
                        </p>
                        <p className="text-xs text-text-muted">
                          {userData?.name || 'Account Owner'}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="p-2">
                    <a
                      href="https://docs.backenly.io"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center space-x-3 px-3 py-2 rounded-lg text-sm text-text-secondary hover:text-text-primary hover:bg-bg-base transition-colors"
                    >
                      <HelpCircle className="w-4 h-4" />
                      <span>Help & Support</span>
                    </a>

                    <div className="border-t border-border-default my-2"></div>

                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Log out</span>
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </header>
  )
}


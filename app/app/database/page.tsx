'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, Database as DatabaseIcon, Loader2 } from 'lucide-react'
import { getCurrentProjectId } from '@/lib/api/client'

/**
 * OLD DATABASE ROUTE - DEPRECATED
 * 
 * This route is UNSAFE and has been replaced with project-scoped routes.
 * Users are automatically redirected to the correct project-specific database page.
 * 
 * Reason: Database operations must always be tied to a specific project ID
 * to prevent cross-project data leakage.
 * 
 * New route: /app/projects/[projectId]/database
 */
export default function DatabaseRedirectPage() {
  const router = useRouter()
  const [redirecting, setRedirecting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function redirect() {
      try {
        // Try to get the current project ID
        const projectId = await getCurrentProjectId()
        
        if (projectId) {
          // Redirect to project-scoped database page
          console.log(`✅ Redirecting to project-scoped database: /app/projects/${projectId}/database`)
          router.push(`/app/projects/${projectId}/database`)
        } else {
          // No project selected - redirect to projects page
          console.log(`⚠️ No project selected, redirecting to projects page`)
          setError('No project selected. Please select a project first.')
          setTimeout(() => {
            router.push('/app')
          }, 2000)
        }
      } catch (err: any) {
        console.error('Failed to redirect:', err)
        setError('Failed to determine active project.')
        setTimeout(() => {
          router.push('/app')
        }, 2000)
      }
    }

    redirect()
  }, [router])

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        {/* Warning Card */}
        <div className="bg-gradient-to-br from-yellow-500/10 to-orange-500/10 border-2 border-yellow-500/30 rounded-2xl p-8 shadow-2xl">
          {/* Icon */}
          <div className="flex justify-center mb-6">
            <div className="w-20 h-20 bg-yellow-500/20 rounded-full flex items-center justify-center animate-pulse">
              {redirecting && !error ? (
                <Loader2 className="w-10 h-10 text-yellow-500 animate-spin" />
              ) : (
                <AlertTriangle className="w-10 h-10 text-yellow-500" />
              )}
            </div>
          </div>

          {/* Title */}
          <h1 className="text-3xl font-bold text-center text-white mb-4">
            {redirecting && !error ? 'Redirecting...' : 'Route Deprecated'}
          </h1>

          {/* Message */}
          <div className="bg-black/30 border border-yellow-500/20 rounded-lg p-6 mb-6">
            {error ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-white font-semibold mb-2">{error}</p>
                    <p className="text-text-muted text-sm">
                      Redirecting you to the projects page...
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <DatabaseIcon className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-white font-semibold mb-2">This route has been deprecated</p>
                    <p className="text-text-muted text-sm mb-3">
                      For security and data isolation, database operations must now be accessed through project-specific routes.
                    </p>
                    <div className="bg-black/40 border border-white/10 rounded p-3">
                      <p className="text-xs text-text-muted mb-1">New route format:</p>
                      <code className="text-sm text-indigo-400 font-mono">
                        /app/projects/[projectId]/database
                      </code>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Why This Change */}
          <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-indigo-400" />
              Why This Change?
            </h3>
            <ul className="text-sm text-text-muted space-y-2">
              <li className="flex items-start gap-2">
                <ArrowRight className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                <span><strong className="text-white">100% Project Isolation:</strong> Prevents accidental cross-project operations</span>
              </li>
              <li className="flex items-start gap-2">
                <ArrowRight className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                <span><strong className="text-white">Clear Context:</strong> You always know which project you're working on</span>
              </li>
              <li className="flex items-start gap-2">
                <ArrowRight className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                <span><strong className="text-white">Production-Grade:</strong> Follows BaaS platform best practices</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Auto-redirect notice */}
        {!error && (
          <p className="text-center text-text-muted text-sm mt-6">
            You will be redirected automatically in a moment...
          </p>
        )}
      </div>
    </div>
  )
}

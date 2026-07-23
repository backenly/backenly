'use client'

import { CheckCircleIcon, XCircleIcon, ClockIcon } from '@heroicons/react/24/outline'
import { RocketLaunchIcon } from '@heroicons/react/24/solid'

interface ControlSurfaceProps {
  projectName: string
  projectId: string
  environment?: 'development' | 'production'
  deploymentStatus?: {
    deployed: boolean
    url?: string
    lastDeployedAt?: string
  }
  executionCount?: number
}

export function ControlSurface({
  projectName,
  projectId,
  environment = 'development',
  deploymentStatus,
  executionCount = 0,
}: ControlSurfaceProps) {
  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Never'
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="h-full bg-[#0a0a0a] border-r border-slate-800 flex flex-col">
      {/* Project Context */}
      <div className="p-4 border-b border-slate-800">
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-500"></div>
            <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Project</h3>
          </div>
          <h2 className="text-sm font-semibold text-white truncate">{projectName}</h2>
          <p className="text-[11px] text-slate-500 font-mono truncate">{projectId.slice(0, 8)}</p>
        </div>
      </div>

      {/* Environment Status */}
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Environment</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className={`px-2 py-1 rounded text-[10px] font-medium ${
            environment === 'production'
              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
              : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          }`}>
            {environment === 'production' ? 'Production' : 'Development'}
          </div>
        </div>
      </div>

      {/* Deployment Status */}
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center gap-2 mb-2">
          <RocketLaunchIcon className="w-3.5 h-3.5 text-slate-400" />
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Deployment</h3>
        </div>
        
        {deploymentStatus?.deployed ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircleIcon className="w-4 h-4 text-green-500" />
              <span className="text-xs text-slate-300">Live</span>
            </div>
            {deploymentStatus.url && (
              <a
                href={deploymentStatus.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors block truncate"
              >
                {deploymentStatus.url.replace(/^https?:\/\//, '')}
              </a>
            )}
            {deploymentStatus.lastDeployedAt && (
              <p className="text-[11px] text-slate-500">
                Deployed {formatDate(deploymentStatus.lastDeployedAt)}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <XCircleIcon className="w-4 h-4 text-slate-600" />
              <span className="text-xs text-slate-500">Not deployed</span>
            </div>
            <button className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors">
              Deploy now →
            </button>
          </div>
        )}
      </div>

      {/* Execution Stats */}
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center gap-2 mb-2">
          <ClockIcon className="w-3.5 h-3.5 text-slate-400" />
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Activity</h3>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold text-white">{executionCount}</span>
          <span className="text-xs text-slate-500">executions</span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-auto p-4 border-t border-slate-800">
        <div className="space-y-2">
          <button className="w-full px-3 py-2 text-[11px] font-medium text-slate-400 hover:text-white hover:bg-slate-900 border border-slate-800 rounded transition-colors text-left">
            View Settings
          </button>
          <button className="w-full px-3 py-2 text-[11px] font-medium text-slate-400 hover:text-white hover:bg-slate-900 border border-slate-800 rounded transition-colors text-left">
            Export Backup
          </button>
        </div>
      </div>
    </div>
  )
}

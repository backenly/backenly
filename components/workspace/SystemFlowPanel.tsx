/**
 * System Flow Panel
 * 
 * Visualizes actor interactions and data flows in the system
 */

'use client'

import { Users, ArrowRight, Database } from 'lucide-react'
import type { InteractionGraph } from '@/lib/flow-reasoning'

interface SystemFlowPanelProps {
  flowGraph: InteractionGraph | null
  show?: boolean
}

export function SystemFlowPanel({ flowGraph, show = false }: SystemFlowPanelProps) {
  if (!show || !flowGraph || flowGraph.actors.length === 0) {
    return null
  }

  return (
    <div className="bg-[#1A1F2E] rounded-lg border border-gray-700/50 p-6 mb-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-blue-500/10 rounded-lg">
          <ArrowRight className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">System Flow</h3>
          <p className="text-sm text-gray-400">Actor interactions and data flows</p>
        </div>
      </div>

      {/* Actors */}
      {flowGraph.actors.length > 0 && (
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">Actors</h4>
          <div className="flex flex-wrap gap-2">
            {flowGraph.actors.map((actor) => (
              <div
                key={actor.name}
                className="px-3 py-2 bg-purple-500/10 border border-purple-500/20 rounded-lg"
              >
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-purple-400" />
                  <span className="text-sm font-medium text-purple-300">{actor.name}</span>
                </div>
                {actor.capabilities.length > 0 && (
                  <div className="mt-1 text-xs text-gray-400">
                    Can: {actor.capabilities.slice(0, 3).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interactions */}
      {flowGraph.interactions.length > 0 && (
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">Key Interactions</h4>
          <div className="space-y-2">
            {flowGraph.interactions.slice(0, 4).map((interaction) => (
              <div
                key={interaction.id}
                className="flex items-center gap-3 p-3 bg-gray-800/30 rounded-lg border border-gray-700/30"
              >
                <span className="text-sm text-blue-400 font-medium">{interaction.fromActor}</span>
                <ArrowRight className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-green-400 font-medium">{interaction.toActor}</span>
                <span className="text-xs text-gray-500">•</span>
                <span className="text-xs text-gray-400">{interaction.action}</span>
                {interaction.context && (
                  <>
                    <span className="text-xs text-gray-600">|</span>
                    <span className="text-xs text-gray-500">{interaction.context}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Suggested Entities */}
      {flowGraph.suggestedEntities.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">
            Suggested Entities
          </h4>
          <div className="space-y-2">
            {flowGraph.suggestedEntities.slice(0, 3).map((entity) => (
              <div
                key={entity.name}
                className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Database className="w-4 h-4 text-green-400" />
                  <span className="text-sm font-medium text-green-300">{entity.name}</span>
                </div>
                <p className="text-xs text-gray-400 mb-2">{entity.purpose}</p>
                {entity.relatesTo.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {entity.relatesTo.map((rel) => (
                      <span
                        key={rel}
                        className="px-2 py-0.5 text-xs bg-gray-700/30 text-gray-400 rounded"
                      >
                        {rel}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

/**
 * PHASE 3: INTENT REFLECTION CARD
 * 
 * Pre-execution confirmation UI (Cursor-style)
 * 
 * CRITICAL CONSTRAINTS:
 * - Consumes EXISTING orchestration metadata only
 * - NO new inference or computation
 * - Pure visualization layer
 * - Displayed BEFORE execution commit
 */

import { useState } from 'react'
import {
  CheckCircleIcon,
  PencilSquareIcon,
  XMarkIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline'

export interface IntentReflectionData {
  // From semantic understanding
  intentSummary: string
  entities: string[]
  relationships?: string[]
  capabilities?: string[]
  
  // From confidence evaluation
  confidence: number
  ambiguityScore?: number
  
  // From impact analysis
  impact?: {
    tables?: string[]
    apis?: string[]
    auth?: string[]
    storage?: string[]
    policies?: string[]
  }
  
  // Metadata
  originalPrompt: string
}

interface IntentReflectionCardProps {
  data: IntentReflectionData
  onProceed: () => void
  onEdit: (newPrompt: string) => void
  onCancel: () => void
  isProcessing?: boolean
}

export function IntentReflectionCard({
  data,
  onProceed,
  onEdit,
  onCancel,
  isProcessing = false,
}: IntentReflectionCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState(data.originalPrompt)

  const handleEditSave = () => {
    onEdit(editedPrompt)
    setIsEditing(false)
  }

  const confidenceColor = 
    data.confidence >= 0.8 ? 'text-green-500' :
    data.confidence >= 0.5 ? 'text-yellow-500' :
    'text-red-500'

  const confidenceBg =
    data.confidence >= 0.8 ? 'bg-green-500/10 border-green-500/20' :
    data.confidence >= 0.5 ? 'bg-yellow-500/10 border-yellow-500/20' :
    'bg-red-500/10 border-red-500/20'

  return (
    <div className="bg-slate-900/60 border border-purple-500/30 rounded-xl shadow-lg shadow-purple-500/10 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-600/30 flex items-center justify-center">
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Here's what I understand</h3>
              <p className="text-xs text-slate-400">Review before we build</p>
            </div>
          </div>

          {/* Confidence Indicator */}
          <div className={`px-3 py-1.5 rounded-lg border ${confidenceBg}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-400">Confidence</span>
              <span className={`text-sm font-bold ${confidenceColor}`}>
                {Math.round(data.confidence * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-6 py-5 space-y-5">
        {/* Original Prompt (Editable) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Your Request</label>
            {!isEditing && (
              <button
                onClick={() => setIsEditing(true)}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors flex items-center gap-1"
              >
                <PencilSquareIcon className="w-3 h-3" />
                Edit
              </button>
            )}
          </div>
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleEditSave}
                  className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium rounded transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditedPrompt(data.originalPrompt)
                    setIsEditing(false)
                  }}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white leading-relaxed bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
              {data.originalPrompt}
            </p>
          )}
        </div>

        {/* AI Interpretation */}
        <div>
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">My Understanding</label>
          <p className="text-sm text-slate-300 leading-relaxed">
            {data.intentSummary}
          </p>
        </div>

        {/* Entities Inferred */}
        {data.entities.length > 0 && (
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">
              Entities ({data.entities.length})
            </label>
            <div className="flex flex-wrap gap-2">
              {data.entities.map((entity, idx) => (
                <div
                  key={idx}
                  className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs font-medium text-blue-400"
                >
                  {entity}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Capabilities Affected */}
        {data.capabilities && data.capabilities.length > 0 && (
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">
              Capabilities
            </label>
            <div className="flex flex-wrap gap-2">
              {data.capabilities.map((cap, idx) => (
                <div
                  key={idx}
                  className="px-3 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-lg text-xs font-medium text-purple-400"
                >
                  {cap}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Impact Preview */}
        {data.impact && (
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">
              What will change
            </label>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-2">
              {data.impact.tables && data.impact.tables.length > 0 && (
                <div className="flex items-start gap-2">
                  <CheckCircleIcon className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                  <span className="text-xs text-slate-300">
                    {data.impact.tables.length} table{data.impact.tables.length > 1 ? 's' : ''}: {data.impact.tables.join(', ')}
                  </span>
                </div>
              )}
              {data.impact.apis && data.impact.apis.length > 0 && (
                <div className="flex items-start gap-2">
                  <CheckCircleIcon className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                  <span className="text-xs text-slate-300">
                    {data.impact.apis.length} API{data.impact.apis.length > 1 ? 's' : ''}
                  </span>
                </div>
              )}
              {data.impact.auth && data.impact.auth.length > 0 && (
                <div className="flex items-start gap-2">
                  <CheckCircleIcon className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                  <span className="text-xs text-slate-300">
                    Auth: {data.impact.auth.join(', ')}
                  </span>
                </div>
              )}
              {data.impact.storage && data.impact.storage.length > 0 && (
                <div className="flex items-start gap-2">
                  <CheckCircleIcon className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                  <span className="text-xs text-slate-300">
                    Storage: {data.impact.storage.join(', ')}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Ambiguity Warning */}
        {data.ambiguityScore && data.ambiguityScore > 0.5 && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-3">
            <ExclamationTriangleIcon className="w-5 h-5 text-yellow-500 flex-shrink-0" />
            <div>
              <p className="text-xs font-medium text-yellow-500 mb-1">Some ambiguity detected</p>
              <p className="text-xs text-slate-400">
                You can proceed, but you might want to review the interpretation above.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="px-6 py-4 bg-slate-800/40 border-t border-slate-800 flex items-center justify-end gap-3">
        <button
          onClick={onCancel}
          disabled={isProcessing}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <XMarkIcon className="w-4 h-4" />
          Cancel
        </button>
        
        <button
          onClick={onProceed}
          disabled={isProcessing}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isProcessing ? (
            <>
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Processing...
            </>
          ) : (
            <>
              <CheckCircleIcon className="w-4 h-4" />
              Proceed & Build
            </>
          )}
        </button>
      </div>
    </div>
  )
}

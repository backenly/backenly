'use client'

/**
 * ARCHITECTURE PROPOSAL PANEL (Cursor/Replit Style)
 * 
 * This is NOT a form builder. NOT a checkbox wizard.
 * 
 * This is what a powerful AI architect looks like:
 * - Shows confident interpretation
 * - Displays proposed structure in clean code-style format
 * - Lists explicit assumptions
 * - Offers clear decision buttons (Build / Modify)
 * 
 * DESIGN PHILOSOPHY:
 * - Feels like "AI presenting a draft" not "user filling a form"
 * - Minimal, authoritative, confident
 * - No toggles, no inline editing, no wizard steps
 */

import { useState } from 'react'
import { 
  CubeIcon,
  CheckCircleIcon,
  PencilSquareIcon,
  InformationCircleIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'

interface ProposedEntity {
  name: string
  fields: Array<{
    name: string
    type: string
    required?: boolean
    unique?: boolean
    relationTo?: string
  }>
}

interface ArchitectureProposalPanelProps {
  // From orchestration result
  proposedEntities: ProposedEntity[]
  assumptions: string[]
  message?: string
  
  // Actions
  onConfirm: () => void
  onModify: (feedback: string) => void
  isSubmitting?: boolean
}

export function ArchitectureProposalPanel({
  proposedEntities,
  assumptions,
  message,
  onConfirm,
  onModify,
  isSubmitting = false,
}: ArchitectureProposalPanelProps) {
  const [showModifyInput, setShowModifyInput] = useState(false)
  const [modifyFeedback, setModifyFeedback] = useState('')

  const handleModifySubmit = () => {
    if (modifyFeedback.trim()) {
      onModify(modifyFeedback.trim())
      setModifyFeedback('')
      setShowModifyInput(false)
    }
  }

  return (
    <div className="bg-slate-900/80 border border-slate-700 rounded-xl overflow-hidden">
      {/* HEADER: Title */}
      <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-500/20 flex items-center justify-center">
            <CubeIcon className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">
              Here's what I'm going to build
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Review the proposed architecture
            </p>
          </div>
        </div>
      </div>

      {/* SECTION 1: Summary */}
      {message && (
        <div className="px-5 py-4 border-b border-slate-800/50 bg-slate-900/40">
          <p className="text-sm text-slate-300 leading-relaxed">
            {/* Strip markdown bold markers for cleaner display */}
            {message.split('\n')[0].replace(/\*\*/g, '')}
          </p>
        </div>
      )}

      {/* SECTION 2: Proposed Structure (Code-style block) */}
      <div className="px-5 py-4 border-b border-slate-800/50">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Proposed Schema
        </h3>
        
        <div className="space-y-4">
          {proposedEntities.map((entity) => (
            <div 
              key={entity.name}
              className="bg-slate-950/60 rounded-lg border border-slate-800 overflow-hidden"
            >
              {/* Entity Name Header */}
              <div className="px-4 py-2.5 bg-slate-800/50 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="text-purple-400 font-mono text-sm font-semibold">
                    {entity.name}
                  </span>
                  <span className="text-slate-500 text-xs">
                    table
                  </span>
                </div>
              </div>
              
              {/* Fields - Code Style */}
              <div className="px-4 py-3">
                <div className="font-mono text-sm space-y-1.5">
                  {entity.fields
                    .filter(f => f.name !== 'id' && f.name !== 'created_at' && f.name !== 'updated_at')
                    .map((field) => (
                      <div key={field.name} className="flex items-center gap-3">
                        <ChevronRightIcon className="w-3 h-3 text-slate-600 flex-shrink-0" />
                        <span className="text-slate-300">{field.name}</span>
                        <span className="text-slate-600">:</span>
                        <span className={field.type === 'relation' ? 'text-blue-400' : 'text-amber-500'}>
                          {field.type === 'relation' ? `→ ${field.relationTo}` : field.type}
                        </span>
                        {field.required && (
                          <span className="text-red-400/60 text-xs">required</span>
                        )}
                        {field.unique && (
                          <span className="text-purple-400/60 text-xs">unique</span>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 3: Assumptions */}
      {assumptions && assumptions.length > 0 && (
        <div className="px-5 py-4 border-b border-slate-800/50 bg-slate-900/30">
          <div className="flex items-start gap-2 mb-2">
            <InformationCircleIcon className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
            <h3 className="text-xs font-semibold text-slate-400">
              This assumes:
            </h3>
          </div>
          <ul className="ml-6 space-y-1">
            {assumptions.map((assumption, idx) => (
              <li key={idx} className="text-sm text-slate-400 flex items-start gap-2">
                <span className="text-slate-600">•</span>
                <span>{assumption}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* SECTION 4: Decision Buttons */}
      <div className="px-5 py-4 bg-slate-900/60">
        {!showModifyInput ? (
          <div className="flex items-center gap-3">
            {/* PRIMARY: Build this */}
            <button
              onClick={onConfirm}
              disabled={isSubmitting}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold text-sm transition-colors"
            >
              <CheckCircleIcon className="w-5 h-5" />
              {isSubmitting ? 'Building...' : 'Build this'}
            </button>
            
            {/* SECONDARY: Modify */}
            <button
              onClick={() => setShowModifyInput(true)}
              disabled={isSubmitting}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800 disabled:cursor-not-allowed text-slate-300 font-medium text-sm transition-colors border border-slate-700"
            >
              <PencilSquareIcon className="w-4 h-4" />
              Modify
            </button>
          </div>
        ) : (
          /* MODIFY MODE: Conversational refinement (not visual editing) */
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Tell me what should change:
            </p>
            <textarea
              value={modifyFeedback}
              onChange={(e) => setModifyFeedback(e.target.value)}
              placeholder="e.g., Add a rating field, make it link to products instead..."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-600 focus:border-transparent resize-none"
              rows={3}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleModifySubmit}
                disabled={!modifyFeedback.trim() || isSubmitting}
                className="flex-1 px-4 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold text-sm transition-colors"
              >
                Update proposal
              </button>
              <button
                onClick={() => {
                  setShowModifyInput(false)
                  setModifyFeedback('')
                }}
                className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

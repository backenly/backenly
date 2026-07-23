/**
 * Integration Options Panel
 * 
 * Displays architectural integration choices to the user
 * before executing backend changes. Enables collaborative
 * architecture decisions.
 */

'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface IntegrationOption {
  id: string
  title: string
  description: string
  complexity: 'simple' | 'moderate' | 'complex'
  changes: {
    newEntities: string[]
    modifiedEntities: string[]
    newRelations: Array<{ from: string; to: string; type: string }>
    capabilities: string[]
  }
  reasoning: string
  tradeoffs: {
    pros: string[]
    cons: string[]
  }
  recommended: boolean
}

interface IntegrationOptionsPanelProps {
  options: IntegrationOption[]
  onSelect: (optionId: string) => void
  onCancel: () => void
}

export default function IntegrationOptionsPanel({
  options,
  onSelect,
  onCancel,
}: IntegrationOptionsPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    options.find(o => o.recommended)?.id || null
  )
  const [expanded, setExpanded] = useState<string | null>(null)

  const complexityColor = {
    simple: 'text-green-400',
    moderate: 'text-yellow-400',
    complex: 'text-orange-400',
  }

  const complexityBg = {
    simple: 'bg-green-400/10 border-green-400/20',
    moderate: 'bg-yellow-400/10 border-yellow-400/20',
    complex: 'bg-orange-400/10 border-orange-400/20',
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="w-full max-w-4xl mx-auto mb-8"
    >
      {/* Header */}
      <div className="mb-6">
        <h3 className="text-xl font-semibold text-white mb-2">
          Choose Your Integration Strategy
        </h3>
        <p className="text-gray-400 text-sm">
          Multiple ways to add these changes. Select the approach that fits your needs.
        </p>
      </div>

      {/* Options Grid */}
      <div className="space-y-4">
        {options.map((option) => {
          const isSelected = selectedId === option.id
          const isExpanded = expanded === option.id

          return (
            <motion.div
              key={option.id}
              layout
              className={`
                relative rounded-lg border transition-all duration-200 overflow-hidden
                ${isSelected
                  ? 'border-purple-500 bg-purple-500/5'
                  : 'border-gray-700 bg-gray-800/30 hover:border-gray-600'
                }
              `}
            >
              {/* Recommended Badge */}
              {option.recommended && (
                <div className="absolute top-3 right-3">
                  <span className="px-2 py-1 text-xs font-medium bg-purple-500/20 text-purple-300 rounded border border-purple-500/30">
                    Recommended
                  </span>
                </div>
              )}

              {/* Main Content */}
              <div
                className="p-5 cursor-pointer"
                onClick={() => setSelectedId(option.id)}
              >
                <div className="flex items-start gap-4">
                  {/* Radio Button */}
                  <div className="flex-shrink-0 mt-1">
                    <div
                      className={`
                        w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all
                        ${isSelected
                          ? 'border-purple-500 bg-purple-500'
                          : 'border-gray-600'
                        }
                      `}
                    >
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="w-2 h-2 bg-white rounded-full"
                        />
                      )}
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {/* Title & Complexity */}
                    <div className="flex items-center gap-3 mb-2">
                      <h4 className="text-base font-semibold text-white">
                        {option.title}
                      </h4>
                      <span
                        className={`
                          px-2 py-0.5 text-xs font-medium rounded border
                          ${complexityBg[option.complexity]} ${complexityColor[option.complexity]}
                        `}
                      >
                        {option.complexity}
                      </span>
                    </div>

                    {/* Description */}
                    <p className="text-sm text-gray-400 mb-3">
                      {option.description}
                    </p>

                    {/* Quick Stats */}
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      {option.changes.newEntities.length > 0 && (
                        <span>
                          +{option.changes.newEntities.length} table
                          {option.changes.newEntities.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {option.changes.newRelations.length > 0 && (
                        <span>
                          +{option.changes.newRelations.length} relation
                          {option.changes.newRelations.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {option.changes.modifiedEntities.length > 0 && (
                        <span className="text-yellow-500">
                          ~{option.changes.modifiedEntities.length} modified
                        </span>
                      )}
                    </div>

                    {/* Expand/Collapse Toggle */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpanded(isExpanded ? null : option.id)
                      }}
                      className="mt-3 text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
                    >
                      {isExpanded ? 'Hide' : 'Show'} details
                      <svg
                        className={`w-3 h-3 transition-transform ${
                          isExpanded ? 'rotate-180' : ''
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              {/* Expanded Details */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="border-t border-gray-700"
                  >
                    <div className="p-5 space-y-4 bg-black/20">
                      {/* Reasoning */}
                      <div>
                        <h5 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                          Reasoning
                        </h5>
                        <p className="text-sm text-gray-300">{option.reasoning}</p>
                      </div>

                      {/* Tradeoffs */}
                      <div className="grid grid-cols-2 gap-4">
                        {/* Pros */}
                        <div>
                          <h5 className="text-xs font-semibold text-green-400 uppercase mb-2">
                            Pros
                          </h5>
                          <ul className="space-y-1">
                            {option.tradeoffs.pros.map((pro, i) => (
                              <li key={i} className="text-sm text-gray-400 flex items-start gap-2">
                                <span className="text-green-400 mt-0.5">✓</span>
                                <span>{pro}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Cons */}
                        <div>
                          <h5 className="text-xs font-semibold text-orange-400 uppercase mb-2">
                            Cons
                          </h5>
                          <ul className="space-y-1">
                            {option.tradeoffs.cons.map((con, i) => (
                              <li key={i} className="text-sm text-gray-400 flex items-start gap-2">
                                <span className="text-orange-400 mt-0.5">−</span>
                                <span>{con}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Changes Detail */}
                      {option.changes.newEntities.length > 0 && (
                        <div>
                          <h5 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                            New Tables
                          </h5>
                          <div className="flex flex-wrap gap-2">
                            {option.changes.newEntities.map((entity) => (
                              <span
                                key={entity}
                                className="px-2 py-1 text-xs font-mono bg-blue-500/10 text-blue-400 rounded border border-blue-500/20"
                              >
                                {entity}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Relations */}
                      {option.changes.newRelations.length > 0 && (
                        <div>
                          <h5 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                            Relations
                          </h5>
                          <div className="space-y-1">
                            {option.changes.newRelations.map((rel, i) => (
                              <div
                                key={i}
                                className="text-xs font-mono text-gray-400 flex items-center gap-2"
                              >
                                <span className="text-purple-400">{rel.from}</span>
                                <span className="text-gray-600">→</span>
                                <span className="text-green-400">{rel.to}</span>
                                <span className="text-gray-600 text-[10px]">
                                  ({rel.type})
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between mt-6 pt-6 border-t border-gray-700">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>

        <button
          onClick={() => selectedId && onSelect(selectedId)}
          disabled={!selectedId}
          className={`
            px-6 py-2.5 text-sm font-medium rounded-lg transition-all
            ${selectedId
              ? 'bg-purple-600 hover:bg-purple-700 text-white'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }
          `}
        >
          Proceed with this approach
        </button>
      </div>
    </motion.div>
  )
}

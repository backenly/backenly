'use client'

/**
 * AI Explanation Component
 * 
 * Displays human-readable explanations of what changed during AI execution.
 * Shown BEFORE technical logs to help users understand without diving into details.
 * 
 * Tone: Confident, calm, non-technical
 */

import { AlertCircle, CheckCircle, Info } from 'lucide-react'

interface AIExplanation {
  summary: string
  details: string[]
  impact: string
  confidence: 'high' | 'medium' | 'low'
  userFacing: boolean
}

interface AIExplanationPanelProps {
  explanation: AIExplanation
  className?: string
}

export function AIExplanationPanel({ explanation, className = '' }: AIExplanationPanelProps) {
  return (
    <div className={`bg-gradient-to-br from-[#1E1E1E] to-[#252525] border border-[#2A2A2A] rounded-lg p-6 ${className}`}>
      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
        <div className="mt-0.5">
          {explanation.userFacing ? (
            <CheckCircle className="w-5 h-5 text-[#10B981]" />
          ) : (
            <Info className="w-5 h-5 text-[#6B7280]" />
          )}
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-white mb-1">
            What Changed
          </h3>
          <p className="text-[#D1D5DB] text-sm leading-relaxed">
            {explanation.summary}
          </p>
        </div>
      </div>

      {/* Details */}
      {explanation.details.length > 0 && (
        <div className="ml-8 mb-4 space-y-2">
          {explanation.details.map((detail, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#6B7280] mt-1.5 flex-shrink-0" />
              <p className="text-sm text-[#9CA3AF]">{detail}</p>
            </div>
          ))}
        </div>
      )}

      {/* Impact */}
      <div className="ml-8 p-4 bg-[#111111] rounded-lg border border-[#2A2A2A]">
        <p className="text-sm text-[#D1D5DB] leading-relaxed">
          <span className="text-[#10B981] font-medium">Ready: </span>
          {explanation.impact}
        </p>
      </div>

      {/* Confidence indicator (subtle) */}
      {explanation.confidence !== 'high' && (
        <div className="mt-4 ml-8 flex items-center gap-2 text-xs text-[#6B7280]">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>
            {explanation.confidence === 'medium' 
              ? 'Some assumptions were made. Verify behavior if needed.'
              : 'Low confidence. Review changes carefully.'}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Compact version for run logs list
 */
interface AIExplanationInlineProps {
  explanation: AIExplanation
  className?: string
}

export function AIExplanationInline({ explanation, className = '' }: AIExplanationInlineProps) {
  return (
    <div className={`flex items-start gap-2 ${className}`}>
      <CheckCircle className="w-4 h-4 text-[#10B981] mt-0.5 flex-shrink-0" />
      <div>
        <p className="text-sm text-[#D1D5DB]">{explanation.summary}</p>
        {explanation.details.length > 0 && (
          <p className="text-xs text-[#6B7280] mt-1">
            {explanation.details.slice(0, 2).join(' · ')}
            {explanation.details.length > 2 && ' · ...'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Empty state when no explanation available
 */
export function NoExplanationState({ className = '' }: { className?: string }) {
  return (
    <div className={`p-4 bg-[#1E1E1E] border border-[#2A2A2A] rounded-lg ${className}`}>
      <div className="flex items-center gap-2 text-[#6B7280]">
        <Info className="w-4 h-4" />
        <p className="text-sm">No changes detected</p>
      </div>
    </div>
  )
}

/**
 * Example usage in run details page:
 * 
 * ```tsx
 * import { AIExplanationPanel } from '@/components/ai/AIExplanationPanel'
 * 
 * export default function RunDetailsPage() {
 *   const { run } = useRun()
 *   
 *   return (
 *     <div>
 *       <h1>Run Details</h1>
 *       
 *       {run.aiExplanation && (
 *         <AIExplanationPanel 
 *           explanation={run.aiExplanation}
 *           className="mb-6"
 *         />
 *       )}
 *       
 *       <TechnicalLogsSection logs={run.logs} />
 *     </div>
 *   )
 * }
 * ```
 */

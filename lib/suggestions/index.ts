/**
 * Backenly Suggestion Layer
 * 
 * Non-mutating, graph-observational advisory system.
 * Like a senior backend engineer reviewing your schema in real-time.
 * 
 * EXPORTS:
 * - generateSuggestions: Analyze graph and generate suggestions
 * - storeSuggestions: Persist suggestions for a graph version
 * - getActiveSuggestions: Get current suggestions for project
 * - clearInactiveSuggestions: Clean up after undo
 */

export {
  generateSuggestions,
  type Suggestion,
  type SuggestionContext,
} from './suggestion-engine'

export {
  storeSuggestions,
  getActiveSuggestions,
  getSuggestionHistory,
  clearInactiveSuggestions,
  type StoredSuggestion,
} from './suggestion-store'

/**
 * What the two places a person decides on an architecture change share: the
 * "Waiting on you" row (./EvolutionRequestRow.tsx) and the Architecture
 * changes card (./ArchitectureChangesPanel.tsx).
 *
 * They read different payloads on their own schedules, so a decision in one
 * would leave the other showing the change as it was until a reload: approving
 * a first change made it vanish from the page, because the card it moves to was
 * read before it existed. Each announces a decision it made; the other re-reads.
 */

export const ARCHITECTURE_CHANGED = 'backenly:architecture-changed'

/** Which surface made the decision: it has already re-read for itself. */
export type DecisionSurface = 'queue' | 'card'

export function announceArchitectureChange(from: DecisionSurface): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(ARCHITECTURE_CHANGED, { detail: { from } }))
}

/** Re-read when the OTHER surface decided something. Returns the unsubscribe. */
export function onArchitectureChange(self: DecisionSurface, reread: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => {
    if ((e as CustomEvent<{ from?: DecisionSurface }>).detail?.from !== self) reread()
  }
  window.addEventListener(ARCHITECTURE_CHANGED, listener)
  return () => window.removeEventListener(ARCHITECTURE_CHANGED, listener)
}

/**
 * The words for a decision the person's role does not allow. Every decision
 * route for architecture changes needs an organization admin
 * (app/api/projects/[id]/architecture), and the platform's own refusal reads
 * "Project not found or access denied", which says neither.
 */
export const ADMIN_ONLY = 'Only an organization admin can decide architecture changes.'

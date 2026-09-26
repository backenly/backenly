import type { GuideProgress } from '@/lib/onboarding/guide'

/**
 * How often a surface showing the guide should re-read it.
 *
 * Fast only while the user is looking at a step that completes on its own: an
 * agent's first call, the first build, a running publish, the first autonomy
 * check. Those are the moments "it updates as you go" has to be true within a
 * few seconds. Everything else can wait half a minute.
 */
export function guidePollMs(progress: GuideProgress | null | undefined, onScreen: boolean): number {
  if (!progress || progress.allDone) return 60_000
  const current = progress.steps.find((s) => s.id === progress.currentStepId)
  const awaitingEvidence =
    !!current &&
    (current.id === 'agent' || current.id === 'backend' || current.status === 'waiting' || current.status === 'in_progress')
  return onScreen && awaitingEvidence ? 5_000 : 30_000
}

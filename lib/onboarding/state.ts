/**
 * The Getting Started guide, as the API serves it: whether it shows, and if so
 * what is done and what comes next.
 *
 * Facts are collected only while the guide is visible. An existing account that
 * never opened it costs one indexed row read per page load, not a sweep of its
 * keys and usage.
 */

import { getProjectLifecycle } from '@/lib/edition'
import { recordProductEvent } from '@/lib/platform-signals'
import { collectGuideFacts, type VisibleProject } from './facts'
import {
  deriveGuide,
  guideAudience,
  isGuideVisible,
  unreportedCompletions,
  type GuideAction,
  type GuideProgress,
  type GuideState,
  type StepId,
} from './guide'
import {
  claimStart,
  claimStepReport,
  dismissGuide,
  readPreference,
  reopenGuide,
  type StoredPreference,
} from './preference'

export interface GuideCaller {
  userId: string
  createdAt: Date
}

async function visibleProjects(userId: string): Promise<VisibleProject[]> {
  const list = await getProjectLifecycle().list(userId)
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    projectStatus: p.projectStatus,
    deployedAt: p.deployedAt,
  }))
}

async function progressFor(caller: GuideCaller, projects: VisibleProject[]): Promise<GuideProgress> {
  return deriveGuide(await collectGuideFacts(caller.userId, projects))
}

export async function loadGuideState(caller: GuideCaller): Promise<GuideState> {
  const [pref, projects] = await Promise.all([readPreference(caller.userId), visibleProjects(caller.userId)])
  const audience = guideAudience(caller.createdAt, projects.map((p) => p.createdAt))
  const visible = isGuideVisible(pref, audience)
  const progress = visible ? await progressFor(caller, projects) : null

  if (visible && progress && pref.available) await reportMilestones(caller.userId, pref, progress)

  return { visible, audience, savable: pref.available, progress }
}

/**
 * Funnel bookkeeping. Each milestone is claimed with a conditional write before
 * it is reported, so a guide polled from three tabs still counts it once.
 * Never allowed to fail the read it rides on.
 */
async function reportMilestones(userId: string, pref: StoredPreference, progress: GuideProgress): Promise<void> {
  try {
    if (!pref.startedAt && (await claimStart(userId))) {
      recordProductEvent({ type: 'onboarding_started', userId, metadata: { completed: progress.completed, total: progress.total } })
    }
    for (const step of unreportedCompletions(progress, pref.reportedSteps)) {
      if (await claimStepReport(userId, step)) {
        recordProductEvent({
          type: 'onboarding_step_completed',
          userId,
          projectId: progress.focus?.id ?? null,
          metadata: { step, completed: progress.completed, total: progress.total },
        })
      }
    }
  } catch (err: any) {
    console.error('[onboarding] milestone bookkeeping failed:', err?.message ?? err)
  }
}

export async function hideGuide(caller: GuideCaller): Promise<GuideState> {
  const projects = await visibleProjects(caller.userId)
  const progress = await progressFor(caller, projects)
  await dismissGuide(caller.userId)
  recordProductEvent(
    progress.allDone
      ? { type: 'onboarding_completed', userId: caller.userId, projectId: progress.focus?.id ?? null }
      : {
          type: 'onboarding_dismissed',
          userId: caller.userId,
          metadata: { step: progress.currentStepId, completed: progress.completed, total: progress.total },
        },
  )
  return loadGuideState(caller)
}

export async function showGuide(caller: GuideCaller): Promise<GuideState> {
  await reopenGuide(caller.userId)
  recordProductEvent({ type: 'onboarding_reopened', userId: caller.userId })
  return loadGuideState(caller)
}

export function trackGuideAction(caller: GuideCaller, action: GuideAction, step: StepId | null): void {
  recordProductEvent({ type: 'onboarding_action', userId: caller.userId, metadata: { action, step } })
}

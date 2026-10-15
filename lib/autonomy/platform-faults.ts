/**
 * Faults that belong to the platform, reported to the people who run it.
 *
 * The contract sweep used to have one place to put a failure: a finding on the
 * tenant's project, which the observer then emailed to the tenant. So when the
 * web task could not reach its own runtime, every customer with a built
 * project was told their backend was broken and asked to "review and approve
 * fixes" for an outage that was ours and had no fix they could approve.
 *
 * This is the other place. A platform fault goes to the operator (log line and
 * Sentry, which is already initialised by instrumentation.ts) and to nobody
 * else. It never writes a HealthFinding and never notifies a tenant.
 */

import * as Sentry from '@sentry/nextjs'
import { HOME_REGION } from '@/lib/regions'

export interface PlatformFaultReport {
  /** Stable machine name, e.g. `ingress_unreachable`, `surface_failing_fleetwide`. */
  kind: string
  detail: string
  surface?: string
  status?: number | 'timeout'
  /** Projects whose probes were affected, when known. */
  projectIds?: string[]
  origin?: string
  /** The region whose data plane the fault is in, when it is one region's. */
  region?: string
}

export function reportPlatformFault(fault: PlatformFaultReport): void {
  const where = fault.surface ? ` surface=${fault.surface}` : ''
  const affected = fault.projectIds ? ` projects=${fault.projectIds.length}` : ''
  const region = fault.region ? ` region=${fault.region}` : ''
  console.error(`[PlatformFault] ${fault.kind}${region}${where}${affected} — ${fault.detail}`)
  try {
    Sentry.captureMessage(`Platform fault: ${fault.kind}${where}`, {
      level: 'error',
      // One Sentry issue per kind of fault, not one per sweep.
      // A region outside home is its own incident; home keeps the grouping it had.
      fingerprint: [
        'platform-fault', fault.kind, fault.surface ?? '*', String(fault.status ?? '*'),
        ...(fault.region && fault.region !== HOME_REGION ? [fault.region] : []),
      ],
      extra: {
        detail: fault.detail,
        origin: fault.origin,
        region: fault.region ?? null,
        affectedProjects: fault.projectIds?.length ?? null,
        sampleProjectIds: fault.projectIds?.slice(0, 10) ?? [],
      },
    })
  } catch {
    /* reporting must never take the sweep down */
  }
}

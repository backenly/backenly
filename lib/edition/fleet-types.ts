/**
 * FLEET SCHEDULER: WHICH PROJECTS DOES A BACKGROUND PASS RUN AGAINST
 * ==================================================================
 * The fourth edition seam, and the narrowest on purpose.
 *
 * ---- THE CUT LINE --------------------------------------------------------
 *
 * Running the reconciler against ONE project is the product. Deciding WHICH
 * projects to run it against is the control plane. Every scheduled sweep in
 * Backenly was written as one function that did both:
 *
 *   const projects = await prisma.project.findMany({ where: activeProjectsWhere() })
 *   for (const p of projects) await runReconciler(p.id)
 *
 * The second line is public product and stays. The first is fleet
 * enumeration, and on a self-hosted deployment it is simply the wrong
 * question: there is one project, its id is known, and scanning a table to
 * rediscover it means a stray row gets swept, healed and billed as though it
 * belonged to the operator.
 *
 * ---- WHY IT IS NOT A DATABASE SERVICE ------------------------------------
 *
 * This interface answers "which projects", and nothing else. It does not
 * fetch project data, it does not run anything, and it has no method that
 * takes a `where`. A seam that accepted arbitrary filters would be a Prisma
 * client with extra steps, and the public product would be back to knowing how
 * to query the fleet -- which is the thing being moved.
 *
 * The ELIGIBILITY rule (lib/autonomy/activity-gate.ts) stays public and is
 * shared by both implementations. "Is this backend alive" is a product
 * question with one correct answer; only the SET it is applied to differs.
 */
import type { Edition } from './types'

/**
 * A project a scheduled pass should visit.
 *
 * `userId` is carried because several sweeps run model-backed work billed to
 * an owner and would otherwise need a second query per project. It is null for
 * an owner-less project, which is the state a self-hosted deployment is in
 * between bootstrap and the first operator signing up.
 */
export interface FleetTarget {
  id: string
  userId: string | null
}

export interface FleetTargetOptions {
  /**
   * How far back the activity gate looks.
   *
   * Varies by sweep -- the cheap, frequent ones look back further than the
   * expensive daily ones -- but the DEFINITION of activity must not, which is
   * why only the window is a parameter and the predicate is not.
   */
  windowDays?: number
}

export interface FleetScheduler {
  readonly edition: Edition

  /**
   * Projects eligible for a background pass right now.
   *
   * Single-tenant resolves THE project and applies the activity gate to it.
   * Cloud enumerates. Both return [] rather than throwing when there is
   * nothing to do: a scheduled tick that throws on an empty fleet turns a
   * quiet night into a crash loop.
   */
  activeTargets(options?: FleetTargetOptions): Promise<FleetTarget[]>

  /**
   * Projects a maintenance sweep covers, with no activity gate.
   *
   * Distinct from `activeTargets` because measurement and cleanup are not
   * healing. A project nobody has touched in six months still occupies disk
   * and still has its storage measured; it just does not get a reconciler
   * pass. Collapsing the two would either bill for space nobody measured or
   * spend model budget on abandoned backends.
   */
  maintenanceTargets(): Promise<FleetTarget[]>
}

/**
 * EACH REGION'S PROJECTS ARE SERVED IN THAT REGION
 * ================================================
 * A project's data lives in its region (lib/data-plane/regional.ts), and its
 * API is handed out at that region's address (projectApiOrigin). This module
 * makes the serving side match: a process serves the data plane of ONE region,
 * `BACKENLY_SERVICE_REGION` (unset: the home region, as every deployment has
 * been), and
 *
 *   - a data-plane request (/api/v1/{projectId}, /api/v2/{projectId}) for a
 *     project of another region is answered 421 WRONG_REGION with the project's
 *     address, never served from here. The home service could reach a regional
 *     database over peering and answer, but then a regional project's traffic
 *     would quietly run through Mumbai, and a regional outage would look like
 *     a working project served from somewhere else (founders, 2026-10-16:
 *     "never silently route a regional project to Mumbai");
 *   - background passes take only this region's projects (servedHere), so each
 *     region's own worker checks, repairs and backs up its own projects and a
 *     fleet pass never runs across regions by accident.
 *
 * Control-plane work is not data-plane serving: the console, MCP and the
 * admin tools reach a regional database over peering on purpose, and nothing
 * here stops them.
 */

import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { isRegionError, projectApiOrigin, projectRegion } from '@/lib/data-plane/regional'
import { HOME_REGION, findRegion, type CloudRegionId } from '@/lib/regions'

type Env = Readonly<Record<string, string | undefined>>

/** BACKENLY_SERVICE_REGION names no region this build knows. */
export class UnknownServiceRegionError extends Error {
  readonly code = 'UNKNOWN_SERVICE_REGION'

  constructor(readonly configured: string) {
    super(`BACKENLY_SERVICE_REGION is "${configured}", which this build does not know. This process serves no region until it is fixed.`)
    this.name = 'UnknownServiceRegionError'
  }
}

/**
 * The region whose data plane this process serves. Unset is the home region.
 * A value that names no known region throws: a typo must not quietly make a
 * regional service serve the home region's projects, or none at all.
 */
export function serviceRegion(env: Env = process.env): CloudRegionId {
  const raw = env.BACKENLY_SERVICE_REGION?.trim()
  if (!raw) return HOME_REGION
  const region = findRegion(raw)
  if (!region) throw new UnknownServiceRegionError(raw)
  return region.id
}

/** Whether this process serves the region a project's data lives in. */
export async function servedHere(projectId: string, env: Env = process.env): Promise<boolean> {
  return (await projectRegion(projectId)) === serviceRegion(env)
}

/**
 * Split targets into those this process serves and those another region's
 * does, with one platform query for the lot. A project whose row records a
 * region this build does not know stays in `served`, so the reachability check
 * that follows (partitionReachable) reports it rather than it vanishing here.
 */
export async function partitionServed<T extends { id: string }>(
  targets: T[],
  env: Env = process.env,
): Promise<{ served: T[]; elsewhere: T[] }> {
  const here = serviceRegion(env)
  if (targets.length === 0) return { served: [], elsewhere: [] }
  const rows = await prisma.project.findMany({
    where: { id: { in: [...new Set(targets.map((t) => t.id))] } },
    select: { id: true, region: true },
  })
  const recorded = new Map(rows.map((row) => [row.id, row.region]))

  const served: T[] = []
  const elsewhere: T[] = []
  for (const target of targets) {
    const region = findRegion(recorded.get(target.id) ?? HOME_REGION)
    if (!region || region.id === here) served.push(target)
    else elsewhere.push(target)
  }
  return { served, elsewhere }
}

/**
 * The platform-database filter for the projects whose data `region` holds:
 * those recording it and, for the home region, those recording none, every
 * project created before regions. A project recording a region this build
 * does not know matches no region's filter, so a pass that acts on one
 * region's storage, a bucket's sweep say, never judges it against another's.
 */
export function heldInRegionWhere(region: CloudRegionId): Prisma.ProjectWhereInput {
  return region === HOME_REGION ? { OR: [{ region: null }, { region: HOME_REGION }] } : { region }
}

export const WRONG_REGION = 'WRONG_REGION'

/** A refusal, as status and body, for whichever server answers it. */
export interface Misdirection {
  status: number
  body: Record<string, unknown>
}

/**
 * Why this process must not serve a data-plane request for `projectId`, or
 * null when the project is this region's:
 *   421 WRONG_REGION   another region's project; names the region and, when
 *                      this process knows it, the address to use instead
 *   500                BACKENLY_SERVICE_REGION names no known region
 *   503                the project's row names a region this build does not know
 */
export async function misdirection(
  projectId: string,
  homeOrigin: string,
  env: Env = process.env,
): Promise<Misdirection | null> {
  let here: CloudRegionId
  try {
    here = serviceRegion(env)
  } catch (err) {
    return {
      status: 500,
      body: { success: false, error: 'This service is misconfigured and serves no region.', code: (err as UnknownServiceRegionError).code },
    }
  }
  let region: CloudRegionId
  try {
    region = await projectRegion(projectId)
  } catch (err) {
    // A row naming a region this build does not know is served nowhere.
    if (isRegionError(err)) {
      return { status: 503, body: { success: false, error: "This project's data region is not reachable from this server.", code: err.code } }
    }
    // The lookup itself failed (the platform database is unreachable). The
    // route goes ahead and fails on its own terms: every connection it opens
    // to the project's data resolves the region again, so nothing can be served
    // from the wrong region because this check could not run.
    console.warn(`[serving] region lookup failed for ${projectId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  if (region === here) return null

  // The address is a courtesy for the client; a process that has none for the
  // region still refuses, it just cannot say where to go.
  const apiUrl = await projectApiOrigin(projectId, homeOrigin).then(
    (origin) => `${origin}/api/v1/${projectId}`,
    () => null,
  )
  return {
    status: 421,
    body: {
      success: false,
      error: `This project's data is in ${region}, and it is served only there.`,
      code: WRONG_REGION,
      region,
      apiUrl,
    },
  }
}

/** misdirection, as the response a Next route returns. */
export async function misdirectedResponse(
  projectId: string,
  homeOrigin: string,
  env: Env = process.env,
): Promise<NextResponse | null> {
  const refusal = await misdirection(projectId, homeOrigin, env)
  return refusal ? NextResponse.json(refusal.body, { status: refusal.status }) : null
}

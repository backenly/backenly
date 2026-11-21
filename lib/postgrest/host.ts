/**
 * The address of a region's PostgREST host, for projects with a database of
 * their own.
 *
 * PostgREST serves one database per process, so a project whose data is in a
 * database of its own (`p_<32 hex>`) is served by its own PostgREST process,
 * run by the region's PostgREST host (services/pgrst-host). The host serves
 * each project under /p/<projectId>/, so the address returned here takes the
 * place of the region's PostgREST URL for that project, and every request path
 * appended to it (upstreamUrl in gateway.ts) reaches the project's own process.
 *
 * Named like every other per-region setting (lib/data-plane/regional.ts):
 * PGRST_HOST_URL in the home region, PGRST_HOST_URL_<REGION> elsewhere, e.g.
 * PGRST_HOST_URL_US_EAST_1. Never the home value for another region: that host
 * reaches the home region's databases only.
 *
 * Tokens for the host carry `aud` and `db` (internalClaimsFor's `database`),
 * signed with the region's POSTGREST_JWT_SECRET[_REGION], which the host
 * shares. Projects in the region's shared database keep regionPostgrest.
 */

import { RegionNotConfiguredError, regionSetting } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'
import { profileForProject } from './gateway'

/** The setting holding a region's PostgREST host address. */
export const PGRST_HOST_URL_SETTING = 'PGRST_HOST_URL'

type Env = Readonly<Record<string, string | undefined>>

/**
 * The region's PostgREST host base address (no trailing slash), or null when
 * this process has none. A value that is not a plain http(s) address is an
 * error naming the variable rather than an address guessed from it.
 */
export function regionPostgrestHostUrl(region: CloudRegionId, env: Env = process.env): string | null {
  const { variable, value } = regionSetting(PGRST_HOST_URL_SETTING, region, env)
  if (!value) return null
  let url: URL | null = null
  try {
    url = new URL(value.trim())
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new RegionNotConfiguredError(region, variable, undefined, `${variable} is not an http(s) URL.`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RegionNotConfiguredError(
      region,
      variable,
      undefined,
      `${variable} must be a plain address, with no credentials, query or fragment.`,
    )
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Where a project with a database of its own is served: `<host>/p/<projectId>`,
 * or null when this process has no host address for the region.
 */
export function postgrestHostUrl(projectId: string, region: CloudRegionId, env: Env = process.env): string | null {
  // Validated first: the id becomes a path segment that selects a process.
  const id = profileForProject(projectId).slice('workspace_'.length)
  const base = regionPostgrestHostUrl(region, env)
  return base ? `${base}/p/${id}` : null
}

/**
 * THE REGION'S NETWORK ALLOWLIST: EVERY PROJECT'S ALLOWED ADDRESSES, AND NO OTHER
 * ==============================================================================
 *
 * A region's database endpoint (a network load balancer in front of the
 * region's Postgres) admits port 5432 only from a customer-managed prefix list
 * (owner's decision, 2026-11-17). This keeps that list equal to the union of
 * the addresses every project in the region allows
 * (lib/services/direct-access-addresses.ts): a project kept in the region and
 * not asked to be deleted. One project's address never leaves the list while
 * another project there still allows it, because the list is the union.
 *
 * ── Configuration, per region ──────────────────────────────────────────────
 *
 *   DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID       the list (pl-…), named like every
 *                                            regional setting: as is for the
 *                                            home region, _<REGION> elsewhere
 *                                            (DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID_US_EAST_1)
 *   DIRECT_DB_ALLOWLIST_PREFIX_LIST_REGION   the AWS region the list is in;
 *                                            optional, the Backenly region's
 *                                            own id (which is an AWS region) by
 *                                            default
 *
 * Credentials are the process's (the web task's role), which needs
 * ec2:DescribeManagedPrefixLists, ec2:GetManagedPrefixListEntries and
 * ec2:ModifyManagedPrefixList on that list. A region with no list configured
 * (a self-hosted deployment, local development, tests) has no allowlist to
 * keep: every sync there is a no-op, said once in the log.
 *
 * ── How a sync runs ────────────────────────────────────────────────────────
 *
 * Read the list's version, then the addresses that should be on it, then the
 * entries at that version; modify with CurrentVersion set to that version.
 * Reading the version first is what makes a race safe: an address that was on
 * the list at that version was committed before it, so it is among the
 * addresses read next unless its project has since removed it. A modification
 * made by anyone else in between changes the version, and EC2 refuses ours
 * (PrefixListVersionMismatch); a list still applying an earlier modification
 * refuses it too (IncorrectState). Either way the whole read is done again
 * after a short wait, as Terraform's AWS provider does for the same calls. A
 * list already equal to what it should be is not modified at all.
 *
 * At most 100 entries are added and 100 removed per modification (EC2's
 * limit); more is done over several. A list whose MaxEntries cannot hold every
 * address keeps the earliest allowed, and says how many are not admitted, so
 * the operator raises it.
 *
 * It runs after every change to a project's addresses (and after a restore of
 * one, a project's deletion, its restore and its purge), and on the platform's
 * scheduler every five minutes (instrumentation.ts), which repairs whatever a
 * failure or a change made outside Backenly left.
 */

import { prisma } from '@/lib/db/prisma'
import { projectRegion, regionSetting } from '@/lib/data-plane/regional'
import { CLOUD_REGIONS, HOME_REGION, type CloudRegionId } from '@/lib/regions'

export const PREFIX_LIST_VARIABLE = 'DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID'
export const PREFIX_LIST_REGION_VARIABLE = 'DIRECT_DB_ALLOWLIST_PREFIX_LIST_REGION'

/** What each entry Backenly adds is described as on the list. */
export const ENTRY_DESCRIPTION = 'Backenly direct Postgres allowed address'

/** EC2's limit on entries added, and on entries removed, by one modification. */
const BATCH = 100
/** How many times a refused or busy modification is read and tried again. */
const MAX_RETRIES = 6
/** How many modifications one sync makes at most (each up to BATCH each way). */
const MAX_ROUNDS = 20

type Env = Readonly<Record<string, string | undefined>>

/** The region's prefix list and the AWS region it is in, or null where none is configured. */
export function allowlistPrefixList(region: CloudRegionId, env: Env = process.env): { id: string; awsRegion: string } | null {
  const id = regionSetting(PREFIX_LIST_VARIABLE, region, env)
  if (!id.value) return null
  return { id: id.value.trim(), awsRegion: regionSetting(PREFIX_LIST_REGION_VARIABLE, region, env).value?.trim() || region }
}

/** Whether the region's endpoint admits only allowed addresses. */
export function allowlistEnforced(region: CloudRegionId, env: Env = process.env): boolean {
  return allowlistPrefixList(region, env) !== null
}

export type AllowlistSync =
  /** The region has no prefix list: there is no allowlist to keep. */
  | { status: 'not_enforced'; region: CloudRegionId }
  /** The list already held exactly the allowed addresses. */
  | { status: 'in_sync'; region: CloudRegionId; entries: number; unapplied: number }
  /** The list was changed to hold exactly the allowed addresses. */
  | { status: 'synced'; region: CloudRegionId; added: number; removed: number; entries: number; unapplied: number }
  /** The list could not be brought up to date now; the scheduled pass tries again. */
  | { status: 'failed'; region: CloudRegionId; reason: string }

// ── The EC2 client ───────────────────────────────────────────────────────────

interface Ec2 {
  send(command: unknown): Promise<any>
}

const clients = new Map<string, Ec2>()

/** One client per AWS region, created on first use; the SDK is loaded only then. */
async function ec2For(awsRegion: string): Promise<{ client: Ec2; sdk: typeof import('@aws-sdk/client-ec2') }> {
  const sdk = await import('@aws-sdk/client-ec2')
  let client = clients.get(awsRegion)
  if (!client) {
    client = new sdk.EC2Client({ region: awsRegion, maxAttempts: 3 })
    clients.set(awsRegion, client)
  }
  return { client, sdk }
}

/** The error code EC2 answered with, as the SDK carries it. */
function codeOf(err: unknown): string {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown } | null
  return String(e?.name ?? e?.Code ?? e?.code ?? 'Error')
}

/** Answers that mean "read the list again and retry": someone else changed it, or it is still applying. */
const RETRY = new Set(['PrefixListVersionMismatch', 'IncorrectState', 'InvalidPrefixListModification'])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const backoff = (retry: number) => sleep(Math.min(3_000, 200 * 2 ** retry) + Math.floor(Math.random() * 100))

// ── What should be on the list ───────────────────────────────────────────────

/**
 * Every address a project in `region` allows, earliest allowed first, each
 * once. A project asked to be deleted no longer counts; restoring it brings
 * its addresses back, and its purge removes them.
 */
export async function allowedAddressesIn(region: CloudRegionId): Promise<string[]> {
  const rows = await prisma.directAccessAddress.findMany({
    where: {
      project: {
        deletedAt: null,
        // A project with no region recorded is in the home region.
        ...(region === HOME_REGION ? { OR: [{ region: null }, { region }] } : { region }),
      },
    },
    select: { cidr: true },
    orderBy: [{ createdAt: 'asc' }, { cidr: 'asc' }],
  })
  return [...new Set(rows.map((r) => r.cidr))]
}

// ── One sync ─────────────────────────────────────────────────────────────────

const notConfiguredSaid = new Set<CloudRegionId>()

async function runSync(region: CloudRegionId): Promise<AllowlistSync> {
  const list = allowlistPrefixList(region)
  if (!list) {
    if (!notConfiguredSaid.has(region)) {
      notConfiguredSaid.add(region)
      console.log(
        `[DirectDbAllowlist] region=${region}: no prefix list is configured (${regionSetting(PREFIX_LIST_VARIABLE, region).variable}), ` +
          'so connections are not limited to allowed addresses here and there is nothing to sync',
      )
    }
    return { status: 'not_enforced', region }
  }

  const failed = (reason: string): AllowlistSync => {
    console.error(`[DirectDbAllowlist] region=${region} list=${list.id}: not brought up to date (${reason}); the scheduled pass tries again`)
    return { status: 'failed', region, reason }
  }

  let ec2: Awaited<ReturnType<typeof ec2For>>
  try {
    ec2 = await ec2For(list.awsRegion)
  } catch (err) {
    return failed(codeOf(err))
  }
  const { client, sdk } = ec2

  let added = 0
  let removed = 0
  let retries = 0
  for (let round = 0; round < MAX_ROUNDS + MAX_RETRIES; round++) {
    let state: { version: number; maxEntries: number; entries: Set<string>; desired: string[] }
    try {
      const described = await client.send(new sdk.DescribeManagedPrefixListsCommand({ PrefixListIds: [list.id] }))
      const pl = described?.PrefixLists?.[0]
      if (!pl) return failed('the prefix list does not exist')
      if (pl.AddressFamily && pl.AddressFamily !== 'IPv4') return failed(`the prefix list is ${pl.AddressFamily}, not IPv4`)
      const status = String(pl.State ?? '')
      if (status.startsWith('delete')) return failed(`the prefix list is ${status}`)
      if (status.endsWith('-in-progress')) {
        if (retries++ >= MAX_RETRIES) return failed(`the prefix list stayed ${status}`)
        await backoff(retries)
        continue
      }
      const version = Number(pl.Version)
      const entries = new Set<string>()
      let NextToken: string | undefined
      do {
        const page = await client.send(
          new sdk.GetManagedPrefixListEntriesCommand({ PrefixListId: list.id, TargetVersion: version, MaxResults: 100, NextToken }),
        )
        for (const entry of page?.Entries ?? []) if (entry?.Cidr) entries.add(String(entry.Cidr))
        NextToken = page?.NextToken || undefined
      } while (NextToken)
      // Read after the version, never before it (see the header).
      const desired = await allowedAddressesIn(region)
      state = { version, maxEntries: Number(pl.MaxEntries ?? Number.MAX_SAFE_INTEGER), entries, desired }
    } catch (err) {
      const code = codeOf(err)
      if (RETRY.has(code) && retries++ < MAX_RETRIES) {
        await backoff(retries)
        continue
      }
      return failed(code)
    }

    const want = new Set(state.desired)
    const remove = [...state.entries].filter((cidr) => !want.has(cidr)).slice(0, BATCH)
    const missing = state.desired.filter((cidr) => !state.entries.has(cidr))
    const room = Math.max(0, state.maxEntries - (state.entries.size - remove.length))
    const add = missing.slice(0, Math.min(BATCH, room))
    const unapplied = Math.max(0, missing.length - room)

    if (add.length === 0 && remove.length === 0) {
      if (unapplied > 0) {
        console.error(
          `[DirectDbAllowlist] region=${region} list=${list.id}: the projects allow ${state.desired.length} addresses and the list holds at most ` +
            `${state.maxEntries}, so ${unapplied} cannot connect until its MaxEntries is raised`,
        )
      }
      const entries = state.entries.size
      return added || removed
        ? { status: 'synced', region, added, removed, entries, unapplied }
        : { status: 'in_sync', region, entries, unapplied }
    }

    try {
      await client.send(
        new sdk.ModifyManagedPrefixListCommand({
          PrefixListId: list.id,
          CurrentVersion: state.version,
          ...(add.length ? { AddEntries: add.map((Cidr) => ({ Cidr, Description: ENTRY_DESCRIPTION })) } : {}),
          ...(remove.length ? { RemoveEntries: remove.map((Cidr) => ({ Cidr })) } : {}),
        }),
      )
      added += add.length
      removed += remove.length
      // Progress: a wait for this modification to apply is not a retry.
      retries = 0
      console.log(`[DirectDbAllowlist] region=${region} list=${list.id}: added ${add.length}, removed ${remove.length} (from version ${state.version})`)
    } catch (err) {
      const code = codeOf(err)
      if (RETRY.has(code) && retries++ < MAX_RETRIES) {
        await backoff(retries)
        continue
      }
      return failed(code)
    }
  }
  return failed(`still not equal after ${MAX_ROUNDS} modifications`)
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** Syncs of one region run one after another in this process; across processes the list's version decides. */
const queues = new Map<CloudRegionId, Promise<AllowlistSync>>()

/**
 * Bring the region's prefix list to exactly the addresses its projects allow.
 * Never throws: a failure is answered and logged, and the scheduled pass tries
 * again.
 */
export function syncAllowlist(region: CloudRegionId): Promise<AllowlistSync> {
  const previous = queues.get(region) ?? Promise.resolve(null)
  const next = previous
    .catch(() => null)
    .then(() => runSync(region))
    .catch((err): AllowlistSync => {
      console.error(`[DirectDbAllowlist] region=${region}: sync failed (${codeOf(err)})`)
      return { status: 'failed', region, reason: codeOf(err) }
    })
  queues.set(region, next)
  void next.finally(() => {
    if (queues.get(region) === next) queues.delete(region)
  })
  return next
}

/** The sync of the project's region. Never throws. */
export async function syncAllowlistForProject(projectId: string): Promise<AllowlistSync> {
  let region: CloudRegionId
  try {
    region = await projectRegion(projectId)
  } catch (err) {
    console.error(`[DirectDbAllowlist] project=${projectId}: its region could not be read (${codeOf(err)}); the scheduled pass syncs it`)
    return { status: 'failed', region: HOME_REGION, reason: codeOf(err) }
  }
  return syncAllowlist(region)
}

let noRegionSaid = false

/**
 * The scheduled pass: every region with a prefix list configured in this
 * process. Run by the home region's scheduler only (cron.platform), since the
 * allowed addresses are platform records and its web task holds every
 * region's setting.
 */
export async function syncDirectAccessAllowlists(): Promise<AllowlistSync[]> {
  const regions = CLOUD_REGIONS.map((r) => r.id).filter((region) => allowlistEnforced(region))
  if (regions.length === 0) {
    if (!noRegionSaid) {
      noRegionSaid = true
      console.log(`[DirectDbAllowlist] no region has a prefix list configured (${PREFIX_LIST_VARIABLE}): nothing to sync`)
    }
    return []
  }
  const results: AllowlistSync[] = []
  for (const region of regions) results.push(await syncAllowlist(region))
  return results
}

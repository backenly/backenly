/**
 * ALLOWED ADDRESSES: WHERE A PROJECT'S DIRECT POSTGRES LOGINS MAY CONNECT FROM
 * ===========================================================================
 *
 * A region's database is reachable from the internet only through its endpoint
 * (owner's decision, 2026-11-17), and the endpoint admits connections only from
 * addresses some project in the region has allowed: no address allowed, no
 * connection. Each project keeps its own list here; the region's network
 * allowlist is the union of every project's (lib/services/direct-access-allowlist.ts).
 *
 *   - What can be allowed: one public IPv4 address, or a range no wider than
 *     /16, normalised (lib/security/allowed-address.ts). Allowing one twice
 *     changes nothing.
 *   - Up to the plan's number per project (lib/entitlements/direct-postgres.ts).
 *
 * Adding or removing one is a governed change of its own, with the person or
 * agent that made it, in the project's History (lib/changes/resources/addresses.ts),
 * and restoring it puts the list back. The region's allowlist follows each
 * change at once, and the scheduled pass catches up whatever a failure left.
 */

import { prisma } from '@/lib/db/prisma'
import { parseAllowedAddress, type AddressRefusalCode } from '@/lib/security/allowed-address'
import { projectRegion } from '@/lib/data-plane/regional'
import { directPostgresAllowanceFor } from '@/lib/entitlements/direct-postgres'
import { planDisplayName } from '@/lib/entitlements/plan-names'
import { assertValidProjectId } from '@/lib/security/workspace-schema'
import { allowlistEnforced, syncAllowlistForProject, type AllowlistSync } from './direct-access-allowlist'

// ── Reading an address ────────────────────────────────────────────────────────

export { parseAllowedAddress, WIDEST_PREFIX, type AddressRefusalCode, type ParsedAddress } from '@/lib/security/allowed-address'

// ── The list ──────────────────────────────────────────────────────────────────

export interface AllowedAddress {
  cidr: string
  createdAt: string
}

export interface AllowlistState {
  /**
   * Whether the project's region admits only allowed addresses: its endpoint
   * has a network allowlist (DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID). Where it does
   * not (a self-hosted deployment, local development), there is no list to keep.
   */
  enforced: boolean
  addresses: AllowedAddress[]
  /** How many the project's plan allows. */
  limit: number
  /** The plan, as it is sold. */
  planName: string
}

export async function listAllowedAddresses(projectId: string): Promise<AllowedAddress[]> {
  assertValidProjectId(projectId)
  const rows = await prisma.directAccessAddress.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }, { cidr: 'asc' }],
    select: { cidr: true, createdAt: true },
  })
  return rows.map((r) => ({ cidr: r.cidr, createdAt: r.createdAt.toISOString() }))
}

export async function allowlistState(projectId: string): Promise<AllowlistState> {
  const [region, addresses, allowance] = await Promise.all([
    projectRegion(projectId),
    listAllowedAddresses(projectId),
    directPostgresAllowanceFor(projectId),
  ])
  return {
    enforced: allowlistEnforced(region),
    addresses,
    limit: allowance.allowedAddresses,
    planName: planDisplayName(allowance.planName),
  }
}

// ── Changing it ───────────────────────────────────────────────────────────────

export type AllowedAddressErrorCode =
  | AddressRefusalCode
  | 'ADDRESS_LIMIT_REACHED'
  | 'ADDRESS_NOT_ALLOWED'
  | 'ALLOWLIST_NOT_ENFORCED'
  | 'CHANGE_IN_PROGRESS'

const STATUS: Record<AllowedAddressErrorCode, number> = {
  INVALID_ADDRESS: 400,
  IPV6_NOT_SUPPORTED: 400,
  ADDRESS_RANGE_TOO_WIDE: 400,
  ADDRESS_NOT_PUBLIC: 400,
  ADDRESS_LIMIT_REACHED: 409,
  ADDRESS_NOT_ALLOWED: 404,
  ALLOWLIST_NOT_ENFORCED: 409,
  CHANGE_IN_PROGRESS: 409,
}

/** An address that was not allowed or removed, and why, in a sentence. */
export class AllowedAddressError extends Error {
  readonly status: number
  constructor(readonly code: AllowedAddressErrorCode, message: string) {
    super(message)
    this.name = 'AllowedAddressError'
    this.status = STATUS[code]
  }
}

export const ALLOWLIST_NOT_ENFORCED_MESSAGE =
  "This deployment doesn't limit which addresses can connect to Postgres, so there is no list of allowed addresses to change."

export interface AllowAddressResult {
  address: AllowedAddress
  /** False when the address was already allowed: nothing changed. */
  added: boolean
  /** Whether the region's allowlist has it yet. */
  sync: AllowlistSync
}

/** Another governed change holds the project's change lock past the wait. */
function changeInProgress(err: unknown): AllowedAddressError | null {
  return (err as { code?: unknown })?.code === 'CHANGE_IN_PROGRESS'
    ? new AllowedAddressError('CHANGE_IN_PROGRESS', (err as Error).message)
    : null
}

/** Run `fn` as one governed change, so it is in the project's History with whoever asked. */
async function governed<T>(projectId: string, title: string, userId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const { governedChange } = await import('@/lib/changes/ledger')
  return governedChange(projectId, title, fn, userId ? { actorUserId: userId } : {})
}

function limitReached(count: number, limit: number, planName: string): AllowedAddressError {
  const more =
    limit < 10 ? ', or move to Pro for up to 10' : limit < 50 ? ', or ask about Enterprise for up to 50' : ''
  return new AllowedAddressError(
    'ADDRESS_LIMIT_REACHED',
    `This project already allows ${count} ${count === 1 ? 'address' : 'addresses'}, the most the ${planDisplayName(planName)} plan includes. Remove one first${more}.`,
  )
}

/**
 * Allow `input` (an address or a CIDR range) to connect to the project's
 * database. Refused with AllowedAddressError, before anything changes, when it
 * cannot be allowed. Allowing an address already on the list changes nothing.
 * `userId` is the person, for a caller that authenticated one itself; the
 * change is otherwise attributed where the request was (an agent's key).
 */
export async function allowAddress(projectId: string, input: unknown, opts: { userId?: string } = {}): Promise<AllowAddressResult> {
  assertValidProjectId(projectId)
  const parsed = parseAllowedAddress(input)
  if (parsed.ok === false) throw new AllowedAddressError(parsed.code, parsed.message)
  const { cidr } = parsed

  const region = await projectRegion(projectId)
  if (!allowlistEnforced(region)) throw new AllowedAddressError('ALLOWLIST_NOT_ENFORCED', ALLOWLIST_NOT_ENFORCED_MESSAGE)

  const existing = await prisma.directAccessAddress.findUnique({ where: { projectId_cidr: { projectId, cidr } } })
  if (existing) {
    return {
      address: { cidr, createdAt: existing.createdAt.toISOString() },
      added: false,
      sync: await syncAllowlistForProject(projectId),
    }
  }

  const allowance = await directPostgresAllowanceFor(projectId)
  const count = await prisma.directAccessAddress.count({ where: { projectId } })
  if (count >= allowance.allowedAddresses) throw limitReached(count, allowance.allowedAddresses, allowance.planName)

  let created: { createdAt: Date } | null
  try {
    created = await governed(projectId, `Allow ${cidr} to connect to Postgres`, opts.userId, async () => {
      // Counted again inside the change, which holds the project's change
      // lock: two adds at once cannot both take the last place. Refused by
      // abandoning the change, so a refusal leaves no History entry.
      const now = await prisma.directAccessAddress.count({ where: { projectId } })
      if (now >= allowance.allowedAddresses) {
        const { AbandonChange } = await import('@/lib/changes/ledger')
        throw new AbandonChange(limitReached(now, allowance.allowedAddresses, allowance.planName))
      }
      // A concurrent add of the same range made it already: nothing to do.
      await prisma.directAccessAddress.createMany({ data: [{ projectId, cidr }], skipDuplicates: true })
      return prisma.directAccessAddress.findUnique({ where: { projectId_cidr: { projectId, cidr } }, select: { createdAt: true } })
    })
  } catch (err) {
    const { AbandonChange } = await import('@/lib/changes/ledger')
    if (err instanceof AbandonChange && err.payload instanceof AllowedAddressError) throw err.payload
    throw changeInProgress(err) ?? err
  }

  await prisma.auditLog
    .create({
      data: {
        projectId,
        userId: opts.userId ?? null,
        action: 'DIRECT_ACCESS_ADDRESS_ALLOWED',
        type: 'security',
        details: JSON.stringify({ cidr }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})

  return {
    address: { cidr, createdAt: (created?.createdAt ?? new Date()).toISOString() },
    added: true,
    sync: await syncAllowlistForProject(projectId),
  }
}

/**
 * Stop `input` connecting: the range exactly as it is on the list (typed in
 * any form that normalises to it). Another project that allows the same range
 * keeps it on the region's allowlist.
 */
export async function removeAddress(projectId: string, input: unknown, opts: { userId?: string } = {}): Promise<{ cidr: string; sync: AllowlistSync }> {
  assertValidProjectId(projectId)
  const parsed = parseAllowedAddress(input)
  // A range that could never have been allowed is not on the list either.
  const cidr = parsed.ok ? parsed.cidr : typeof input === 'string' ? input.trim() : ''
  const existing = cidr
    ? await prisma.directAccessAddress.findUnique({ where: { projectId_cidr: { projectId, cidr } } })
    : null
  if (!existing) {
    throw new AllowedAddressError('ADDRESS_NOT_ALLOWED', `${cidr || 'That address'} is not on this project's list of allowed addresses.`)
  }

  try {
    await governed(projectId, `Remove ${cidr} from the allowed addresses`, opts.userId, () =>
      prisma.directAccessAddress.deleteMany({ where: { projectId, cidr } }),
    )
  } catch (err) {
    throw changeInProgress(err) ?? err
  }

  await prisma.auditLog
    .create({
      data: {
        projectId,
        userId: opts.userId ?? null,
        action: 'DIRECT_ACCESS_ADDRESS_REMOVED',
        type: 'security',
        details: JSON.stringify({ cidr }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})

  return { cidr, sync: await syncAllowlistForProject(projectId) }
}

// ── The caller's own address ──────────────────────────────────────────────────

export interface CallerAddress {
  /** The address the request came from, as the load balancer saw it. */
  address: string
  /** Whether "Allow my address" can allow it. */
  allowable: boolean
  /** Why not, in a sentence, when it cannot. */
  reason?: string
}

/**
 * The caller's address for "Allow my address": the request's client address
 * (lib/security/client-ip.ts, the rightmost X-Forwarded-For entry no trusted
 * proxy added), and whether it can be allowed. Null when the request names none.
 */
export function describeCallerAddress(address: string | null): CallerAddress | null {
  if (!address) return null
  if (address.includes(':')) {
    return {
      address,
      allowable: false,
      reason: `Your address here is IPv6 (${address}). Direct Postgres connections come in over IPv4 only, so allow the IPv4 address you connect from.`,
    }
  }
  const parsed = parseAllowedAddress(address)
  return parsed.ok === false ? { address, allowable: false, reason: parsed.message } : { address, allowable: true }
}

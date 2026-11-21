/**
 * What each plan includes of direct Postgres access (owner's decision,
 * 2026-11-17).
 *
 * Every plan, Free included, gets direct connections (the Pricing page's
 * promise). What grows with the plan is how many connections each of a
 * project's logins may hold at once (every project in a region shares one
 * Postgres instance, and its max_connections).
 *
 * Plans are named by code (lib/entitlements/plan-names.ts). A code this table
 * does not know, or an account with no plan at all, gets the Free allowance:
 * the smallest, never the largest. A self-hosted deployment is one project on
 * its operator's own database, and gets the largest.
 */
// No static import of './index' or the usage account: lib/entitlements/index.ts
// loads the edition modules, which reach this file through project
// provisioning (lib/services/direct-access.ts), so a static import closes an
// import cycle that fails whichever module is evaluated first. Both are loaded
// when an allowance is read (directPostgresAllowanceFor).

export interface DirectPostgresAllowance {
  /** The plan code the allowance was read for ('SANDBOX' when none could be read). */
  planName: string
  /** Connections each of a project's logins may hold at once (Postgres CONNECTION LIMIT). */
  connectionLimit: number
}

const FREE: Omit<DirectPostgresAllowance, 'planName'> = { connectionLimit: 2 }
const PRO: Omit<DirectPostgresAllowance, 'planName'> = { connectionLimit: 5 }
const ENTERPRISE: Omit<DirectPostgresAllowance, 'planName'> = { connectionLimit: 20 }

const BY_PLAN: Record<string, Omit<DirectPostgresAllowance, 'planName'>> = {
  SANDBOX: FREE,
  FREE,
  BUILDER: PRO,
  // Retired paid tiers keep what Pro has.
  STARTER: PRO,
  GROWTH: PRO,
  PRO,
  SCALE: ENTERPRISE,
  SELF_HOSTED: ENTERPRISE,
}

/** The allowance of a plan, by its code. */
export function directPostgresAllowance(planName: string | null | undefined): DirectPostgresAllowance {
  const code = (planName ?? '').toUpperCase()
  return { planName: code in BY_PLAN ? code : 'SANDBOX', ...(BY_PLAN[code] ?? FREE) }
}

/**
 * The allowance of the plan a project's work is billed to (its organization's
 * on Cloud). A plan that cannot be read right now is answered as Free, which
 * only ever allows less.
 */
export async function directPostgresAllowanceFor(projectId: string): Promise<DirectPostgresAllowance> {
  try {
    const [{ billingAccountOf }, { getAccountEntitlements }] = await Promise.all([
      import('@/lib/usage/account'),
      import('./index'),
    ])
    const account = await billingAccountOf(projectId)
    const ent = account ? await getAccountEntitlements(account) : null
    return directPostgresAllowance(ent?.planName)
  } catch {
    return directPostgresAllowance(null)
  }
}

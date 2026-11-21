/**
 * WHICH DATABASE A NEW PROJECT GETS
 * =================================
 * A project's data is either in its region's own database, beside other
 * projects' ('shared', every project's until now), or in a database of its own
 * on the region's data instance ('dedicated', lib/data-plane/project-databases.ts).
 * Which one is decided once, when the project is created, by a switch per
 * region, and recorded on its row (Project.databaseTenancy, databaseName,
 * databaseInstance). Nothing reads the switch again for an existing project:
 * turning it off later leaves every project where it is.
 *
 *   BACKENLY_DEDICATED_DATABASES            the home region
 *   BACKENLY_DEDICATED_DATABASES_<REGION>   any other, e.g. _US_EAST_1
 *
 *   off     (or unset) every new project is shared, as before
 *   staff   only the projects of accounts the platform already treats as its
 *           administrators get a database of their own: the ones requireAdmin
 *           admits (lib/auth/middleware.ts, lib/auth/server.ts), a user whose
 *           role is `admin` or `super_admin`, or whose email is FOUNDER_EMAIL
 *   new     every new project gets a database of its own
 *
 * Never the home value for another region, as with every per-region setting
 * (lib/data-plane/regional.ts regionSetting). A value that is none of these is
 * read as off and said once: a mistyped switch leaves new projects where they
 * always were rather than refusing to create them.
 */

import { prisma } from '@/lib/db/prisma'
import { regionSetting, type DatabaseTenancy } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'

export const DEDICATED_DATABASES_SETTING = 'BACKENLY_DEDICATED_DATABASES'

export type DedicatedDatabasesMode = 'off' | 'staff' | 'new'

const MODES: readonly DedicatedDatabasesMode[] = ['off', 'staff', 'new']

type Env = Readonly<Record<string, string | undefined>>

const saidInvalid = new Set<string>()

/** The region's switch, and the variable it was read from. */
export function dedicatedDatabasesMode(region: CloudRegionId, env: Env = process.env): { mode: DedicatedDatabasesMode; variable: string } {
  const { variable, value } = regionSetting(DEDICATED_DATABASES_SETTING, region, env)
  if (!value) return { mode: 'off', variable }
  const mode = value.trim().toLowerCase() as DedicatedDatabasesMode
  if (MODES.includes(mode)) return { mode, variable }
  const said = `${variable}=${value}`
  if (!saidInvalid.has(said)) {
    saidInvalid.add(said)
    console.warn(`[ProjectDatabases] ${variable} is "${value.slice(0, 40)}", which is not off, staff or new; read as off, so new projects in ${region} are shared`)
  }
  return { mode: 'off', variable }
}

/** The roles the platform's own admin checks admit (requireAdmin in lib/auth). */
const STAFF_ROLES = new Set(['admin', 'super_admin'])

/**
 * Whether an account is one the platform already treats as its own staff: the
 * accounts requireAdmin admits. Not a new notion of staff, and not decided
 * here: a role named admin or super_admin, or the FOUNDER_EMAIL account.
 */
export async function isStaffAccount(userId: string, env: Env = process.env): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: { select: { name: true } } },
  })
  if (!user) return false
  if (user.role?.name && STAFF_ROLES.has(user.role.name)) return true
  const founder = env.FOUNDER_EMAIL?.trim().toLowerCase()
  return Boolean(founder) && user.email?.trim().toLowerCase() === founder
}

/**
 * The tenancy a project created now in `region` for `userId` gets. Asks for
 * the account only when the switch is `staff`, so with the switch off a
 * creation reads nothing it did not read before.
 */
export async function tenancyForNewProject(
  input: { region: CloudRegionId; userId: string },
  env: Env = process.env,
): Promise<DatabaseTenancy> {
  const { mode } = dedicatedDatabasesMode(input.region, env)
  if (mode === 'new') return 'dedicated'
  if (mode === 'staff') return (await isStaffAccount(input.userId, env)) ? 'dedicated' : 'shared'
  return 'shared'
}

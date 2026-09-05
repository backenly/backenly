/**
 * Fleet sweep: measure DB storage for every project.
 *
 * ── PHASE 7, NOT PHASE 6 ────────────────────────────────────────────────────
 *
 * This is control-plane work and it is parked here deliberately. The cut line
 * for the public/private split is:
 *
 *   measure ONE project's database          -> public product
 *   find EVERY project and measure each     -> fleet / control plane
 *
 * The measurement primitive is public and lives in lib/usage/db-storage.ts.
 * This file is only the fan-out: it enumerates projects and calls that
 * primitive. Enumerating across projects is exactly the multi-project control
 * plane that Phase 7 moves, alongside lib/org, the org routes and scripts/fleet.
 *
 * It is PUBLIC today because Phase 6 severed lib/billing and this had to go
 * somewhere; it is not public because it is product. Phase 7 decides its
 * permanent home along with the rest of the fan-out architecture. Do not treat
 * its current location as a settled ownership decision, and do not build new
 * project-local functionality on top of it.
 *
 * lib/fleet is deliberately NOT in overlay-allowlist.json yet. Claiming it as a
 * private-owned path today would make this file a public file under a private
 * path, which needs a transition grandfather entry, and that list may only
 * shrink. Phase 7 claims the path and moves the file in the same commit.
 */
import { prisma } from '@/lib/db/prisma'
import { snapshotProjectDbStorage } from '@/lib/usage/db-storage'

/**
 * Snapshot every active project's database footprint.
 *
 * allSettled rather than all: one project's schema being mid-migration, locked
 * or already dropped must not abandon the rest of the sweep.
 */
export async function snapshotAllProjectsDbStorage(): Promise<void> {
  const projects = await prisma.project.findMany({
    select: { id: true },
    where: { expiresAt: null }, // only active (non-expired) projects
  })

  await Promise.allSettled(
    projects.map((p) => snapshotProjectDbStorage(p.id))
  )
}

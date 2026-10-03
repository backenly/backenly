/**
 * WRITE A DEPLOYMENT RECOVERY BUNDLE
 * ==================================
 *
 *   POST /api/deployment/recovery/export
 *
 * ── Why the boundary here is the EDITION, not a permission ──────────────────
 *
 * This reads the whole platform database: every project, every account, every
 * key and every stored secret. In a self-hosted install that is exactly right,
 * because the single account IS the operator of the machine and the data is
 * already theirs. `lib/edition/guard.ts` states the same rule for projects:
 * single-tenant treats any authenticated account as an operator of the one
 * project.
 *
 * In Cloud it would be one tenant exporting everybody. No role makes that
 * acceptable, so it is refused by edition rather than by permission - a check
 * that cannot be satisfied by granting somebody more. The refusal is 404,
 * because in Cloud this capability does not exist and a 403 would suggest it
 * is there and merely withheld.
 *
 * ── Why the credential comes back in the response and is never stored ───────
 *
 * It is generated inside the export and returned once. It is not written into
 * the bundle, not persisted, and not logged - so this response is the only
 * time it exists anywhere outside the operator's own records. That is the
 * property that makes the bundle safe to keep: losing it discloses nothing.
 *
 * It also means an operator who closes the page has lost it, and the UI has to
 * say so before they do. There is no "resend" to build, because there is
 * nothing to resend from.
 */

import { NextResponse } from 'next/server'
import * as path from 'path'
import { requireUser } from '@/lib/auth/server'
import { assertSingleTenantEdition, SelfHostOnlyFeatureError } from '@/lib/edition/cloud-only'
import { exportDeploymentBundle } from '@/lib/recovery/export'
import { missingComponents } from '@/lib/recovery/contract'

export const runtime = 'nodejs'
// A full platform dump is not something to run inside a short request budget.
export const maxDuration = 300

export async function POST() {
  try {
    assertSingleTenantEdition('Deployment recovery')
  } catch (err) {
    if (err instanceof SelfHostOnlyFeatureError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    throw err
  }

  try {
    await requireUser()
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const outDir = path.join(
    process.env.RECOVERY_DIR || path.join(process.cwd(), 'recovery'),
    new Date().toISOString().replace(/[:.]/g, '-'),
  )

  try {
    const result = await exportDeploymentBundle({ outDir })

    return NextResponse.json({
      // The directory, so the operator can go and copy it off the machine. A
      // bundle that only exists on the server it protects is not a backup, and
      // the UI says so next to this path.
      bundleDir: result.bundleDir,
      credential: result.credential,
      createdAt: result.manifest.createdAt,
      components: result.manifest.components.map(c => ({
        component: c.component,
        bytes: c.bytes,
        items: c.items,
        encrypted: c.encrypted,
      })),
      // Stated positively rather than left to be worked out from what is absent.
      absent: missingComponents(result.manifest),
    })
  } catch (err) {
    // Deliberately not echoing the underlying message. pg_dump failures can
    // carry connection detail, and lib/services/workspace-backup.ts records
    // what that cost the last time it reached a log.
    console.error('[recovery] export failed:', err)
    return NextResponse.json(
      { error: 'The export failed. Check the server logs for the reason.' },
      { status: 500 },
    )
  }
}

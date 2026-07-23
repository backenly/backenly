export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/projects/[id]/import/supabase — the graduation door.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ HIDDEN / DISABLED BY DESIGN (2026-07-17, planned dormant ~1–3 months).   │
 * │                                                                          │
 * │ Product decision: "migrate from Supabase" must NOT be the reason people  │
 * │ come to Backenly. The draw is the autonomous, governed backend + the     │
 * │ agent lane (CLI / MCP / skill) — not being a migration target. Leading   │
 * │ with an importer frames Backenly as "Supabase but you move", which is    │
 * │ exactly the wrong first impression while positioning is still being      │
 * │ established. So this endpoint is gated OFF and returns 404 (genuinely     │
 * │ undiscoverable — a probe can't tell it exists) until we deliberately      │
 * │ choose to surface migration as a funnel, likely once graduated-prototype │
 * │ demand is proven.                                                        │
 * │                                                                          │
 * │ NOTHING IS DELETED. The engine (lib/import/supabase-importer.ts) and the │
 * │ pure planner (lib/import/supabase-map.ts) stay intact and unit-tested    │
 * │ (scripts/verify-supabase-import-plan.ts). NOTE: supabase-map's mapPgType │
 * │ is ALSO used by lib/branches/engine.ts — do not delete it.               │
 * │                                                                          │
 * │ TO RE-ENABLE: set env SUPABASE_IMPORT_ENABLED=true (and, when surfacing  │
 * │ it in the UI, build the first-run import card). No code change needed.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * When enabled — Body: {
 *   connectionString: string   // postgresql://postgres:…@db.xyz.supabase.co:5432/postgres
 *   options?: { maxRowsPerTable?: number; skipAuth?: boolean }
 * }
 * Imports a Supabase project (schema, data, auth identities, RLS report) into
 * THIS Backenly project through the governed mutation kernel. Clean-slate only.
 * Auth: platform JWT + project ownership. Connection string never persisted.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { runSupabaseImport } from '@/lib/import/supabase-importer'

// Feature flag — OFF unless explicitly enabled. Kept as a module constant so
// the gate reads identically at the top of the handler.
const SUPABASE_IMPORT_ENABLED = process.env.SUPABASE_IMPORT_ENABLED === 'true'

const runImport = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  let body: { connectionString?: string; options?: { maxRowsPerTable?: number; skipAuth?: boolean } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const cs = body.connectionString?.trim()
  if (!cs || !/^postgres(ql)?:\/\//i.test(cs)) {
    return NextResponse.json(
      {
        success: false,
        error:
          'connectionString must be a postgresql:// URL. In Supabase: Project Settings → Database → ' +
          'Connection string (URI). Use the direct connection (port 5432), not the pooler.',
      },
      { status: 400 },
    )
  }

  const report = await runSupabaseImport({
    projectId,
    userId: user.userId,
    connectionString: cs,
    options: {
      maxRowsPerTable: body.options?.maxRowsPerTable,
      skipAuth: body.options?.skipAuth,
    },
  })

  return NextResponse.json(
    { success: report.ok && !report.error, report },
    { status: report.error ? 422 : 200 },
  )
})

/**
 * Public entry point. The feature gate runs BEFORE auth so a disabled importer
 * is a flat 404 for everyone — an unauthenticated probe can't even tell the
 * route needs a login, let alone that an importer lives here. Only when
 * SUPABASE_IMPORT_ENABLED=true does the real auth-gated handler run.
 */
export async function POST(request: NextRequest) {
  if (!SUPABASE_IMPORT_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return runImport(request)
}

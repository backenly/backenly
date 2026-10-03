export const dynamic = 'force-dynamic'

/**
 * Enum types and domains in a project's own schema.
 *
 * Scoped to `workspace_<projectId>`, never `public`: a type in `public` is
 * visible to every schema in the database, which on Cloud is every tenant.
 *
 * ── What is offered, and what PostgreSQL will not do ────────────────────────
 *
 * Creating a type, appending an enum value and renaming one are supported.
 * REMOVING an enum value is not, because PostgreSQL has no
 * `ALTER TYPE ... DROP VALUE` at any version. Emulating it means creating a
 * replacement type, rewriting every dependent column and dropping the old one —
 * a data-rewriting migration, not a settings change — so the route explains that
 * instead of doing it behind a button.
 *
 * Dropping a type is refused while anything uses it, and the dependents are
 * returned. No CASCADE: CASCADE would drop the columns typed by it, which is
 * data the dashboard cannot show the consequences of.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject, canWriteProject, canAdministerProject } from '@/lib/edition/guard'
import {
  addEnumValue,
  createDomain,
  createEnum,
  dropType,
  explainDropValueUnsupported,
  listTypes,
  renameEnumValue,
  DOMAIN_BASE_TYPES,
  TypeValidationError,
} from '@/lib/services/enums'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const inventory = await listTypes(projectId)
  return NextResponse.json({
    ...inventory,
    // The allowlist travels with the inventory, so the form renders from the
    // same source the validator enforces rather than a second copy.
    baseTypes: DOMAIN_BASE_TYPES,
  })
})

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canWriteProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const action = body?.action

  try {
    switch (action) {
      case 'create_enum':
        await createEnum(projectId, String(body?.name ?? ''), body?.values ?? [])
        break

      case 'add_enum_value':
        await addEnumValue(projectId, String(body?.name ?? ''), String(body?.value ?? ''))
        break

      case 'rename_enum_value':
        await renameEnumValue(
          projectId,
          String(body?.name ?? ''),
          String(body?.from ?? ''),
          String(body?.to ?? ''),
        )
        break

      case 'create_domain':
        await createDomain(projectId, {
          name: String(body?.name ?? ''),
          baseType: String(body?.baseType ?? ''),
          notNull: Boolean(body?.notNull),
          check: typeof body?.check === 'string' ? body.check : null,
        })
        break

      case 'drop_enum_value':
        // Answered, not attempted. 409 because the request is understood and
        // the database cannot satisfy it — this is not the caller's mistake.
        return NextResponse.json(
          {
            error: explainDropValueUnsupported(String(body?.name ?? ''), String(body?.value ?? '')),
            code: 'UNSUPPORTED_BY_POSTGRES',
          },
          { status: 409 },
        )

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err: any) {
    if (err instanceof TypeValidationError) {
      return NextResponse.json({ error: err.message, code: 'INVALID' }, { status: 400 })
    }
    // PostgreSQL's own words. "Could not create type" tells an operator nothing
    // they can act on; `type "status" already exists` tells them everything.
    return NextResponse.json(
      { error: String(err?.message ?? err).slice(0, 400), code: 'FAILED' },
      { status: 400 },
    )
  }

  return NextResponse.json({ ...(await listTypes(projectId)), baseTypes: DOMAIN_BASE_TYPES })
})

export const DELETE = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  // ADMIN: dropping a type is not undoable from the dashboard.
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const name = new URL(request.url).searchParams.get('name')
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  try {
    const result = await dropType(projectId, name)
    if (!result.dropped && result.usedBy.length > 0) {
      // The dependents, so an operator can deal with them deliberately rather
      // than reaching for CASCADE.
      return NextResponse.json(
        {
          error: `${name} is still used by ${result.usedBy.join(', ')}.`,
          usedBy: result.usedBy,
          code: 'IN_USE',
        },
        { status: 409 },
      )
    }
    if (!result.dropped) {
      return NextResponse.json({ error: `${name} does not exist.` }, { status: 404 })
    }
  } catch (err: any) {
    if (err instanceof TypeValidationError) {
      return NextResponse.json({ error: err.message, code: 'INVALID' }, { status: 400 })
    }
    return NextResponse.json({ error: String(err?.message ?? err).slice(0, 400) }, { status: 400 })
  }

  return NextResponse.json({ ...(await listTypes(projectId)), baseTypes: DOMAIN_BASE_TYPES })
})

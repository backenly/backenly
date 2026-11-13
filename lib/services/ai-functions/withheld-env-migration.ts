/**
 * Stored functions that still read the variables Backenly no longer gives them.
 *
 * Route functions used to find the project's end-user signing secret and its
 * admin key in process.env (JWT_SECRET, ADMIN_API_KEY, AI_EXECUTION_TOKEN).
 * They now hold a value that matches nothing (route-module-runner.ts
 * makeCuratedProcess), so code that compared a header with them answers 403 to
 * everyone, and code that signed sessions with them is refused.
 *
 * Backenly's own templates did both, and every project that built with them
 * stores copies. This finds every stored function that reads one of the
 * variables and, for the exact template code Backenly wrote, rewrites it:
 *
 *   - the admin gate becomes isAdminRequest(req), which checks the key without
 *     the function holding it, so the endpoint keeps working;
 *   - the impersonation endpoint, which minted sessions as any user, answers a
 *     plain refusal instead.
 *
 * Code an agent deployed is stored exactly as written and stays that way
 * (codeOrigin 'agent'); it is listed for its owner, never rewritten. So is any
 * generated code that is not the exact template text.
 *
 * Each rewrite is a governed change, so History keeps the code it replaced and
 * a restore brings it back.
 */

import { prisma } from '@/lib/db'
import { readsWithheldEnv } from './route-module-runner'

/** The admin gate Backenly's templates wrote, exactly. */
export const TEMPLATE_ADMIN_KEY_LINE = "const ADMIN_KEY = process.env.ADMIN_API_KEY ?? process.env.AI_EXECUTION_TOKEN ?? ''\n"
export const TEMPLATE_ADMIN_GATE =
  "    const key = req.headers.get('x-admin-key') ?? req.headers.get('authorization')?.replace('Bearer ', '')\n" +
  "    if (!key || key !== ADMIN_KEY) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })\n"
export const HELPER_ADMIN_GATE = "    if (!isAdminRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })\n"

/** What the impersonation endpoint becomes. */
export const IMPERSONATION_REFUSAL = `import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    { error: "Signing in as another user is not available to functions: Backenly does not give function code the project's signing secret." },
    { status: 410 },
  )
}
`

/** True for Backenly's impersonation template, in any of its versions. */
function isImpersonationTemplate(code: string): boolean {
  return code.includes('IMPERSONATION_DURATION') && code.includes('impersonated: true') && code.includes('process.env.JWT_SECRET')
}

/**
 * The template code rewritten, or null when this is not code Backenly's
 * templates wrote, exactly.
 */
export function rewriteTemplateCode(code: string): { code: string; rewrote: 'admin_gate' | 'impersonation' } | null {
  if (isImpersonationTemplate(code)) return { code: IMPERSONATION_REFUSAL, rewrote: 'impersonation' }
  if (!code.includes(TEMPLATE_ADMIN_KEY_LINE) || !code.includes(TEMPLATE_ADMIN_GATE)) return null

  let next = code.replace(TEMPLATE_ADMIN_KEY_LINE, '').split(TEMPLATE_ADMIN_GATE).join(HELPER_ADMIN_GATE)
  // Any other use of ADMIN_KEY is code the template did not write.
  if (/\bADMIN_KEY\b/.test(next)) return null

  const jwtImport = /import \{ ([^}]*) \} from '@\/lib\/auth\/jwt'\n/
  if (jwtImport.test(next)) {
    next = next.replace(jwtImport, (line, names: string) =>
      names.split(',').map((n) => n.trim()).includes('isAdminRequest') ? line : `import { ${names}, isAdminRequest } from '@/lib/auth/jwt'\n`)
  } else if (next.includes("import { prisma } from '@/lib/db'\n")) {
    next = next.replace("import { prisma } from '@/lib/db'\n", "import { prisma } from '@/lib/db'\nimport { isAdminRequest } from '@/lib/auth/jwt'\n")
  } else {
    return null
  }
  return readsWithheldEnv(next) ? null : { code: next, rewrote: 'admin_gate' }
}

export interface WithheldEnvFunction {
  projectId: string
  functionId: string
  name: string
  codeOrigin: string
  /** The first withheld variable the code reads. */
  reads: string
  /** What --apply does: rewrite Backenly's template code, or nothing (its owner changes it). */
  action: 'rewrite_admin_gate' | 'replace_impersonation' | 'owner_must_change'
}

/** Every stored function that reads one of the withheld variables, and what can be done. */
export async function findFunctionsReadingWithheldEnv(projectId?: string): Promise<WithheldEnvFunction[]> {
  const rows = await prisma.aiFunction.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      OR: ['JWT_SECRET', 'ADMIN_API_KEY', 'AI_EXECUTION_TOKEN'].map((name) => ({ generatedCode: { contains: name } })),
    },
    select: { id: true, projectId: true, name: true, codeOrigin: true, generatedCode: true },
    orderBy: [{ projectId: 'asc' }, { name: 'asc' }],
  })
  const found: WithheldEnvFunction[] = []
  for (const row of rows) {
    const reads = readsWithheldEnv(row.generatedCode)
    if (!reads) continue
    const rewrite = row.codeOrigin === 'agent' ? null : rewriteTemplateCode(row.generatedCode)
    found.push({
      projectId: row.projectId,
      functionId: row.id,
      name: row.name,
      codeOrigin: row.codeOrigin,
      reads,
      action: !rewrite ? 'owner_must_change' : rewrite.rewrote === 'impersonation' ? 'replace_impersonation' : 'rewrite_admin_gate',
    })
  }
  return found
}

/**
 * Rewrite each function `find` can rewrite, one governed change per function.
 * Re-reads the code inside the change, so a function deployed since the report
 * is left as it now is.
 */
export async function applyWithheldEnvRewrites(found: WithheldEnvFunction[]): Promise<Array<{ functionId: string; changed: boolean; changeId: string | null }>> {
  const { governedChange, currentChange, withChangeAttribution } = await import('@/lib/changes/ledger')
  const results: Array<{ functionId: string; changed: boolean; changeId: string | null }> = []
  for (const f of found) {
    if (f.action === 'owner_must_change') continue
    let changeId: string | null = null
    const changed = await withChangeAttribution({ source: 'system' }, () =>
      governedChange(f.projectId, `Stop function ${f.name} reading the project's signing secret and admin key`, async () => {
        const row = await prisma.aiFunction.findUnique({ where: { id: f.functionId }, select: { generatedCode: true, codeOrigin: true } })
        const rewrite = row && row.codeOrigin !== 'agent' ? rewriteTemplateCode(row.generatedCode) : null
        if (!rewrite) return false
        changeId = currentChange(f.projectId)?.id ?? null
        await prisma.aiFunction.update({ where: { id: f.functionId }, data: { generatedCode: rewrite.code } })
        return true
      }),
    )
    results.push({ functionId: f.functionId, changed, changeId: changed ? changeId : null })
  }
  return results
}

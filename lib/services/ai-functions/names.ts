/**
 * One function name, every form it can be stored under.
 *
 * Creation paths normalise names differently: an event-trigger create keeps
 * underscores (and model-generated names are snake_case), an HTTP create and
 * deploy_code kebab-case, and get/set_active/delete used to match only the
 * exact string. So a function created as `send_welcome_email` was NOT_FOUND to
 * `send-welcome-email`, and deploy_code under either form created a second
 * function on the same trigger, both of which then fired (medium finding
 * FN-09). Every lookup by name resolves through here instead.
 */
import type { AiFunction, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

/** The exact name, its kebab-case form and its snake_case form. */
export function functionNameForms(name: string): string[] {
  const raw = name.trim()
  const lower = raw.toLowerCase()
  const kebab = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const snake = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return [...new Set([raw, kebab, snake].filter(Boolean))]
}

export type FunctionByName =
  | { fn: AiFunction }
  | { ambiguous: string[] }
  | null

/**
 * The function a name refers to: the exact name first, then any single row
 * under another form of it. Two different functions under two forms of one
 * name is ambiguous, and is returned as such rather than settled by whichever
 * row the database returns first.
 */
export async function resolveFunctionByName(
  projectId: string,
  name: string,
  where: Prisma.AiFunctionWhereInput = {},
): Promise<FunctionByName> {
  const rows = await prisma.aiFunction.findMany({
    where: { ...where, projectId, name: { in: functionNameForms(name) } },
    orderBy: { createdAt: 'asc' },
  })
  if (rows.length === 0) return null
  const exact = rows.find((r) => r.name === name.trim())
  if (exact) return { fn: exact }
  if (rows.length === 1) return { fn: rows[0] }
  return { ambiguous: rows.map((r) => r.name) }
}

/**
 * A project's end-user auth email templates: the defaults it sends, and the
 * overrides it has saved.
 *
 * One authority for the Auth page's template routes and the agent's auth
 * actions, so what "customised", "valid" and "reverted" mean cannot differ
 * between them.
 */

import { prisma } from '@/lib/db/prisma'
import {
  KIND_LABELS,
  REQUIRED_VARIABLES,
  TEMPLATE_KINDS,
  TEMPLATE_VARIABLES,
  validateTemplate,
  type TemplateKind,
  type TemplateValidationError,
} from '@/lib/email/template-kinds'

export async function listProjectTemplates(projectId: string) {
  const overrides = await prisma.projectEmailTemplate.findMany({
    where: { projectId },
    select: { kind: true, subject: true, bodyHtml: true, updatedAt: true },
  })
  const byKind = new Map(overrides.map(o => [o.kind, o]))

  return {
    // The allowlist travels with the list, so an editor renders its help text
    // from the same source the validator enforces. Two copies is how a UI ends
    // up offering a placeholder the API rejects.
    variables: TEMPLATE_VARIABLES,
    requiredVariables: REQUIRED_VARIABLES,
    templates: TEMPLATE_KINDS.map(kind => {
      const override = byKind.get(kind)
      return {
        kind,
        title: KIND_LABELS[kind].title,
        sends: KIND_LABELS[kind].sends,
        customised: Boolean(override),
        subject: override?.subject ?? null,
        bodyHtml: override?.bodyHtml ?? null,
        updatedAt: override?.updatedAt?.toISOString() ?? null,
      }
    }),
  }
}

/** Save an override, or say why it cannot be used. */
export async function saveProjectTemplate(
  projectId: string,
  kind: TemplateKind,
  subject: string,
  bodyHtml: string,
): Promise<
  | { ok: true; template: { kind: string; subject: string; bodyHtml: string; customised: true; updatedAt: string } }
  | { ok: false; errors: TemplateValidationError[] }
> {
  const errors = validateTemplate(subject, bodyHtml)
  if (errors.length > 0) return { ok: false, errors }

  const saved = await prisma.projectEmailTemplate.upsert({
    where: { projectId_kind: { projectId, kind } },
    create: { projectId, kind, subject, bodyHtml },
    update: { subject, bodyHtml },
    select: { kind: true, subject: true, bodyHtml: true, updatedAt: true },
  })
  return { ok: true, template: { ...saved, customised: true, updatedAt: saved.updatedAt.toISOString() } }
}

/** Drop an override, so the default is sent again. True when there was one. */
export async function revertProjectTemplate(projectId: string, kind: TemplateKind): Promise<boolean> {
  const { count } = await prisma.projectEmailTemplate.deleteMany({ where: { projectId, kind } })
  return count > 0
}

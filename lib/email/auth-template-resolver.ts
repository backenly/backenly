/**
 * THE BUILT-IN TEMPLATE IS THE FLOOR, NEVER THE CEILING
 * ====================================================
 *
 * An operator override replaces a built-in subject and body. Absence means the
 * built-in is used, so an install that customises nothing behaves exactly as it
 * did before this existed.
 *
 * ── Rendering failure falls back, loudly ────────────────────────────────────
 *
 * `validateTemplate` refuses a broken template at save, which is where an
 * operator should learn about it. This is the second line, for the cases that
 * check cannot cover: a template stored before a variable was renamed, a row
 * edited directly in the database, a body that validated and still produces
 * nothing after substitution.
 *
 * In all of those the built-in is used and the failure is logged. A password
 * reset must not be the thing that surfaces a template bug — the person waiting
 * for that email did not author it and cannot fix it.
 *
 * This is deliberately NOT silent. "Fall back quietly" is how a project ends up
 * sending Backenly's default wording for months while the dashboard shows a
 * customised template nobody is using.
 */

import { prisma } from '@/lib/db/prisma'
import {
  renderSubject,
  renderTemplate,
  type TemplateKind,
  type TemplateVariable,
} from './template-kinds'

export interface BuiltInTemplate {
  subject: string
  bodyHtml: string
}

export interface ResolvedAuthEmail {
  subject: string
  bodyHtml: string
  /** True when an operator override produced this. */
  customised: boolean
  /**
   * Set when an override existed and could not be used. The caller logs it; the
   * email still goes out, using the built-in.
   */
  fallbackReason: string | null
}

/**
 * Resolve one auth email's subject and body.
 *
 * `builtIn` is produced by the caller, which is the only place that knows the
 * real link and expiry for this send. Passing it in rather than looking it up
 * keeps one definition of the default wording.
 */
export async function resolveAuthEmail(
  projectId: string,
  kind: TemplateKind,
  values: Partial<Record<TemplateVariable, string>>,
  builtIn: BuiltInTemplate,
): Promise<ResolvedAuthEmail> {
  let override: { subject: string; bodyHtml: string } | null = null
  try {
    override = await prisma.projectEmailTemplate.findUnique({
      where: { projectId_kind: { projectId, kind } },
      select: { subject: true, bodyHtml: true },
    })
  } catch (err: any) {
    // A database error here must not stop an auth email. The built-in is used
    // and the reason is reported.
    return {
      ...builtIn,
      customised: false,
      fallbackReason: `template lookup failed: ${err?.message ?? err}`,
    }
  }

  if (!override) return { ...builtIn, customised: false, fallbackReason: null }

  try {
    const subject = renderSubject(override.subject, values)
    const bodyHtml = renderTemplate(override.bodyHtml, values)

    // An empty result is a failure, not a customisation. A body that renders to
    // whitespace would send a blank email that looks delivered.
    if (!subject.trim() || !bodyHtml.trim()) {
      return {
        ...builtIn,
        customised: false,
        fallbackReason: 'the stored template rendered empty',
      }
    }

    // The link is the reason the email exists. If substitution did not put it
    // in, the email cannot do its job, and sending it would waste the one
    // attempt the user is waiting on.
    const ctaUrl = values.ctaUrl
    if (ctaUrl && !bodyHtml.includes(ctaUrl)) {
      return {
        ...builtIn,
        customised: false,
        fallbackReason: 'the stored template produced no action link',
      }
    }

    return { subject, bodyHtml, customised: true, fallbackReason: null }
  } catch (err: any) {
    return {
      ...builtIn,
      customised: false,
      fallbackReason: `template render failed: ${err?.message ?? err}`,
    }
  }
}

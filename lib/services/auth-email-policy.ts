/**
 * The four end-user auth email settings a project owns: the app name and URL
 * its auth emails link back to, whether sign-in requires a verified address,
 * and whether magic links are offered.
 *
 * The runtime reads them on every sign-up and sign-in (getAuthEmailContext),
 * and the Auth page and the agent's auth tool both write them through here,
 * so the two doors cannot drift on validation or on the guard below.
 *
 * Requiring verification is the one setting that can lock users out. Sign-in
 * refuses an unverified address while it is on, and a new sign-up starts
 * unverified, so with no sender configured every new user is stranded at a
 * verification email that is never sent. Turning it ON therefore needs an
 * active sender. Saving it while it is already on does not re-check, so a
 * project that predates this guard can still edit its app name.
 */

import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getSmtpConfigView } from '@/lib/email/project-smtp'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { ensureEmailVerifiedColumn } from '@/lib/services/end-user-auth-flows'

export interface AuthEmailPolicyView {
  appName: string | null
  appUrl: string | null
  requireEmailVerification: boolean
  magicLinksEnabled: boolean
  /** What emails actually show, after falling back to the project's own name and URL. */
  effectiveAppName: string
  effectiveAppUrl: string | null
}

export const AUTH_EMAIL_POLICY_INPUT = z.object({
  appName: z.string().trim().max(80).nullable().optional(),
  appUrl: z.string().trim().url().max(500).nullable().optional().or(z.literal('').transform(() => null)),
  requireEmailVerification: z.boolean().optional(),
  magicLinksEnabled: z.boolean().optional(),
})

export type SaveAuthEmailPolicyResult =
  | { ok: true; policy: AuthEmailPolicyView }
  | { ok: false; code: 'INVALID_ARGUMENT'; message: string; problems: Record<string, string[] | undefined> }
  | { ok: false; code: 'NO_EMAIL_SENDER'; message: string }
  | { ok: false; code: 'PROJECT_NOT_FOUND'; message: string }

export const NO_SENDER_MESSAGE =
  'Verification was not turned on: no email sender is configured, so a new user would be refused at sign-in ' +
  'waiting for a verification email that is never sent. Save outgoing mail settings and send a successful test first.'

export async function getAuthEmailPolicy(projectId: string): Promise<AuthEmailPolicyView | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, publicUrl: true, authConfig: true },
  })
  if (!project) return null
  const cfg = project.authConfig
  return {
    appName: cfg?.appName ?? null,
    appUrl: cfg?.appUrl ?? null,
    requireEmailVerification: cfg?.requireEmailVerification ?? false,
    magicLinksEnabled: cfg?.magicLinksEnabled ?? true,
    effectiveAppName: cfg?.appName || project.name,
    effectiveAppUrl: cfg?.appUrl || project.publicUrl || null,
  }
}

export async function saveAuthEmailPolicy(projectId: string, raw: unknown): Promise<SaveAuthEmailPolicyResult> {
  const parsed = AUTH_EMAIL_POLICY_INPUT.safeParse(raw ?? {})
  if (!parsed.success) {
    const problems = parsed.error.flatten().fieldErrors
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: `Nothing was saved: ${Object.entries(problems).map(([f, m]) => `${f}: ${(m ?? []).join(' ')}`).join('; ')}`,
      problems,
    }
  }
  const { appName, appUrl, requireEmailVerification, magicLinksEnabled } = parsed.data

  const current = await getAuthEmailPolicy(projectId)
  if (!current) return { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' }

  const turningVerificationOn = requireEmailVerification === true && !current.requireEmailVerification
  if (turningVerificationOn) {
    const smtp = await getSmtpConfigView(projectId)
    if (smtp.activeSource === 'none') return { ok: false, code: 'NO_EMAIL_SENDER', message: NO_SENDER_MESSAGE }
    // Accounts that exist now are recorded as verified, so the switch itself
    // cannot lock out the users the app already has.
    await ensureEmailVerifiedColumn(workspaceSchemaName(projectId))
  }

  const data = {
    ...(appName !== undefined && { appName: appName || null }),
    ...(appUrl !== undefined && { appUrl: appUrl || null }),
    ...(requireEmailVerification !== undefined && { requireEmailVerification }),
    ...(magicLinksEnabled !== undefined && { magicLinksEnabled }),
  }
  await prisma.projectAuthConfig.upsert({
    where: { projectId },
    create: { projectId, ...data },
    update: data,
  })
  return { ok: true, policy: (await getAuthEmailPolicy(projectId))! }
}

/**
 * End-user sign-in in the change history (lib/changes/resources).
 *
 *   settings   app name and URL, email verification, magic links
 *   providers  each OAuth provider's client id, scopes, redirect and switch
 *   smtp       the project's own email sender
 *   templates  each customised email template
 *
 * Settings and templates come back exactly. A provider's client secret and the
 * SMTP password are secrets and never come back: a restore leaves the one in
 * place, and a provider or sender a change removed, secret and all, stays
 * removed. A provider's `<provider>_auth` marker (ProjectIntegrationKey) is
 * part of the provider, so it follows it.
 */

import { prisma } from '@/lib/db/prisma'
import { changedSecrets, encryptedVersion, secretDigest, type Irreversible, type ResourceAdapter, type ResourceItem, type ResourceOp, type Tx } from './core'

export const authAdapter: ResourceAdapter = {
  id: 'auth',

  async capture(projectId) {
    const [settings, providers, smtp, templates, markers] = await Promise.all([
      prisma.projectAuthConfig.findUnique({ where: { projectId } }),
      prisma.workspaceOAuthConfig.findMany({ where: { projectId } }),
      prisma.projectEmailConfig.findUnique({ where: { projectId } }),
      prisma.projectEmailTemplate.findMany({ where: { projectId } }),
      prisma.projectIntegrationKey.findMany({ where: { projectId, integrationId: { endsWith: '_auth' } }, select: { integrationId: true } }),
    ])
    const out: Record<string, ResourceItem> = {}
    if (settings) {
      out['auth:settings'] = {
        label: 'sign-in settings',
        fields: {
          appName: settings.appName, appUrl: settings.appUrl,
          requireEmailVerification: settings.requireEmailVerification, magicLinksEnabled: settings.magicLinksEnabled,
        },
      }
    }
    const marked = new Set(markers.map((m) => m.integrationId.slice(0, -'_auth'.length)))
    for (const p of providers) {
      out[`oauth:${p.provider}`] = {
        label: `${p.provider} sign-in`,
        fields: { provider: p.provider, clientId: p.clientId, redirectUri: p.redirectUri, scopes: [...p.scopes].sort(), enabled: p.enabled, marker: marked.has(p.provider) },
        secrets: { clientSecret: secretDigest(p.clientSecret) },
      }
      marked.delete(p.provider)
    }
    // A marker with no provider config is plumbing left behind; it is still state.
    for (const provider of marked) {
      out[`oauth:${provider}`] = { label: `${provider} sign-in`, fields: { provider, marker: true } }
    }
    if (smtp) {
      out['smtp'] = {
        label: 'email sender (SMTP)',
        fields: { enabled: smtp.enabled, host: smtp.host, port: smtp.port, username: smtp.username, fromAddress: smtp.fromAddress, fromName: smtp.fromName },
        secrets: { password: encryptedVersion(smtp.passwordIv) },
      }
    }
    for (const t of templates) {
      out[`template:${t.kind}`] = { label: `${t.kind.replace(/_/g, ' ')} email template`, fields: { kind: t.kind, subject: t.subject, bodyHtml: t.bodyHtml } }
    }
    return out
  },

  irreversible(op: ResourceOp): Irreversible | null {
    const secretless = !op.before?.secrets || Object.keys(op.before.secrets).length === 0
    if (op.before && !op.after && !secretless) {
      const what = op.key === 'smtp' ? 'its password' : 'its client secret'
      return { reason: `${capital(op.before.label)} was removed with ${what}, which is not kept, so it does not come back: set it up again.`, partial: false }
    }
    if (op.before && op.after && changedSecrets(op.before, op.after).length > 0) {
      const what = op.key === 'smtp' ? 'password' : 'client secret'
      return { reason: `The ${what} of ${op.after.label} was replaced, and the old one is not kept: the new one stays.`, partial: true }
    }
    // The marker is written through the credential store, which verifies what
    // it files; a restore does not re-file one.
    if (op.before?.fields.marker === true && op.after?.fields.marker !== true) {
      return { reason: `${capital(op.before.label)} is no longer marked as configured, and a restore does not mark it again: save it once more from Auth.`, partial: !!op.after }
    }
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const f = (op.before?.fields ?? {}) as Record<string, any>
    if (op.key === 'auth:settings') {
      if (!op.before) await tx.projectAuthConfig.deleteMany({ where: { projectId } })
      else {
        const data = { appName: f.appName, appUrl: f.appUrl, requireEmailVerification: f.requireEmailVerification, magicLinksEnabled: f.magicLinksEnabled }
        await tx.projectAuthConfig.upsert({ where: { projectId }, create: { projectId, ...data }, update: data })
      }
      return
    }
    if (op.key.startsWith('template:')) {
      const kind = op.key.slice('template:'.length)
      if (!op.before) await tx.projectEmailTemplate.deleteMany({ where: { projectId, kind } })
      else await tx.projectEmailTemplate.upsert({
        where: { projectId_kind: { projectId, kind } },
        create: { projectId, kind, subject: f.subject, bodyHtml: f.bodyHtml },
        update: { subject: f.subject, bodyHtml: f.bodyHtml },
      })
      return
    }
    if (op.key === 'smtp') {
      if (!op.before) await tx.projectEmailConfig.deleteMany({ where: { projectId } })
      // Settings only: the password in place stays.
      else await tx.projectEmailConfig.updateMany({
        where: { projectId },
        data: { enabled: f.enabled, host: f.host, port: f.port, username: f.username, fromAddress: f.fromAddress, fromName: f.fromName },
      })
      return
    }
    if (op.key.startsWith('oauth:')) {
      const provider = op.key.slice('oauth:'.length)
      const marker = `${provider}_auth`
      if (!op.before) {
        await tx.workspaceOAuthConfig.deleteMany({ where: { projectId, provider } })
        await tx.projectIntegrationKey.deleteMany({ where: { projectId, integrationId: marker } })
        return
      }
      if ('clientId' in f) {
        await tx.workspaceOAuthConfig.updateMany({
          where: { projectId, provider },
          data: { clientId: f.clientId, redirectUri: f.redirectUri, scopes: f.scopes, enabled: f.enabled },
        })
      }
      if (f.marker === false) await tx.projectIntegrationKey.deleteMany({ where: { projectId, integrationId: marker } })
    }
  },
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

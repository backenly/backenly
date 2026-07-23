/**
 * INTEGRATION HEALTH MONITOR
 * ==========================
 * Pillar 3.3 — Checks that stored integrations are still operational.
 *
 * For each stored integration key the monitor:
 *  - Validates the key against the provider's live API
 *  - Counts recent delivery failures
 *  - Checks configuration completeness (redirect URIs, SMTP credentials)
 *
 * A broken Stripe integration means broken payments for the user's end-customers.
 * A broken SMTP integration means lost emails. These are trust-critical.
 *
 * Runs on every workspace-observer cycle. Writes HealthFinding records
 * via the observer pipeline — does NOT write directly to the DB.
 */

import { prisma } from '@/lib/db/prisma'
import { getIntegrationKey, hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { resolveSmtpPort } from '@/lib/email/smtp-transport'
import { getProviderSpec, resolveProviderId } from '@/lib/services/ai-functions/integration-registry'
import type { RawFinding } from './types'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all integration health checks for a project.
 * Composes results from Stripe, Email, and OAuth sub-checks.
 */
export async function checkIntegrationHealth(
  projectId: string,
): Promise<RawFinding[]> {
  const [stripeFindings, emailFindings, oauthFindings, unusedFindings] = await Promise.allSettled([
    checkStripeHealth(projectId),
    checkEmailHealth(projectId),
    checkOAuthHealth(projectId),
    checkUnusedIntegrations(projectId),
  ])

  return [
    ...(stripeFindings.status === 'fulfilled' ? stripeFindings.value : []),
    ...(emailFindings.status  === 'fulfilled' ? emailFindings.value  : []),
    ...(oauthFindings.status  === 'fulfilled' ? oauthFindings.value  : []),
    ...(unusedFindings.status === 'fulfilled' ? unusedFindings.value : []),
  ]
}

// ─── Connected-but-unused nudge ─────────────────────────────────────────────────
// A key is stored but nothing consumes it — the user connected a provider and
// then never told the AI what to build with it. Surface a gentle, actionable
// nudge (dashboard "A few things to clear" only — never Monitoring). Detect-only:
// info severity, not auto-fixable. Resolving it is a one-line chat command.

/** Credential ids that are auxiliary to a real provider, not standalone connectors. */
function isAuxCredentialId(id: string): boolean {
  return /_(webhook_secret|app_id|host|auth|secret|client_id|client_secret)$/i.test(id)
}

async function checkUnusedIntegrations(projectId: string): Promise<RawFinding[]> {
  const [keyRows, fns] = await Promise.all([
    prisma.projectIntegrationKey
      .findMany({ where: { projectId }, select: { integrationId: true } })
      .catch(() => [] as { integrationId: string }[]),
    prisma.aiFunction
      .findMany({ where: { projectId }, select: { generatedCode: true } })
      .catch(() => [] as { generatedCode: string | null }[]),
  ])

  if (keyRows.length === 0) return []

  // All generated function code, lower-cased, as one haystack for usage detection.
  const codeHaystack = fns.map((f) => (f.generatedCode ?? '').toLowerCase()).join('\n')

  // Resolve stored credentials to canonical provider ids (dedup Stripe key +
  // stripe_webhook_secret → one 'stripe'; resend + sendgrid stay distinct).
  const connectedProviders = new Set<string>()
  for (const row of keyRows) {
    const id = row.integrationId
    if (isAuxCredentialId(id)) continue
    const canonical = resolveProviderId(id)
    // Only nudge for first-class connectors — a custom/unknown key (env-var style)
    // is used via ctx.env + ctx.http and cannot be "wired" by us.
    if (canonical) connectedProviders.add(canonical)
  }

  const findings: RawFinding[] = []
  for (const providerId of connectedProviders) {
    const spec = getProviderSpec(providerId)
    if (!spec) continue

    // "Used" = any generated function references ctx.integrations.<id|alias>.
    const names = [spec.id, ...spec.connectedNames].map((n) => n.toLowerCase())
    const used = names.some((n) => codeHaystack.includes(`integrations.${n}`))
    if (used) continue

    findings.push({
      type: 'integration_connected_unused',
      severity: 'info',
      details: {
        integration: spec.id,
        provider: spec.displayName,
        reason: `${spec.displayName} is connected but nothing uses it yet.`,
        suggestion: `Ask the AI in chat to put ${spec.displayName} to work — e.g. "use my ${spec.displayName} connection to …". It will build the function/trigger that calls it.`,
      },
      autoFixable: false,
    })
  }

  return findings
}

// ─── Stripe ───────────────────────────────────────────────────────────────────

async function checkStripeHealth(projectId: string): Promise<RawFinding[]> {
  const stripeStored = await hasIntegrationKey(projectId, 'stripe').catch(() => false)
  if (!stripeStored) return []

  const findings: RawFinding[] = []

  // 1. Validate API key against Stripe's /v1/balance endpoint
  const apiKey = await getIntegrationKey(projectId, 'stripe').catch(() => null)
  if (apiKey) {
    try {
      const res = await fetch('https://api.stripe.com/v1/balance', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        findings.push({
          type: 'integration_key_invalid',
          severity: 'critical',
          details: {
            integration: 'stripe',
            httpStatus: res.status,
            stripeError: (body as any)?.error?.message ?? 'Unknown',
            reason: `Stripe API key is invalid or revoked (HTTP ${res.status})`,
          },
          autoFixable: false,
        })
      }
    } catch (err: any) {
      // Network failure — don't flag as invalid key, flag as unreachable
      findings.push({
        type: 'integration_key_invalid',
        severity: 'warning',
        details: {
          integration: 'stripe',
          error: err?.message ?? String(err),
          reason: 'Could not reach Stripe API to validate key — possible network issue',
        },
        autoFixable: false,
      })
    }
  }

  // 2. Count webhook dead-letter failures in last 24 h
  const deadCount = await prisma.triggerDeliveryLog
    .count({
      where: {
        projectId,
        status: 'DEAD',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        trigger: {
          webhookUrl: { contains: 'stripe' },
        },
      },
    })
    .catch(() => 0)

  if (deadCount > 0) {
    findings.push({
      type: 'integration_webhook_failing',
      severity: 'critical',
      details: {
        integration: 'stripe',
        failureCount: deadCount,
        windowHours: 24,
        reason: `${deadCount} Stripe webhook(s) dead-lettered in the last 24 hours`,
      },
      autoFixable: false,
    })
  }

  return findings
}

// ─── Email / SMTP ─────────────────────────────────────────────────────────────

async function checkEmailHealth(projectId: string): Promise<RawFinding[]> {
  // A project can store its OWN SMTP credentials under the integrationId 'smtp'.
  // The default email config lives in platform-wide env vars (SMTP_HOST/…).
  const customSmtpStored = await hasIntegrationKey(projectId, 'smtp').catch(() => false)

  // Platform SMTP is the OPERATOR'S shared infrastructure — not something the
  // project owner can fix. Surfacing "platform SMTP unreachable" as a per-project
  // "Waiting on you" item is pure noise: it is identical across every project,
  // the owner (often a non-developer) has no lever to fix it, and the only fix
  // action we can map (FIX_INTEGRATION) inspects the project key-vault, which is
  // empty for platform SMTP — so it dead-ends at NO_INTEGRATIONS every time.
  // Platform SMTP reachability is monitored as an operator/ops concern instead.
  // We therefore only raise this finding for a project's OWN custom SMTP key.
  if (!customSmtpStored) return []

  const host = await getIntegrationKey(projectId, 'smtp_host').catch(() => null) ?? process.env.SMTP_HOST
  if (!host) return []

  const configuredPort = parseInt(
    (await getIntegrationKey(projectId, 'smtp_port').catch(() => null)) ?? process.env.SMTP_PORT ?? '587',
    10,
  )

  // Probe the EFFECTIVE port we actually send on. Port 465 (implicit TLS) is
  // blocked outbound on our host, so the sender normalizes it to 587 (STARTTLS);
  // probing 465 here would false-flag a config that in fact sends fine on 587.
  const { port } = resolveSmtpPort(configuredPort)

  const reachable = await tcpProbe(host, port, 5_000)

  if (!reachable) {
    return [
      {
        type: 'integration_smtp_unreachable',
        severity: 'warning',
        details: {
          integration: 'smtp',
          host,
          port,
          reason: `SMTP host "${host}:${port}" is unreachable — outbound emails will fail`,
        },
        autoFixable: false,
      },
    ]
  }

  return []
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

async function checkOAuthHealth(projectId: string): Promise<RawFinding[]> {
  const configs = await prisma.workspaceOAuthConfig
    .findMany({
      where: { projectId, enabled: true },
      select: { provider: true, clientId: true, clientSecret: true, redirectUri: true },
    })
    .catch(() => [])

  const findings: RawFinding[] = []

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  for (const cfg of configs) {
    // Missing clientId or clientSecret — OAuth will always fail
    if (!cfg.clientId || !cfg.clientSecret) {
      findings.push({
        type: 'oauth_config_invalid',
        severity: 'critical',
        details: {
          provider: cfg.provider,
          reason: `OAuth provider "${cfg.provider}" is missing clientId or clientSecret`,
        },
        autoFixable: false,
      })
      continue
    }

    // Redirect URI references a different domain than the current app URL —
    // common misconfiguration after a domain change
    if (cfg.redirectUri && appUrl) {
      try {
        const redirectHost = new URL(cfg.redirectUri).host
        const appHost = new URL(appUrl).host
        if (redirectHost !== appHost) {
          findings.push({
            type: 'oauth_config_invalid',
            severity: 'warning',
            details: {
              provider: cfg.provider,
              redirectUri: cfg.redirectUri,
              currentAppUrl: appUrl,
              reason: `OAuth redirect URI domain "${redirectHost}" does not match app domain "${appHost}"`,
            },
            autoFixable: false,
          })
        }
      } catch {
        // Malformed URL — flag it
        findings.push({
          type: 'oauth_config_invalid',
          severity: 'warning',
          details: {
            provider: cfg.provider,
            redirectUri: cfg.redirectUri,
            reason: `OAuth provider "${cfg.provider}" has a malformed redirect URI`,
          },
          autoFixable: false,
        })
      }
    }
  }

  return findings
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Dynamic require avoids bundler issues in edge runtimes
    let net: typeof import('net')
    try {
      net = require('net')
    } catch {
      resolve(true) // Can't probe — assume reachable to avoid false positives
      return
    }
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * WHICH INTEGRATIONS A FUNCTION'S CODE USES, AND WHICH OF THEM IT CANNOT REACH
 * ===========================================================================
 * A function reaches a provider only through ctx.integrations.<id>, and that
 * object exists only when the project has the provider's key
 * (integration-context.ts buildIntegrationContext). Code written for a
 * provider nobody connected runs and gets nothing: production QA (2026-11-09)
 * watched a shipping-email function log "NOT SENT: no email provider
 * connected" on every order update while Overview and readiness stayed green.
 *
 * Code often allows for more than one provider of a kind ("Resend, else
 * SendGrid"), so a kind is missing only when NONE of the providers the code
 * names for it is connected. A function that needs two providers of one kind
 * and has one of them throws on the other, and a function that keeps failing
 * is reported by lib/autonomy/function-failures.ts.
 *
 * Pure: code and the vault ids a project has stored in, no database.
 */

import {
  getProviderSpec,
  resolveProviderId,
  type IntegrationCategory,
} from './integration-registry'

export interface MissingIntegration {
  /** The kind of provider, e.g. 'email'. */
  category: IntegrationCategory
  /** The names the code uses for it, as written: ['email'], or ['resend', 'sendgrid']. */
  uses: string[]
  /** Vault ids, any one of which the code can use: ['resend', 'sendgrid']. */
  connect: string[]
  /** The same, as a person reads it: "Resend or SendGrid". */
  connectLabel: string
}

/**
 * The code with its comments blanked, so a commented-out call is not a use.
 * Strings are kept: ctx.integrations['email'] names its provider in one.
 */
function withoutComments(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      i = end === -1 ? code.length : end
      continue
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? code.length : end + 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1
      out += code.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

// `ctx.integrations`, or `integrations` on its own (taken from ctx), never a
// property of something else: `config.integrations.stripe` is not a use.
const INTEGRATIONS = String.raw`(?:\bctx\s*(?:\?\.|\.)\s*|(?<![\w$.?]))integrations\s*`
const PROPERTY = new RegExp(String.raw`${INTEGRATIONS}(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)`, 'g')
const INDEXED = new RegExp(String.raw`${INTEGRATIONS}(?:\?\.)?\s*\[\s*(['"\x60])([\w$-]+)\1\s*\]`, 'g')
const IS_CONNECTED = new RegExp(String.raw`${INTEGRATIONS}(?:\?\.|\.)\s*isConnected\s*\(\s*(['"\x60])([\w$-]+)\1\s*\)`, 'g')
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*ctx\s*(?:\?\.|\.)\s*integrations\b/g

/**
 * The providers a function's code uses through ctx.integrations, each with the
 * name the code wrote and the provider it means. Names that are not a provider
 * (isConnected) are left out.
 */
export function integrationsUsedBy(code: string): Array<{ name: string; provider: string }> {
  const text = withoutComments(code)
  const names: string[] = []
  for (const m of text.matchAll(PROPERTY)) names.push(m[1])
  for (const m of text.matchAll(INDEXED)) names.push(m[2])
  for (const m of text.matchAll(IS_CONNECTED)) names.push(m[2])
  for (const m of text.matchAll(DESTRUCTURED)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/[:=]/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
    }
  }
  const used = new Map<string, string>()
  for (const name of names) {
    const provider = resolveProviderId(name)
    if (provider && !used.has(name.toLowerCase())) used.set(name.toLowerCase(), provider)
  }
  return [...used].map(([name, provider]) => ({ name, provider }))
}

/** "Resend", "Resend or SendGrid", "A, B or C". */
function eitherOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/**
 * The kinds of provider the code uses that none of its providers can serve,
 * given the vault ids the project has a key in.
 */
export function missingIntegrations(
  used: Array<{ name: string; provider: string }>,
  stored: ReadonlySet<string>,
): MissingIntegration[] {
  const byCategory = new Map<IntegrationCategory, Array<{ name: string; provider: string }>>()
  for (const use of used) {
    const spec = getProviderSpec(use.provider)
    if (!spec) continue
    byCategory.set(spec.category, [...(byCategory.get(spec.category) ?? []), use])
  }

  const missing: MissingIntegration[] = []
  for (const [category, uses] of byCategory) {
    const connect = [...new Set(uses.flatMap((u) => getProviderSpec(u.provider)?.keyStoreIds ?? []))]
    if (connect.length === 0 || connect.some((id) => stored.has(id))) continue
    const names = [...new Set(connect.map((id) => getProviderSpec(resolveProviderId(id) ?? id)?.displayName ?? id))]
    missing.push({ category, uses: uses.map((u) => u.name), connect, connectLabel: eitherOf(names) })
  }
  return missing
}

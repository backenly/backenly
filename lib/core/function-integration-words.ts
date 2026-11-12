/**
 * What a function that uses an unconnected integration is told, in one place:
 * the finding's summary and hint, and the answer to the deploy that put it
 * there. Pure and import-free, so the console's finding panels can use it.
 *
 * `missing` is what lib/services/ai-functions/integration-use.ts found: per
 * kind of provider, the names the code used and the providers that would do.
 */

export interface MissingIntegrationWords {
  /** As the code wrote them: ['email']. */
  uses: string[]
  /** Vault ids, any one of which would do: ['resend', 'sendgrid']. */
  connect: string[]
  /** "Resend or SendGrid". */
  connectLabel: string
}

/** A finding's `missing`, as stored, or [] when it is not that shape. */
export function missingFrom(value: unknown): MissingIntegrationWords[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((m) => {
    const uses = Array.isArray(m?.uses) ? m.uses.filter((u: unknown): u is string => typeof u === 'string') : []
    const connect = Array.isArray(m?.connect) ? m.connect.filter((c: unknown): c is string => typeof c === 'string') : []
    const connectLabel = typeof m?.connectLabel === 'string' ? m.connectLabel : ''
    return uses.length > 0 && connectLabel ? [{ uses, connect, connectLabel }] : []
  })
}

function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "ctx.integrations.email", "ctx.integrations.stripe and ctx.integrations.email". */
function usesPhrase(missing: MissingIntegrationWords[]): string {
  return andList(missing.flatMap((m) => m.uses).map((name) => `ctx.integrations.${name}`))
}

/** "no Resend or SendGrid key", "no Stripe key and no Resend or SendGrid key". */
function noKeyPhrase(missing: MissingIntegrationWords[]): string {
  return missing.map((m) => `no ${m.connectLabel} key`).join(' and ')
}

/** "Stripe", "Resend or SendGrid", "Stripe, and Resend or SendGrid". */
function connectPhrase(missing: MissingIntegrationWords[]): string {
  const labels = missing.map((m) => m.connectLabel)
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

/** How the provider gets connected, as the rest of the sentence: "it is", "one is", "they are". */
function onceConnected(missing: MissingIntegrationWords[]): string {
  if (missing.length > 1) return 'they are'
  return missing[0].connect.length > 1 ? 'one is' : 'it is'
}

/** The one line a finding list shows. */
export function missingIntegrationSummary(name: string, missing: MissingIntegrationWords[]): string {
  if (missing.length === 0) return `\`${name}\` uses an integration that isn't connected`
  if (missing.length > 1) {
    return `\`${name}\` uses ${missing.length} integrations that aren't connected: ${connectPhrase(missing)}`
  }
  const [only] = missing
  if (only.connect.length <= 1) return `\`${name}\` uses ${only.connectLabel}, which isn't connected`
  return `\`${name}\` uses ${only.connectLabel}, and ${only.connect.length === 2 ? 'neither' : 'none'} is connected`
}

/** What the finding says to do, under the line. `trigger` is triggerPhrase's "runs when …". */
export function missingIntegrationHint(name: string, trigger: string, missing: MissingIntegrationWords[]): string {
  if (missing.length === 0) {
    return (
      `${name} ${trigger}, and its code uses an integration that isn't connected on this project. ` +
      `Connect it on the Integrations page, or ask your coding agent to change ${name} so it doesn't need it.`
    )
  }
  const many = missing.length > 1
  return (
    `${name} ${trigger}. Its code uses ${usesPhrase(missing)}, which ${many ? 'are' : 'is'} undefined on this ` +
    `project because ${noKeyPhrase(missing)} ${many ? 'are' : 'is'} connected, so ` +
    `${many ? 'those parts' : 'that part'} of ${name} ${many ? "aren't" : "isn't"} working.` +
    `\n\nConnect ${connectPhrase(missing)}${many ? ',' : ''} on the Integrations page, or ask your coding agent to change ${name} ` +
    `so it doesn't need ${many ? 'them' : 'it'}. This clears once ${onceConnected(missing)} connected or ` +
    `${name} no longer uses ${many ? 'them' : 'it'}.`
  )
}

/** What the deploy answer adds, for the agent that deployed it: ". Its code uses …". */
export function missingIntegrationDeployNote(missing: MissingIntegrationWords[]): string {
  if (missing.length === 0) return ''
  return (
    `. Its code uses ${usesPhrase(missing)}, and this project has ${noKeyPhrase(missing)}, so those calls ` +
    `can't work until ${onceConnected(missing)} connected with integrations { action: "connect" }`
  )
}

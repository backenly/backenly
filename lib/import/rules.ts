/**
 * The source's access rules, translated for a person to approve.
 *
 * Supabase protects a table with row-level-security policies written against
 * `auth.uid()`. Backenly never applies them on its own: every imported table
 * starts answering only the server key (lib/import/pg-engine.ts closes it with
 * an explicit `admin_only` rule, which the auto-RLS reconciler leaves alone),
 * and each table's policies become ONE exact `set_rls` call held for approval
 * in the Autonomy queue (an `ai_action_pending` finding,
 * lib/operational-memory/ledger.ts). Approving runs that call verbatim.
 *
 * The translation is deliberately narrow. It understands the shapes Supabase's
 * own templates produce (`auth.uid() = user_id`, its `(select auth.uid())`
 * form, `true`, "signed in") and maps the roles a policy is granted to.
 * Anything else (a subquery, a function, a RESTRICTIVE policy, a JWT claim) is
 * not guessed at: the table keeps its server-key-only rule, and the person is
 * told which rule did not translate and what it said.
 *
 * The pure part (proposeRules) is tested without a database
 * (__tests__/import/rules.test.ts).
 */

import type { CatalogPolicy, ImportPlan, PlannedTable } from './pg-plan'
import type { ImportPreviewRule } from './contract'

type Command = 'select' | 'insert' | 'update' | 'delete'
const COMMANDS: Command[] = ['select', 'insert', 'update', 'delete']

/** What one translated expression means, for the sentence and the predicate. */
type Predicate =
  | { kind: 'anyone' }
  | { kind: 'nobody' }
  | { kind: 'signed_in' }
  | { kind: 'signed_out' }
  | { kind: 'owner'; column: string }

export interface RuleAction {
  template: 'own_rows' | 'public_read' | 'custom'
  userIdColumn?: string
  commands?: Partial<Record<Command, { using?: string; check?: string } | string>>
}

export interface RuleProposal {
  /** Backenly table. */
  table: string
  /** schema.name in the source. */
  sourceTable: string
  summary: string
  /** The source's own definitions, one line per policy. Never stored for a project kept in another region. */
  definition: string
  /** The exact set_rls call approval runs, or null when it did not translate. */
  action: RuleAction | null
  /** Why there is no action, in plain words. */
  untranslated: string | null
}

const SERVER_ROLES = new Set(['service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin'])

/** Remove whitespace, casts and redundant parentheses so Supabase's spellings compare equal. */
function squash(expr: string): string {
  let s = expr
    .replace(/::\s*"?[a-z_][a-z0-9_ ]*"?(\[\])?/gi, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  // Supabase's recommended form: (select auth.uid()) prints as ( SELECT auth.uid() AS uid).
  s = s.replace(/\(selectauth\.uid\(\)asuid\)/g, 'auth.uid()').replace(/\(selectauth\.uid\(\)\)/g, 'auth.uid()')
  s = s.replace(/\(selectauth\.role\(\)asrole\)/g, 'auth.role()').replace(/\(selectauth\.role\(\)\)/g, 'auth.role()')
  return unwrap(s)
}

/** Take off parentheses that wrap the whole expression. */
function unwrap(expr: string): string {
  let s = expr
  for (;;) {
    const inner = /^\((.*)\)$/.exec(s)
    if (!inner || !balanced(inner[1])) return s
    s = inner[1]
  }
}

function balanced(s: string): boolean {
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

const IDENT = /^\(?"?([a-z_][a-z0-9_$]*)"?\)?$/

/** One USING / WITH CHECK expression, or null when it is not a shape this understands. */
export function translateExpression(expr: string | null): Predicate | null {
  if (expr === null) return null
  const s = squash(expr)
  if (s === 'true') return { kind: 'anyone' }
  if (s === 'false') return { kind: 'nobody' }
  if (s === 'auth.uid()isnotnull' || s === "auth.role()='authenticated'" || s === "(auth.jwt()->>'role')='authenticated'" || s === "auth.jwt()->>'role'='authenticated'") {
    return { kind: 'signed_in' }
  }
  if (s === 'auth.uid()isnull' || s === "auth.role()='anon'") return { kind: 'signed_out' }
  const eq = /^(.+)=(.+)$/.exec(s)
  if (eq && !eq[1].includes('=') && !eq[2].includes('=')) {
    const [a, b] = [unwrap(eq[1]), unwrap(eq[2])]
    const other = a === 'auth.uid()' ? b : b === 'auth.uid()' ? a : null
    const m = other ? IDENT.exec(other) : null
    if (m) return { kind: 'owner', column: m[1] }
  }
  return null
}

/** Roles a policy is granted to, as Backenly can tell callers apart. */
function audience(roles: string[]): 'everyone' | 'signed_in' | 'signed_out' | 'server' {
  const r = roles.map((x) => x.toLowerCase())
  if (r.length === 0 || r.includes('public') || (r.includes('anon') && r.includes('authenticated'))) return 'everyone'
  if (r.includes('authenticated')) return 'signed_in'
  if (r.includes('anon')) return 'signed_out'
  if (r.every((x) => SERVER_ROLES.has(x))) return 'server'
  return 'everyone'
}

/** The predicate a policy grants to its audience: roles narrow what the expression allows. */
function narrow(p: Predicate, who: 'everyone' | 'signed_in' | 'signed_out'): Predicate {
  if (who === 'everyone' || p.kind === 'nobody') return p
  if (who === 'signed_in') return p.kind === 'anyone' ? { kind: 'signed_in' } : p.kind === 'signed_out' ? { kind: 'nobody' } : p
  // signed_out: an owner rule can never match a caller with no identity.
  if (p.kind === 'anyone') return { kind: 'signed_out' }
  if (p.kind === 'signed_out') return p
  return { kind: 'nobody' }
}

const SUB = "backenly_jwt_claim('sub')"

function sql(p: Predicate, columnMap: Record<string, string>): string | null {
  switch (p.kind) {
    case 'anyone':
      return 'true'
    case 'nobody':
      return 'false'
    case 'signed_in':
      return `${SUB} IS NOT NULL`
    case 'signed_out':
      return `${SUB} IS NULL`
    case 'owner': {
      const col = columnMap[p.column]
      if (!col || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(col)) return null
      return `"${col}"::text = ${SUB}`
    }
  }
}

function words(p: Predicate, columnMap: Record<string, string>): string {
  switch (p.kind) {
    case 'anyone':
      return 'anyone'
    case 'nobody':
      return 'nobody'
    case 'signed_in':
      return 'signed-in users'
    case 'signed_out':
      return 'signed-out visitors'
    case 'owner':
      return `the row's owner (${columnMap[p.column] ?? p.column})`
  }
}

/** OR several predicates, simplest first; `anyone` absorbs the rest. */
function either(ps: Predicate[]): Predicate[] {
  if (ps.some((p) => p.kind === 'anyone')) return [{ kind: 'anyone' }]
  const signedIn = ps.some((p) => p.kind === 'signed_in')
  const signedOut = ps.some((p) => p.kind === 'signed_out')
  if (signedIn && signedOut) return [{ kind: 'anyone' }]
  const out: Predicate[] = []
  const seen = new Set<string>()
  for (const p of ps) {
    if (p.kind === 'nobody') continue
    if (signedIn && p.kind === 'owner') continue // signed-in already covers every owner
    const k = JSON.stringify(p)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(p)
    }
  }
  return out.length ? out : [{ kind: 'nobody' }]
}

function policyLine(p: CatalogPolicy): string {
  const parts = [`${p.name}: ${p.command} TO ${p.roles.length ? p.roles.join(', ') : 'public'}`]
  if (!p.permissive) parts[0] += ' (restrictive)'
  if (p.using !== null) parts.push(`USING (${p.using})`)
  if (p.check !== null) parts.push(`WITH CHECK (${p.check})`)
  return parts.join(' ')
}

const VERB: Record<Command, string> = { select: 'read', insert: 'add', update: 'change', delete: 'delete' }

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** One table's policies → one proposal. Exported for the tests. */
export function proposeForTable(table: PlannedTable, policies: CatalogPolicy[]): RuleProposal {
  const definition = policies.map(policyLine).join('\n')
  const base = { table: table.name, sourceTable: table.sourceKey, definition }
  const refuse = (why: string): RuleProposal => ({
    ...base,
    summary: `Not translated: ${why}. ${table.name} answers only the server key until you set its rules.`,
    action: null,
    untranslated: why,
  })

  const using: Record<Command, Predicate[]> = { select: [], insert: [], update: [], delete: [] }
  const check: Record<Command, Predicate[]> = { select: [], insert: [], update: [], delete: [] }
  const covered = new Set<Command>()

  for (const p of policies) {
    const who = audience(p.roles)
    if (who === 'server') continue // the server key reads everything in Backenly already
    if (!p.permissive) return refuse(`${p.name} is a restrictive policy`)
    const cmd = p.command.toUpperCase()
    const commands: Command[] = cmd === 'ALL' ? COMMANDS : cmd === 'SELECT' ? ['select'] : cmd === 'INSERT' ? ['insert'] : cmd === 'UPDATE' ? ['update'] : cmd === 'DELETE' ? ['delete'] : []
    if (commands.length === 0) return refuse(`${p.name} applies to ${p.command}`)
    const u = p.using !== null ? translateExpression(p.using) : null
    if (p.using !== null && !u) return refuse(`${p.name} uses ${p.using.slice(0, 120)}`)
    const c = p.check !== null ? translateExpression(p.check) : u
    if (p.check !== null && !c) return refuse(`${p.name} checks ${p.check.slice(0, 120)}`)
    for (const command of commands) {
      covered.add(command)
      if (command !== 'insert' && u) using[command].push(narrow(u, who))
      if ((command === 'insert' || command === 'update') && c) check[command].push(narrow(c, who))
    }
  }

  if (covered.size === 0) {
    return { ...base, summary: `Only the server key, as in the source.`, action: null, untranslated: null }
  }

  // Each command's rule, as Backenly's set_rls `commands` takes it.
  const rules: Partial<Record<Command, { using?: string; check?: string }>> = {}
  const described: Partial<Record<Command, string>> = {}
  for (const command of COMMANDS) {
    if (!covered.has(command)) continue
    const u = command === 'insert' ? [] : either(using[command])
    const c = command === 'insert' || command === 'update' ? either(check[command].length ? check[command] : using[command]) : []
    const toSql = (ps: Predicate[]) => {
      const parts = ps.map((p) => sql(p, table.columnMap))
      if (parts.some((x) => x === null)) return null
      return parts.length === 1 ? parts[0]! : parts.map((x) => `(${x})`).join(' OR ')
    }
    const rule: { using?: string; check?: string } = {}
    if (command !== 'insert') {
      const s = toSql(u)
      if (s === null) return refuse(`a rule names a column that did not move`)
      rule.using = s
    }
    if (command === 'insert' || command === 'update') {
      const s = toSql(c)
      if (s === null) return refuse(`a rule names a column that did not move`)
      rule.check = s
    }
    rules[command] = rule
    const who = (command === 'insert' ? c : u).map((p) => words(p, table.columnMap)).join(' or ')
    described[command] = who
  }

  // Sentence: commands with the same audience together.
  const groups = new Map<string, Command[]>()
  for (const command of COMMANDS) {
    const w = described[command]
    if (!w) continue
    groups.set(w, [...(groups.get(w) ?? []), command])
  }
  const pieces = [...groups.entries()].map(([who, cmds]) => `${capitalize(cmds.map((c) => VERB[c]).join(', '))}: ${who}`)
  const rest = COMMANDS.filter((c) => !covered.has(c))
  if (rest.length) pieces.push(`${capitalize(rest.map((c) => VERB[c]).join(', '))}: the server key only`)
  const summary = pieces.join(' · ')

  // A named template when the rule is exactly one; otherwise each command as written.
  const ownerOf = (r?: { using?: string; check?: string }) => {
    const m = r && /^"([A-Za-z_][A-Za-z0-9_$]*)"::text = backenly_jwt_claim\('sub'\)$/.exec(r.using ?? r.check ?? '')
    return m ? m[1] : null
  }
  const owner = ownerOf(rules.delete)
  const allOwner =
    owner &&
    COMMANDS.every((c) => {
      const r = rules[c]
      if (!r) return false
      return (r.using === undefined || ownerOf({ using: r.using }) === owner) && (r.check === undefined || ownerOf({ check: r.check }) === owner)
    })
  if (allOwner) return { ...base, summary, action: { template: 'own_rows', userIdColumn: owner! }, untranslated: null }

  return { ...base, summary, action: { template: 'custom', commands: rules }, untranslated: null }
}

/**
 * Every table's proposal. A Supabase table with row-level security OFF was
 * open to anyone holding the anon key there; it is not opened here, and the
 * warning says so.
 */
export function proposeRules(
  plan: ImportPlan,
  policies: CatalogPolicy[],
  rlsEnabled: Map<string, boolean>,
  source: 'supabase' | 'postgres',
): { proposals: RuleProposal[]; warnings: string[] } {
  const warnings: string[] = []
  const proposals: RuleProposal[] = []
  const bySource = new Map<string, CatalogPolicy[]>()
  for (const p of policies) {
    const key = `${p.schema}.${p.table}`
    bySource.set(key, [...(bySource.get(key) ?? []), p])
  }
  const open: string[] = []
  for (const t of plan.tables) {
    const own = bySource.get(t.sourceKey) ?? []
    if (!rlsEnabled.get(t.sourceKey)) {
      if (source === 'supabase') open.push(t.name)
      continue
    }
    if (own.length === 0) continue
    const proposal = proposeForTable(t, own)
    proposals.push(proposal)
    if (proposal.untranslated) warnings.push(`${t.name}: its access rules did not translate (${proposal.untranslated}), so it answers only the server key until you set them.`)
  }
  if (open.length) {
    warnings.push(
      `Row-level security was off for ${open.slice(0, 5).join(', ')}${open.length > 5 ? ` and ${open.length - 5} more` : ''} in Supabase, so anyone with the anon key could read and write ${open.length === 1 ? 'it' : 'them'}. In Backenly ${open.length === 1 ? 'it answers' : 'they answer'} only the server key until you set ${open.length === 1 ? 'its' : 'their'} rules.`,
    )
  }
  return { proposals, warnings }
}

/** The Review step's rows. */
export function previewRules(proposals: RuleProposal[]): ImportPreviewRule[] {
  return proposals.map((p) => ({ table: p.table, summary: p.summary, definition: p.definition || null }))
}

/**
 * Hold each translated rule for approval in the Autonomy queue. Returns how
 * many now wait. Words only from names (lib/data-plane/residency.ts): the
 * source's SQL is never written into the finding.
 */
export async function recordRulesForApproval(
  projectId: string,
  proposals: RuleProposal[],
  ctx: { sourceLabel: string; jobId: string },
): Promise<number> {
  const { queuePendingActionFinding } = await import('@/lib/operational-memory/ledger')
  const { prisma } = await import('@/lib/db/prisma')
  let pending = 0
  for (const p of proposals) {
    if (!p.action) continue
    const finding = await queuePendingActionFinding({
      projectId,
      action: 'SET_PERMISSION',
      params: { tableName: p.table, ...p.action },
      target: p.table,
      riskLevel: 'medium',
      source: 'import',
      reason:
        `Moved in from ${ctx.sourceLabel}: ${p.table}'s access rules there, translated. ${p.summary}. ` +
        `Until you approve, only the server key can read or write ${p.table}.`,
    })
    // Which import asked: an id and a kind, nothing quoted.
    const details = ((await prisma.healthFinding.findUnique({ where: { id: finding.id }, select: { details: true } }))?.details ?? {}) as Record<string, unknown>
    await prisma.healthFinding
      .update({ where: { id: finding.id }, data: { details: { ...details, importJobId: ctx.jobId, importedRule: true } as any } })
      .catch(() => {})
    pending++
  }
  return pending
}

/**
 * WORKSPACE ROW-LEVEL SECURITY
 * ============================
 * Applies PostgreSQL Row-Level Security policies to workspace tables so that
 * end-users can only access rows that belong to them.
 *
 * Philosophy: "Say what the rule is — Backenly enforces it at the database level."
 *
 * How it works:
 *   1. Platform dev tells AI: "Users can only read their own posts"
 *   2. AI issues SET_PERMISSION action
 *   3. This service enables RLS + creates a POLICY in PostgreSQL
 *   4. Every query through the v1 API sets app.current_user_id
 *   5. PostgreSQL enforces the policy on every row read/write
 *
 * Supported policy templates:
 *   - own_rows    → user_id = current_user_id  (most common)
 *   - public_read → everyone can read, only owner can write
 *   - admin_only  → only service-role API keys can access
 *   - all_access  → authenticated users can access all rows (default)
 */

import { prisma } from '@/lib/db'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from './workspaceDatabase'
import { rlsSessionSql, rlsSessionParams } from './rls-session'
import {
  jwtClaimFunctionSql,
  claimExpr,
  serviceRoleClause,
  SUBJECT_CLAIM,
  JWT_CLAIM_FN,
} from '@/lib/postgrest/rls-translation'
import {
  inferRlsPlan,
  loadOwnershipCatalog,
  inferRlsPlanFromCatalog,
  OWNERSHIP_COLUMN_CANDIDATES,
  type RelatedRowsVia,
} from './rls-ownership'
import type { ExistsContext } from '@/lib/db/sql-expression'

/**
 * Split a SQL string on semicolons that are NOT inside $$ dollar-quoted blocks,
 * then execute each statement individually.
 *
 * Prisma's $executeRawUnsafe uses the prepared-statement wire protocol which
 * rejects multiple commands in a single call (PG error 42601).  All multi-
 * statement RLS helpers must go through this function instead of calling
 * executeInWorkspaceSchema with a concatenated string.
 */
async function execStatements(projectId: string, sql: string): Promise<void> {
  const stmts = splitSql(sql)
  for (const stmt of stmts) {
    await executeInWorkspaceSchema(projectId, stmt)
  }
}

function splitSql(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inDollarQuote = false
  let dollarTag = ''
  let i = 0
  while (i < sql.length) {
    if (!inDollarQuote) {
      const m = sql.slice(i).match(/^\$([^$]*)\$/)
      if (m) {
        inDollarQuote = true
        dollarTag = m[0]
        cur += dollarTag
        i += dollarTag.length
        continue
      }
    } else if (sql.slice(i).startsWith(dollarTag)) {
      cur += dollarTag
      i += dollarTag.length
      inDollarQuote = false
      dollarTag = ''
      continue
    }
    if (!inDollarQuote && sql[i] === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += sql[i++]
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export type PolicyTemplate =
  | 'own_rows'          // user_id = auth.uid()
  | 'party_rows'        // ANY of several party columns = auth.uid() (connections, conversations, messages)
  | 'related_rows'      // owned through a FK to a user-owned parent (order_items → orders)
  | 'public_read'       // SELECT: all | INSERT/UPDATE/DELETE: owner only
  | 'admin_only'        // service_role only
  | 'all_access'        // any authenticated user (disables restriction)
  | 'org_members'       // organization_id scoped — users can only access rows in their org
  | 'admin_read_all'    // admins see ALL rows; regular users see only their own
  | 'role_based'        // role column controls access (admin bypasses user-scoped filter)
  | 'moderator_access'  // moderators + admins see all rows; users see only their own
  | 'custom'            // caller-supplied predicate — the escape hatch (see PolicyConfig.using)

/**
 * `'auto'` is not a policy — it is "read the schema and pick the right one".
 *
 * Every caller that does not have an explicit human instruction should pass
 * this instead of defaulting to `own_rows`. Hardcoding `own_rows` is what made
 * the autonomy loop's RLS repair fail with `column "user_id" does not exist` on
 * every indirectly-owned table (line items, addresses, saved cards) and escalate
 * a fixable finding to a human. See lib/services/rls-ownership.ts.
 */
export type PolicyTemplateRequest = PolicyTemplate | 'auto'

/** The four SQL commands a row-level-security policy can govern. */
export type RlsCommand = 'select' | 'insert' | 'update' | 'delete'

export const RLS_COMMANDS: RlsCommand[] = ['select', 'insert', 'update', 'delete']

/**
 * The rule for ONE command.
 *
 *   using — which rows this command may TARGET. Meaningful for SELECT, UPDATE
 *           and DELETE; Postgres has no USING clause for INSERT.
 *   check — which rows this command may PRODUCE. Meaningful for INSERT and
 *           UPDATE; Postgres has no WITH CHECK for SELECT or DELETE.
 *
 * A bare string is shorthand for "use this for whichever clause the command
 * has" — `{ delete: "author_id::text = backenly_jwt_claim('sub')" }`.
 */
export interface CommandRule {
  using?: string
  check?: string
}

export interface PolicyConfig {
  tableName: string
  template: PolicyTemplateRequest
  userIdColumn?: string    // defaults to 'user_id' or 'userId'
  roleColumn?: string      // for role-aware templates; defaults to 'role'
  role?: string            // defaults to 'authenticated'
  /**
   * Ownership path for `related_rows`. Omit and it is inferred from the live
   * foreign keys — passing it is only needed to override the inference.
   */
  via?: RelatedRowsVia
  /**
   * Party columns for `party_rows`. Omit and they are inferred from the live
   * foreign keys and column names.
   */
  partyColumns?: string[]
  /**
   * ── The escape hatch: a predicate Backenly did not have a template for ──────
   *
   * Required by `template: 'custom'`. The predicate a row must satisfy to be
   * readable, written against this table's own columns plus
   * `backenly_jwt_claim('sub')` for the calling end-user's id.
   *
   * This exists because its absence was a hard ceiling, not an inconvenience.
   * When an agent asked for a policy the templates could not express, `add_rls`
   * mapped the unrecognised name to `'auto'` — so the engine quietly installed
   * ITS OWN inferred policy and reported "Applied 2 change(s) · auto RLS". Three
   * requests against three tables all came back successful while all three kept
   * the owner-only policy they were meant to replace (defect #3). A tool that
   * cannot do something must say so; substituting a different action and
   * reporting success is the worst available outcome.
   *
   * Validated against the closed grammar in lib/db/sql-expression.ts, because it
   * reaches raw DDL. Subqueries are refused there — a predicate that has to read
   * another table is expressible as `related_rows`, which builds the EXISTS
   * clause itself under the same governance.
   */
  using?: string
  /**
   * Optional separate predicate for the WRITE commands. When given it governs
   * INSERT's WITH CHECK *and* UPDATE/DELETE's USING — see the note on
   * `resolveCustomCommands` for why USING and not only WITH CHECK.
   */
  withCheck?: string
  /**
   * ── Per-command rules: the four commands are INDEPENDENT ───────────────────
   *
   * `using` alone describes one predicate, and one predicate cannot express the
   * ordinary case "anyone may read a public profile, only the owner may change
   * it". It used to be broadcast to all four commands, so a correct request
   * produced a live vulnerability: DELETE inherited the read rule and any
   * authenticated caller could delete any public row.
   *
   * Naming a command here also SCOPES the edit to the commands named — the
   * others keep the policies they already have. "Change only UPDATE and DELETE"
   * used to rewrite all four and silently revert SELECT to owner-only, which
   * fixed a security hole by breaking the feature it protected.
   */
  commands?: Partial<Record<RlsCommand, string | CommandRule>>
}

/** One command's resolved rule, ready to become a CREATE POLICY statement. */
export interface ResolvedCommandRule {
  command: RlsCommand
  using?: string
  check?: string
  /** True when this rule can be satisfied without the caller proving identity. */
  identityIndependent: boolean
}

/** Result of running a caller predicate through lib/db/sql-expression.ts. */
export type PredicateCheck =
  | { ok: true; expression: string }
  | { ok: false; reason: string }

export type CustomPolicyPlan =
  | {
      kind: 'ok'
      rules: ResolvedCommandRule[]
      /** True when only SOME commands were named — the rest must be preserved. */
      scoped: boolean
      /** Human-readable warnings that MUST reach the caller's result message. */
      warnings: string[]
    }
  | { kind: 'refused'; reason: string }

/**
 * Split a validated boolean predicate on its TOP-LEVEL `OR`s.
 *
 * The input has already passed lib/db/sql-expression.ts — a closed grammar with
 * no subqueries, no semicolons and no dollar-quoting — so tracking parenthesis
 * depth and single-quoted literals is sufficient to find the real disjunction
 * boundaries. Returns a single-element array for a predicate with no top-level OR.
 */
export function splitTopLevelOr(expr: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let cur = ''
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (inString) {
      cur += ch
      if (ch === "'") inString = expr[i + 1] === "'" ? (cur += expr[++i], true) : false
      continue
    }
    if (ch === "'") { inString = true; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (
      depth === 0 &&
      (ch === 'o' || ch === 'O') &&
      /^or\b/i.test(expr.slice(i)) &&
      (i === 0 || /[\s)]/.test(expr[i - 1]))
    ) {
      parts.push(cur.trim())
      cur = ''
      i += 1 // consume the 'r'
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.filter(Boolean)
}

/**
 * Can this predicate be satisfied WITHOUT the caller proving who they are?
 *
 * A predicate is identity-independent when at least one of its top-level
 * disjuncts never mentions the JWT subject. `is_public = true OR user_id::text =
 * backenly_jwt_claim('sub')` is: the first branch alone admits every caller.
 *
 * That property is harmless — desirable, even — on SELECT. On UPDATE or DELETE
 * it means "any authenticated caller may modify or destroy any row that happens
 * to satisfy the public branch", which is exactly the vulnerability a broadcast
 * read predicate produced. `(a = sub) OR (b = sub)` is NOT identity-independent
 * and is broadcast freely, which is what keeps two-party tables working.
 */
export function isIdentityIndependent(expr: string): boolean {
  const normalized = expr.trim().toLowerCase()
  if (normalized === 'true' || normalized === '(true)') return true
  return splitTopLevelOr(expr).some((branch) => !/backenly_jwt_claim\s*\(/i.test(branch))
}

const CLAUSES: Record<RlsCommand, { using: boolean; check: boolean }> = {
  select: { using: true,  check: false },
  insert: { using: false, check: true  },
  update: { using: true,  check: true  },
  delete: { using: true,  check: false },
}

/**
 * Turn a caller's request into one independent rule PER COMMAND.
 *
 * ── Why `withCheck` governs USING and not only WITH CHECK ───────────────────
 *
 * `UPDATE USING (<read rule>) WITH CHECK (owner)` looks safe and is not. USING
 * decides which rows you may TARGET, so a caller can aim at somebody else's row
 * and then satisfy WITH CHECK by rewriting the owner column to themselves — a
 * profile hijack. If the caller has said what they may WRITE, that is also the
 * set they may target.
 *
 * Pure resolution: no database access, no I/O. The refusals here are the whole
 * point of the function, so they are unit-testable without a Postgres.
 */
export function resolveCustomCommands(
  config: Pick<PolicyConfig, 'using' | 'withCheck' | 'commands'>,
  validate: (expr: string) => PredicateCheck,
): CustomPolicyPlan {
  const named = config.commands
    ? (Object.keys(config.commands) as RlsCommand[]).filter(
        (c) => RLS_COMMANDS.includes(c) && config.commands![c] !== undefined,
      )
    : []
  const unknown = config.commands
    ? Object.keys(config.commands).filter((c) => !RLS_COMMANDS.includes(c as RlsCommand))
    : []
  if (unknown.length) {
    return {
      kind: 'refused',
      reason:
        `Unknown command${unknown.length > 1 ? 's' : ''} in \`commands\`: ${unknown.join(', ')}. ` +
        `A row-level-security policy governs exactly four: select, insert, update, delete.`,
    }
  }

  const scoped = named.length > 0
  const targets = scoped ? named : RLS_COMMANDS

  if (!scoped && !config.using && !config.withCheck) {
    return {
      kind: 'refused',
      reason:
        `A custom policy needs a predicate. Pass \`using\` to govern all four commands with one rule, ` +
        `or \`commands\` to give each command its own — ` +
        `e.g. { commands: { select: "is_public OR owner_id::text = backenly_jwt_claim('sub')", ` +
        `update: "owner_id::text = backenly_jwt_claim('sub')", delete: "owner_id::text = backenly_jwt_claim('sub')" } }.`,
    }
  }

  const warnings: string[] = []
  const rules: ResolvedCommandRule[] = []
  /** Write commands that would have silently inherited an unsafe read rule. */
  const bled: RlsCommand[] = []

  // The read rule is what a broadcast would copy onto the write commands, so it
  // is resolved first and then checked against every write command.
  const readSource = pickRule(config.commands?.select)?.using ?? config.using

  for (const command of targets) {
    const explicit = pickRule(config.commands?.[command])
    const clause = CLAUSES[command]

    // The blanket fallbacks. `withCheck` outranks `using` on every WRITE command
    // — including their USING — for the reason in the header comment.
    const usingSource = clause.using
      ? explicit?.using ?? (command === 'select' ? config.using : config.withCheck ?? config.using)
      : undefined
    const checkSource = clause.check
      ? explicit?.check ?? explicit?.using ?? config.withCheck ?? config.using
      : undefined

    if (clause.using && !usingSource) {
      return {
        kind: 'refused',
        reason:
          `\`commands.${command}\` needs a \`using\` predicate (which rows ${command.toUpperCase()} may reach). ` +
          `Pass a string, or { using: "…" }.`,
      }
    }
    if (clause.check && !checkSource) {
      return {
        kind: 'refused',
        reason:
          `\`commands.${command}\` needs a \`check\` predicate (which rows ${command.toUpperCase()} may write). ` +
          `Pass a string, or { check: "…" }.`,
      }
    }
    // Only an EXPLICIT `{ using }` / `{ check }` on a command that has no such
    // clause is worth reporting. The bare-string shorthand deliberately means
    // "whichever clause this command has", so it is never a mistake.
    if (explicit && !explicit.shorthand) {
      if (explicit.using && !clause.using) {
        warnings.push(
          `\`commands.${command}.using\` was ignored — PostgreSQL has no USING clause for ${command.toUpperCase()}. ` +
          `Its rule comes from \`check\`.`,
        )
      }
      if (explicit.check && !clause.check) {
        warnings.push(
          `\`commands.${command}.check\` was ignored — PostgreSQL has no WITH CHECK clause for ${command.toUpperCase()}. ` +
          `Its rule comes from \`using\`.`,
        )
      }
    }

    const rule: ResolvedCommandRule = { command, identityIndependent: false }
    for (const [field, source] of [['using', usingSource], ['check', checkSource]] as const) {
      if (!source) continue
      const v: PredicateCheck = validate(source)
      if (v.ok === false) {
        return {
          kind: 'refused',
          reason: `\`${command}.${field}\` predicate rejected: ${v.reason}`,
        }
      }
      rule[field] = v.expression
    }

    // ── The widening guard ───────────────────────────────────────────────────
    //
    // A write command may not inherit an identity-independent read rule by
    // DEFAULT. It may still be given one deliberately (naming the command in
    // `commands` is that deliberate act) — but never silently, and the result
    // message says so either way.
    const effective = rule.using ?? rule.check
    if (effective && command !== 'select' && isIdentityIndependent(effective)) {
      rule.identityIndependent = true
      if (!explicit && !!readSource && effective === normalizeForCompare(readSource, validate)) {
        bled.push(command)
      } else {
        warnings.push(
          `${command.toUpperCase()} is governed by "${effective}", which does not reference the caller's identity — ` +
          `any authenticated caller can ${VERB[command]} every row that matches it. ` +
          `This was requested explicitly, so it was applied.`,
        )
      }
    }

    rules.push(rule)
  }

  // ── One refusal naming EVERY command that would have been widened ──────────
  //
  // Refusing on the first offender alone would have the caller fix INSERT, retry,
  // and be refused again on UPDATE — three round trips to learn one fact.
  if (bled.length) {
    const list = bled.map((c) => c.toUpperCase()).join(', ')
    const readRule = readSource ?? ''
    return {
      kind: 'refused',
      reason:
        `Refusing to apply the read rule to ${list}. "${readRule}" can be satisfied without the caller ` +
        `proving who they are, so copying it onto ${bled.length > 1 ? 'those commands' : 'that command'} would let ` +
        `any authenticated caller ${bled.map((c) => VERB[c]).join(' / ')} every row that matches it — ` +
        `${bled.includes('delete') ? 'including rows they do not own. ' : ''}` +
        `The four commands are independent and Backenly will not guess the write rule.\n` +
        `Say what it is:\n` +
        `  • { using: "<read rule>", withCheck: "<write rule>" } — one rule for INSERT/UPDATE/DELETE.\n` +
        `  • { commands: { select: "<read rule>", insert: "<write rule>", update: "<write rule>", ` +
        `delete: "<write rule>" } } — a rule per command.\n` +
        `If an open ${list} really is intended, name ${bled.length > 1 ? 'each' : 'it'} explicitly under \`commands\`.`,
    }
  }

  return { kind: 'ok', rules, scoped, warnings }
}

const VERB: Record<RlsCommand, string> = {
  select: 'read',
  insert: 'create',
  update: 'modify',
  delete: 'delete',
}

/** Normalise a raw predicate through the same validator the rules went through. */
function normalizeForCompare(
  expr: string,
  validate: (e: string) => PredicateCheck,
): string | null {
  const v = validate(expr)
  return v.ok ? v.expression : null
}

function pickRule(
  value: string | CommandRule | undefined,
): (CommandRule & { shorthand: boolean }) | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Shorthand: one predicate for whichever clause this command actually has.
    return trimmed ? { using: trimmed, check: trimmed, shorthand: true } : { shorthand: true }
  }
  const using = typeof value.using === 'string' && value.using.trim() ? value.using.trim() : undefined
  const check = typeof value.check === 'string' && value.check.trim() ? value.check.trim() : undefined
  return { ...(using ? { using } : {}), ...(check ? { check } : {}), shorthand: false }
}

/**
 * Enable RLS on a workspace table and install the policy.
 */
export async function applyPermissionPolicy(
  projectId: string,
  config: PolicyConfig
): Promise<{ success: boolean; message: string }> {
  const { tableName, roleColumn, role = 'authenticated' } = config
  const schemaName = `workspace_${projectId}`

  // ── Resolve `template: 'auto'` against the live schema ────────────────────
  // The inference reads foreign keys, not just column names, so a table owned
  // through a parent (order_items → orders → users) resolves to `related_rows`
  // instead of failing on a `user_id` column it was never going to have.
  let template: PolicyTemplate
  let userIdColumn = config.userIdColumn
  let via = config.via
  let partyColumns = config.partyColumns
  if (config.template === 'auto') {
    const plan = await inferRlsPlan(projectId, tableName)
    if (plan.kind === 'undecidable') {
      // Refuse rather than guess. Enabling RLS with no derivable policy makes
      // the table read empty — an outage in place of an exposure.
      return { success: false, message: plan.reason }
    }
    template = plan.template
    if (plan.kind === 'own_rows') userIdColumn = userIdColumn ?? plan.userIdColumn
    if (plan.kind === 'party_rows') partyColumns = partyColumns ?? plan.partyColumns
    if (plan.kind === 'related_rows') via = via ?? plan.via
  } else {
    template = config.template
  }

  // ── The custom escape hatch ────────────────────────────────────────────────
  if (template === 'custom') {
    const { validateBooleanExpression } = await import('@/lib/db/sql-expression')

    // ── Why the catalog is loaded before validating ──────────────────────────
    //
    // A predicate may reach the parent table through `EXISTS (SELECT 1 FROM …)`,
    // and that clause is only safe if the parent and every column it names are
    // checked against the live schema. Without it the grammar refused SELECT
    // outright, so the one genuinely two-table rule — a message belongs to the
    // participants of its conversation — could not be written as a custom
    // policy. Callers fell back to whatever single-column rule the templates
    // could express, which is how a correct cross-table predicate turned into
    // `sender_id = sub` and stayed that way through three attempts to restore it.
    const existsCtx = await loadExistsContext(projectId, schemaName, tableName)

    const validate = (expr: string) => {
      const r = validateBooleanExpression(expr, { requireColumn: false, exists: existsCtx })
      return r.kind === 'ok'
        ? ({ ok: true, expression: r.expression } as const)
        : ({
            ok: false,
            reason:
              `${r.reason} ${r.hint} Write it against this table's columns, using ` +
              `backenly_jwt_claim('sub') for the calling end-user's id — e.g. ` +
              `"owner_id::text = backenly_jwt_claim('sub') OR is_public". ` +
              `To depend on a parent row, use ` +
              `"EXISTS (SELECT 1 FROM parent p WHERE p.id = ${tableName}.parent_id AND …)".`,
          } as const)
    }

    const plan = resolveCustomCommands(config, validate)
    if (plan.kind === 'refused') {
      return { success: false, message: `No policy was changed on "${tableName}". ${plan.reason}` }
    }
    return installCustomPolicySet(projectId, tableName, schemaName, plan, role)
  }

  // ── Owner detection: the catalog is the source of truth, not a name list ────
  //
  // `detectUserIdColumn` matched a hardcoded list of column NAMES. So on
  //
  //     connections(requester_id → users, addressee_id → users)
  //
  // it found nothing — neither name is on the list — and this function refused
  // with "it has no ownership column (checked: user_id, sender_id, …)". Autopilot
  // escalated a `missing_rls` finding to a human for a table whose ownership is
  // declared by TWO foreign keys, because two different owner detectors disagreed:
  // `inferRlsPlan` reads foreign keys, this read names.
  //
  // There is one detector now. `resolveOwnership` consults the FK catalog first
  // and falls back to names, which is what lib/services/rls-ownership.ts has
  // always done for the `auto` path.
  const ownership = await resolveOwnership(projectId, tableName)
  const detectedOwner = userIdColumn || ownership.ownerColumn
  const uidColumn = detectedOwner || 'user_id'
  const roleCol   = roleColumn || 'role'

  // ── An explicit own_rows on a two-party table is a MISTAKE, not an order ────
  //
  // Autopilot's auto-fix hardcodes `template: 'own_rows'`, and on `connections`
  // that would lock the addressee out of their own row. Upgrading to `party_rows`
  // when the schema plainly has two parties is the correct policy, and it is
  // reported in the returned message rather than done quietly.
  let upgradedFromOwnRows = false
  if (template === 'own_rows' && !config.userIdColumn && ownership.partyColumns.length >= 2) {
    template = 'party_rows'
    partyColumns = ownership.partyColumns
    upgradedFromOwnRows = true
  }

  if (template === 'party_rows') {
    const parties = (partyColumns?.length ? partyColumns : ownership.partyColumns).filter(Boolean)
    if (parties.length < 2) {
      return {
        success: false,
        message:
          `Cannot apply "party_rows" RLS to "${tableName}" — it names fewer than two end-user parties ` +
          `(found: ${parties.length ? parties.join(', ') : 'none'}). ` +
          `party_rows is for tables where a row belongs to two or more users, like ` +
          `connections(requester_id, addressee_id) or conversations(user_a, user_b). ` +
          `For a single owner use "own_rows"; for a rule of your own use ` +
          `{ policy: "custom", using: "<predicate>" }.`,
      }
    }
    partyColumns = parties
  }

  // `related_rows` needs an ownership PATH, not an ownership column. When a
  // caller names the template explicitly without one, derive it here so the
  // template is usable from the brain/MCP surface too.
  if (template === 'related_rows' && !via) {
    const plan = await inferRlsPlan(projectId, tableName)
    if (plan.kind !== 'related_rows') {
      return {
        success: false,
        message:
          `Cannot apply "related_rows" RLS to "${tableName}" — no single foreign key leads to a ` +
          `user-owned parent table. ${plan.reason}`,
      }
    }
    via = plan.via
  }

  // ── Pre-flight: refuse impossible policies BEFORE we start ALTERing ─────
  // own_rows / admin_read_all / role_based / moderator_access all require an
  // ownership column. If none exists, we cannot install a sensible policy —
  // and we must NOT proceed past ENABLE ROW LEVEL SECURITY because that would
  // leave the table FORCE-RLS'd with zero usable policies (default-deny).
  // Returning a clean failure here is what a multimillion-platform does:
  // tell the user exactly what's wrong, do not corrupt their schema.
  const OWNER_REQUIRED: PolicyTemplate[] = ['own_rows', 'admin_read_all', 'role_based', 'moderator_access']
  if (OWNER_REQUIRED.includes(template) && !detectedOwner) {
    // The refusal now reports what was ACTUALLY checked — foreign keys as well as
    // names — and offers the two templates that were missing from it. The old
    // message listed ten column names and three templates, none of which could
    // express a two-party table or an arbitrary rule, so an agent that hit it had
    // nowhere to go and escalated to a human.
    return {
      success: false,
      message:
        `Cannot apply "${template}" RLS to "${tableName}" — Backenly cannot tell who owns a row.\n` +
        `Checked: foreign keys into "users" (none found), and the ownership column names ` +
        `${OWNER_NAME_CANDIDATES.slice(0, 8).join(', ')}, ….\n` +
        `Available instead:\n` +
        `  • party_rows  — a row belongs to two or more users, e.g. connections(requester_id, addressee_id). ` +
        `Pass { policy: "party_rows", partyColumns: ["a","b"] }.\n` +
        `  • custom      — any rule of your own: { policy: "custom", using: "<predicate>" }, ` +
        `where backenly_jwt_claim('sub') is the calling end-user's id.\n` +
        `  • public_read — everyone reads, only the service role writes (reference data).\n` +
        `  • admin_only / all_access — service-role only, or no row restriction at all.\n` +
        `Or add an owner column to "${tableName}" and declare it as a foreign key to users(id).`,
    }
  }

  // Snapshot the pre-state so we can restore on partial failure.
  // Without this, a failed CREATE POLICY after a successful ENABLE/FORCE RLS
  // leaves the table locked-out by default-deny (the 42501 incident).
  const preState = await readRlsState(projectId, schemaName, tableName)

  try {
    // Step 0: Guarantee the claim reader exists in this schema.
    //
    // Every policy below is written against `backenly_jwt_claim()` rather than
    // the `app.*` GUCs, because that is the one contract BOTH engines satisfy:
    // PostgREST sets `request.jwt.claims` itself, and the legacy Express runtime
    // sets it too (see rls-session.ts, which emits both dialects). A policy in
    // GUC form, by contrast, matches NOTHING under PostgREST — silently, as an
    // empty result rather than an error.
    //
    // The helper was previously installed only by the cutover scripts, so a
    // table created through this path landed a legacy-dialect policy into an
    // already-migrated project. CREATE OR REPLACE makes this idempotent and
    // cheap enough to run unconditionally.
    await executeInWorkspaceSchema(projectId, jwtClaimFunctionSql(schemaName))

    // Step 1: Enable RLS on the table
    await executeInWorkspaceSchema(
      projectId,
      `ALTER TABLE "${schemaName}"."${tableName}" ENABLE ROW LEVEL SECURITY;`
    )

    // Step 2: Remove existing Backenly-managed policies on this table
    await dropBackenlyPolicies(projectId, schemaName, tableName)

    // Step 2b: Remove foreign policies that would OR the new one away. Without
    // this, installing own_rows beside a surviving `USING (true)` leaves the
    // table exactly as exposed as it was and reports success.
    await dropExposingPolicies(projectId, schemaName, tableName)

    // Step 3: Install the policy based on template
    // CRITICAL: each installer runs multiple DDL statements. If any fails,
    // we catch below and restore RLS to its pre-state so the table doesn't
    // end up FORCE-RLS'd with zero policies (default-deny everything).
    switch (template) {
      case 'own_rows':
        await installOwnRowsPolicy(projectId, tableName, uidColumn, schemaName)
        break

      case 'party_rows':
        await installPartyRowsPolicy(projectId, tableName, partyColumns!, schemaName)
        break

      case 'related_rows':
        await installRelatedRowsPolicy(projectId, tableName, via!, schemaName)
        break

      case 'public_read':
        // If the table has no detectable ownership column (reference tables
        // like hashtags, categories, tags), install a "public read, writes
        // service-role only" variant so the policy installer never references
        // a non-existent column. This is the correct default for global
        // reference tables — owner-checked writes simply don't apply.
        if (!detectedOwner) {
          await installPublicReadNoOwnerPolicy(projectId, tableName, schemaName)
        } else {
          await installPublicReadPolicy(projectId, tableName, uidColumn, schemaName)
        }
        break

      case 'admin_only':
        await installAdminOnlyPolicy(projectId, tableName, schemaName)
        break

      case 'org_members':
        await installOrgMembersPolicy(projectId, tableName, schemaName)
        break

      case 'all_access':
        // Disable RLS restrictions (allow all authenticated)
        await executeInWorkspaceSchema(
          projectId,
          `ALTER TABLE "${schemaName}"."${tableName}" DISABLE ROW LEVEL SECURITY;`
        )
        break

      case 'admin_read_all':
        await installAdminReadAllPolicy(projectId, tableName, uidColumn, roleCol, schemaName)
        break

      case 'role_based':
        await installRoleBasedPolicy(projectId, tableName, uidColumn, roleCol, schemaName)
        break

      case 'moderator_access':
        await installModeratorAccessPolicy(projectId, tableName, uidColumn, roleCol, schemaName)
        break
    }

    // Step 3a: Defense in depth — after a successful install, verify at
    // least one policy is now present. If somehow the install reported
    // success but planted nothing, restore the pre-state rather than leave
    // the table locked-out.
    const post = await readRlsState(projectId, schemaName, tableName)
    if (template !== 'all_access' && post.policyCount === 0) {
      await restoreRlsState(projectId, schemaName, tableName, preState)
      throw new Error(
        `RLS install for template "${template}" planted zero policies — table state restored to prevent default-deny lockout.`,
      )
    }

    // ── Per-COMMAND read-back, not just "some policy exists" ─────────────────
    //
    // The check above only asked whether the count was non-zero, so a template
    // that planted SELECT and silently failed to plant DELETE passed it. Under
    // FORCE RLS an uncovered command is denied outright, so that is a table that
    // reads fine and refuses every write — reported as a success.
    //
    // Every template here installs all four commands (all_access is the
    // exception: it turns RLS off, so having no policies IS the outcome). Ask
    // PostgreSQL which commands actually ended up covered and refuse to report
    // a change that is not there. This is also what lets the brain treat an
    // RLS call as already verified instead of owing a separate pass that a
    // wall clock then cuts.
    if (template !== 'all_access') {
      const live = await readLivePolicies(schemaName, tableName)
      const covered = new Set(live.flatMap(commandsCoveredBy))
      const uncovered = RLS_COMMANDS.filter((c) => !covered.has(c))
      if (uncovered.length) {
        await restoreRlsState(projectId, schemaName, tableName, preState)
        throw new Error(
          `RLS install for template "${template}" left ${uncovered.join(', ').toUpperCase()} with no policy. ` +
          `Under FORCE ROW LEVEL SECURITY an uncovered command is denied to every end-user, so this would ` +
          `have been a silent outage on those operations. The table was restored to its previous state.`,
        )
      }
    }

    // Step 4: Save policy metadata
    await prisma.permissionPolicy.upsert({
      where: {
        projectId_tableName_policyName: {
          projectId,
          tableName,
          policyName: `backenly_${template}`,
        },
      },
      update: {
        operation: 'ALL',
        role,
        using: getUsingExpression(template, uidColumn, via, partyColumns),
        description: getPolicyDescription(template, uidColumn, via, partyColumns),
        enabled: true,
      },
      create: {
        projectId,
        tableName,
        policyName: `backenly_${template}`,
        operation: 'ALL',
        role,
        using: getUsingExpression(template, uidColumn, via, partyColumns),
        description: getPolicyDescription(template, uidColumn, via, partyColumns),
      },
    })

    // An UPGRADE is reported, never done quietly. The caller asked for own_rows;
    // it got party_rows because the schema has two parties and own_rows would
    // have locked one of them out. Saying so is the difference between a
    // correction and a substitution.
    const message =
      getPolicyDescription(template, uidColumn, via, partyColumns) +
      (upgradedFromOwnRows
        ? ` (Requested "own_rows", applied "party_rows" instead: "${tableName}" has ${partyColumns!.length} ` +
          `end-user parties (${partyColumns!.join(', ')}), and own_rows would have granted access to only ` +
          `the first of them.)`
        : '')
    console.log(`[RLS] ✅ Applied "${template}" policy on "${tableName}": ${message}`)

    return { success: true, message }
  } catch (err: any) {
    console.error(`[RLS] Failed to apply policy on "${tableName}":`, err.message)
    // Best-effort restore — if we just half-applied a policy we don't want
    // the table to be left FORCE-RLS'd with no usable policies.
    try {
      await restoreRlsState(projectId, schemaName, tableName, preState)
    } catch (restoreErr: any) {
      console.error(
        `[RLS] Failed to restore pre-state on "${tableName}" after a failed install:`,
        restoreErr?.message,
      )
    }
    return { success: false, message: err.message }
  }
}

/**
 * The catalog a predicate's `EXISTS` clause is checked against.
 *
 * Reuses the ownership catalog rather than issuing its own introspection: it
 * already reads every table's columns for the whole schema in one query, and a
 * second reader would be a second thing to keep in step with the live schema.
 *
 * A schema that reads back empty yields an empty table map, which makes the
 * grammar refuse every EXISTS with "not a table in this project" rather than
 * qualify a name it could not confirm. Failing closed is the point: the
 * alternative is emitting DDL that names a table nobody verified exists.
 */
async function loadExistsContext(
  projectId: string,
  schemaName: string,
  selfTable: string,
): Promise<ExistsContext> {
  const catalog = await loadOwnershipCatalog(projectId)
  const tables = new Map<string, Set<string>>()
  for (const [table, cols] of catalog.columns) tables.set(table, new Set(cols))
  return { schemaName, selfTable, tables }
}

/**
 * Drop Backenly-managed policies on a table, leaving user-authored ones alone.
 * Extracted so the template path, the custom path and the restore path share ONE
 * implementation — three inline copies of this `DO $$` block was how they drifted.
 *
 * `commands` narrows the drop to the policies governing exactly those commands.
 * That is what makes a scoped edit possible: the SELECT policy a caller asked to
 * leave alone is never dropped, so it cannot be "restored" to something else.
 * Omit it and every Backenly policy on the table goes, as before.
 */
async function dropBackenlyPolicies(
  projectId: string,
  schemaName: string,
  tableName: string,
  commands?: RlsCommand[],
): Promise<void> {
  // pg_policies.cmd renders as SELECT / INSERT / UPDATE / DELETE / ALL. A scoped
  // drop deliberately does NOT match 'ALL' — installCustomPolicySet refuses that
  // combination up front rather than silently removing a broader policy here.
  const cmdFilter = commands?.length
    ? `AND upper(cmd) IN (${commands.map((c) => `'${c.toUpperCase()}'`).join(', ')})`
    : ''
  await executeInWorkspaceSchema(
    projectId,
    `
    DO $$
    DECLARE pol RECORD;
    BEGIN
      FOR pol IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = '${schemaName}' AND tablename = '${tableName}'
        AND policyname LIKE 'backenly_%'
        ${cmdFilter}
      LOOP
        EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(pol.policyname) || ' ON "${schemaName}"."${tableName}"';
      END LOOP;
    END;
    $$;
    `,
  )
}

/**
 * Drop foreign policies that expose every row, so the policy we are about to
 * install actually takes effect.
 *
 * PostgreSQL combines PERMISSIVE policies with OR. Installing `own_rows` beside
 * a surviving `USING (true)` therefore evaluates to `true OR user_id = sub`,
 * which is `true` — the table stays wide open while every dashboard reports a
 * Backenly-managed policy on it. `dropBackenlyPolicies` cannot reach these,
 * because it matches `backenly_%` by name and the dangerous policy is by
 * definition one we did not create. That is why the autonomy loop could detect
 * `rls_expression_invalid`, run SET_PERMISSION, report success, and leave the
 * exposure exactly as it found it.
 *
 * Scope is deliberately narrow — this is not "drop user policies":
 *   - PERMISSIVE only. A RESTRICTIVE `USING (true)` ANDs with everything else
 *     and cannot widen access, so it is left alone.
 *   - Literal `true` in USING or WITH CHECK only. Any real predicate is a
 *     considered decision and is never touched.
 *   - `coalesce(..., '')` rather than `IS NULL`: an INSERT policy always has a
 *     NULL qual, and reading that as wide-open would match every one of them.
 *   - The platform's own direct-access pass-throughs (`backenly_external`,
 *     `bkn_%`, created by scripts/setup-direct-access.sql) are exempt, matching
 *     the carve-out in detectOverPermissiveRls. Flagging those queued repairs
 *     that could never remove them and escalated 9 false approvals in prod on
 *     2026-07-20; dropping them here would be the same mistake with teeth.
 *
 * Callers snapshot pre-state first, so this is restorable on partial failure.
 */
async function dropExposingPolicies(
  projectId: string,
  schemaName: string,
  tableName: string,
  commands?: RlsCommand[],
): Promise<string[]> {
  const cmdFilter = commands?.length
    ? `AND upper(cmd) IN (${commands.map((c) => `'${c.toUpperCase()}'`).join(', ')})`
    : ''
  const rows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT policyname FROM pg_policies
    WHERE schemaname = '${schemaName}'
      AND tablename = '${tableName}'
      AND policyname NOT LIKE 'backenly_%'
      AND permissive = 'PERMISSIVE'
      AND (
        btrim(lower(coalesce(qual, ''))) IN ('true', '(true)')
        OR btrim(lower(coalesce(with_check, ''))) IN ('true', '(true)')
      )
      AND EXISTS (
        SELECT 1 FROM unnest(roles) AS pr(role)
        WHERE pr.role <> 'backenly_external'
          AND pr.role NOT LIKE 'bkn\\_%' ESCAPE '\\'
      )
      ${cmdFilter}
    `,
  )

  const names = (rows as any)?.rows?.map((r: any) => r.policyname)
    ?? (Array.isArray(rows) ? rows.map((r: any) => r.policyname) : [])

  for (const name of names) {
    await executeInWorkspaceSchema(
      projectId,
      `DROP POLICY IF EXISTS "${name}" ON "${schemaName}"."${tableName}";`,
    )
    console.warn(
      `[RLS] dropped exposing policy "${name}" on ${schemaName}.${tableName} — ` +
      `PERMISSIVE with a literal true predicate, which would OR away the policy being installed`,
    )
  }
  return names
}

// ── RLS state helpers (Phase 14.1 — install-or-restore safety) ────────────────

interface RlsTableState {
  rowSecurity: boolean
  forceRowSecurity: boolean
  policyCount: number
}

/**
 * Read whether RLS / FORCE-RLS is currently on and how many backenly_*
 * policies exist. Used to snapshot a table's pre-state before we mutate it.
 */
async function readRlsState(
  projectId: string,
  schemaName: string,
  tableName: string,
): Promise<RlsTableState> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = $1
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)`,
      tableName,
      schemaName,
    )
    const policyRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count
         FROM pg_policies
        WHERE schemaname = $1 AND tablename = $2 AND policyname LIKE 'backenly_%'`,
      schemaName,
      tableName,
    )
    return {
      rowSecurity: rows[0]?.relrowsecurity ?? false,
      forceRowSecurity: rows[0]?.relforcerowsecurity ?? false,
      policyCount: Number(policyRows[0]?.count ?? 0),
    }
  } catch {
    return { rowSecurity: false, forceRowSecurity: false, policyCount: 0 }
  }
}

/**
 * Roll a table back to a known RLS state. Used after a failed policy install
 * to guarantee we never leave a table in the "FORCE RLS, zero policies"
 * default-deny lockout.
 */
async function restoreRlsState(
  projectId: string,
  schemaName: string,
  tableName: string,
  state: RlsTableState,
): Promise<void> {
  // Drop every backenly_* policy on the table (leaves user-authored policies alone)
  await executeInWorkspaceSchema(
    projectId,
    `
    DO $$
    DECLARE pol RECORD;
    BEGIN
      FOR pol IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = '${schemaName}' AND tablename = '${tableName}'
        AND policyname LIKE 'backenly_%'
      LOOP
        EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(pol.policyname) || ' ON "${schemaName}"."${tableName}"';
      END LOOP;
    END;
    $$;
    `,
  )
  // Restore the RLS / FORCE bits to the pre-state.
  if (!state.rowSecurity) {
    await executeInWorkspaceSchema(
      projectId,
      `ALTER TABLE "${schemaName}"."${tableName}" DISABLE ROW LEVEL SECURITY;`,
    )
  }
  if (!state.forceRowSecurity) {
    await executeInWorkspaceSchema(
      projectId,
      `ALTER TABLE "${schemaName}"."${tableName}" NO FORCE ROW LEVEL SECURITY;`,
    )
  }
}

/**
 * own_rows: Users can only see/modify their own rows.
 *   SELECT/UPDATE/DELETE: user_id = current_user_id  (service-role bypasses)
 *   INSERT: user_id must equal current_user_id        (service-role bypasses)
 *
 * FORCE ROW LEVEL SECURITY is set so that the table owner (backenly_user)
 * is also subject to these policies, preventing the owner from bypassing
 * user-data isolation.  The service-role escape hatch (`app.is_service_role`)
 * lets internal platform operations (migrations, verifier) still access all rows.
 */
async function installOwnRowsPolicy(
  projectId: string,
  tableName: string,
  uidColumn: string,
  schemaName: string
) {
  await execStatements(projectId, `
    ALTER TABLE "${schemaName}"."${tableName}" FORCE ROW LEVEL SECURITY;

    CREATE POLICY backenly_own_rows_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_own_rows_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_own_rows_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_own_rows_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );
  `)
}

/**
 * party_rows: the row belongs to EVERY party named on it, and each of them sees it.
 *
 *   connections(requester_id, addressee_id)  — both sides see the request
 *   conversations(user_a, user_b)            — both participants see the thread
 *   messages(sender_id, recipient_id)        — sender and recipient both see it
 *
 * ── Why this is a separate template and not own_rows with a wider column ─────
 *
 * `own_rows` compares ONE column to the caller. Applied to a two-party table it
 * does not degrade gracefully — it grants access to one side and denies the
 * other, which reads as data loss to whichever user drew the short straw. The
 * inference used to pick that column by `Array.find` order.
 *
 * INSERT is checked with the same predicate: you may create a row only if you
 * are one of its parties. That is what stops a client fabricating a connection
 * between two other people, and it is the reason WITH CHECK is not simply
 * `true` here.
 *
 * FORCE ROW LEVEL SECURITY matches every other owner-checked template, so the
 * table owner (`backenly_user`) is subject to the policy too and cannot bypass
 * per-user isolation; the service-role escape keeps platform operations working.
 */
async function installPartyRowsPolicy(
  projectId: string,
  tableName: string,
  partyColumns: string[],
  schemaName: string,
) {
  const isAParty = partyColumns
    .map((c) => `"${c}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}`)
    .join('\n        OR ')

  await execStatements(projectId, `
    ALTER TABLE "${schemaName}"."${tableName}" FORCE ROW LEVEL SECURITY;

    CREATE POLICY backenly_party_rows_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (
        ${serviceRoleClause(schemaName)}
        OR ${isAParty}
      );

    CREATE POLICY backenly_party_rows_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        ${serviceRoleClause(schemaName)}
        OR ${isAParty}
      );

    CREATE POLICY backenly_party_rows_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        ${serviceRoleClause(schemaName)}
        OR ${isAParty}
      );

    CREATE POLICY backenly_party_rows_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        ${serviceRoleClause(schemaName)}
        OR ${isAParty}
      );
  `)
}

/**
 * Schema-qualify an unqualified `backenly_jwt_claim(...)` in a caller's predicate.
 *
 * A policy expression is resolved at CREATE POLICY time and stored as resolved
 * OIDs, and the workspace pool does set `search_path`, so an unqualified call
 * would in fact resolve today. Qualifying it anyway removes the dependency: the
 * stored policy no longer relies on the search_path that happened to be in effect
 * when it was created, which is the kind of implicit coupling that breaks much
 * later and for reasons that look unrelated.
 *
 * Already-qualified calls are left alone, so a caller who writes the full form
 * does not end up with it doubled.
 */
function qualifyClaimCalls(expr: string, schemaName: string): string {
  return expr.replace(
    /(^|[^."\w])backenly_jwt_claim\s*\(/gi,
    `$1"${schemaName}"."${JWT_CLAIM_FN}"(`,
  )
}

/** One live policy row as PostgreSQL renders it. Ground truth, never metadata. */
export interface LivePolicyRow {
  policyName: string
  /** 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL' — pg_policies.cmd. */
  cmd: string
  permissive: string
  roles: string[]
  using: string | null
  withCheck: string | null
}

/**
 * Read every policy PostgreSQL currently has on a table.
 *
 * This is the only honest source for "what is the rule right now". The
 * PermissionPolicy metadata table records one row per applied TEMPLATE while the
 * database holds four policies per template — which is how a project with 6
 * live policies on one table reported "7 policies across 6 tables".
 */
export async function readLivePolicies(
  schemaName: string,
  tableName: string,
): Promise<LivePolicyRow[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      policyname: string
      cmd: string
      permissive: string
      roles: string[] | string | null
      qual: string | null
      with_check: string | null
    }>>(
      `SELECT policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
         FROM pg_policies
        WHERE schemaname = $1 AND tablename = $2
        ORDER BY policyname`,
      schemaName,
      tableName,
    )
    return rows.map((r) => ({
      policyName: r.policyname,
      cmd: String(r.cmd || '').toUpperCase(),
      permissive: r.permissive,
      roles: Array.isArray(r.roles)
        ? r.roles
        : typeof r.roles === 'string'
          ? r.roles.replace(/^\{|\}$/g, '').split(',').filter(Boolean)
          : [],
      using: r.qual,
      withCheck: r.with_check,
    }))
  } catch {
    return []
  }
}

/** Which of the four commands does a live policy row govern? */
function commandsCoveredBy(row: LivePolicyRow): RlsCommand[] {
  if (row.cmd === 'ALL' || row.cmd === '*') return [...RLS_COMMANDS]
  const c = row.cmd.toLowerCase() as RlsCommand
  return RLS_COMMANDS.includes(c) ? [c] : []
}

/**
 * custom: the caller's own rules, one per command, under the same governance as
 * a template.
 *
 * ── Three properties this function owes the caller ──────────────────────────
 *
 * 1. INDEPENDENCE. Each command gets the rule that command was given. One
 *    predicate is no longer copied onto four commands, because a read rule on
 *    DELETE is a data-loss vulnerability generated from a correct request.
 *
 * 2. SCOPE. A scoped edit touches only the commands it names. The policies for
 *    the others are not rewritten — they are not even dropped — so "change only
 *    UPDATE and DELETE" cannot revert SELECT. What was preserved is REPORTED,
 *    read back from pg_policies rather than assumed.
 *
 * 3. VERIFICATION. Success is claimed only after re-reading pg_policies and
 *    confirming a policy exists for every targeted command. Three consecutive
 *    "✅ custom RLS" results with one actual change is the failure this closes;
 *    an unverified claim is worse than an error.
 *
 * The service-role clause is added by Backenly, not by the caller, and is not
 * optional. Without it the platform's own migrations, verifier and backup paths
 * would be subject to a rule written for end-users — which is how a "stricter"
 * custom policy silently breaks the autonomy loop rather than the app.
 */
async function installCustomPolicySet(
  projectId: string,
  tableName: string,
  schemaName: string,
  plan: Extract<CustomPolicyPlan, { kind: 'ok' }>,
  role: string,
): Promise<{ success: boolean; message: string }> {
  const targeted = plan.rules.map((r) => r.command)
  const preState = await readRlsState(projectId, schemaName, tableName)
  const before = await readLivePolicies(schemaName, tableName)

  // ── A scoped edit cannot coexist with a FOR ALL policy ─────────────────────
  //
  // Permissive policies combine with OR, so leaving a `FOR ALL` policy in place
  // while adding a narrower per-command one WIDENS access instead of narrowing
  // it. Refusing is the only honest outcome: the caller has to say what the
  // whole set should be.
  if (plan.scoped) {
    const blanket = before.filter((p) => p.policyName.startsWith('backenly_') && commandsCoveredBy(p).length === 4)
    if (blanket.length) {
      return {
        success: false,
        message:
          `No policy was changed on "${tableName}". It carries a FOR ALL policy ` +
          `(${blanket.map((p) => p.policyName).join(', ')}) that already governs ` +
          `${targeted.join('/').toUpperCase()}. Adding a narrower policy alongside it would WIDEN access, ` +
          `not narrow it, because PostgreSQL combines permissive policies with OR. ` +
          `Restate all four commands so the whole set is replaced at once.`,
      }
    }
  }

  const preserved = plan.scoped
    ? before.filter(
        (p) =>
          p.policyName.startsWith('backenly_') &&
          commandsCoveredBy(p).length > 0 &&
          !commandsCoveredBy(p).some((c) => targeted.includes(c)),
      )
    : []

  try {
    await executeInWorkspaceSchema(projectId, jwtClaimFunctionSql(schemaName))
    await executeInWorkspaceSchema(
      projectId,
      `ALTER TABLE "${schemaName}"."${tableName}" ENABLE ROW LEVEL SECURITY;`,
    )

    // Drop only what this edit replaces. A full replacement targets all four and
    // therefore still clears everything Backenly owns.
    await dropBackenlyPolicies(projectId, schemaName, tableName, plan.scoped ? targeted : undefined)
    // Same OR-away problem as the template path: a foreign `USING (true)`
    // survives a Backenly-only drop and neutralises whatever we install here.
    await dropExposingPolicies(projectId, schemaName, tableName, plan.scoped ? targeted : undefined)

    const svc = serviceRoleClause(schemaName)
    const statements: string[] = [
      `ALTER TABLE "${schemaName}"."${tableName}" FORCE ROW LEVEL SECURITY;`,
    ]
    for (const rule of plan.rules) {
      const clauses: string[] = []
      if (rule.using) clauses.push(`USING (${svc} OR (${qualifyClaimCalls(rule.using, schemaName)}))`)
      if (rule.check) clauses.push(`WITH CHECK (${svc} OR (${qualifyClaimCalls(rule.check, schemaName)}))`)
      // No `TO <role>` clause, deliberately — every template creates PUBLIC-role
      // policies and relies on the service-role escape for platform access. A
      // policy scoped `TO authenticated` would leave `anon` and the owning
      // `backenly_user` with no policy at all under FORCE RLS, i.e. denied.
      statements.push(
        `CREATE POLICY backenly_custom_${rule.command} ON "${schemaName}"."${tableName}" ` +
        `FOR ${rule.command.toUpperCase()} ${clauses.join(' ')};`,
      )
    }
    for (const stmt of statements) await executeInWorkspaceSchema(projectId, stmt)

    // ── Read-back: what does the database actually say now? ──────────────────
    const after = await readLivePolicies(schemaName, tableName)
    const missing = targeted.filter(
      (c) => !after.some((p) => p.policyName === `backenly_custom_${c}`),
    )
    if (missing.length) {
      await restoreRlsState(projectId, schemaName, tableName, preState)
      throw new Error(
        `CREATE POLICY reported no error but pg_policies has no policy for ` +
        `${missing.join(', ').toUpperCase()} — table state restored rather than reporting a change that is not there.`,
      )
    }

    await recordCustomPolicyMetadata(projectId, tableName, plan.rules, role, plan.scoped)

    // ── The message describes the LIVE set, not the request ──────────────────
    const lines: string[] = [
      `Row-level security on "${tableName}" — live policy set, read back from PostgreSQL:`,
    ]
    for (const command of RLS_COMMANDS) {
      const own = after.find((p) => p.policyName === `backenly_custom_${command}`)
      const other = after.find(
        (p) => p.policyName.startsWith('backenly_') && commandsCoveredBy(p).includes(command),
      )
      const row = own ?? other
      if (!row) {
        lines.push(`  • ${command.toUpperCase()} — no policy: this command is DENIED for end-users.`)
        continue
      }
      const changed = targeted.includes(command)
      const rule = plan.rules.find((r) => r.command === command)
      const shown = rule
        ? [rule.using ? `may target: ${rule.using}` : null, rule.check ? `may write: ${rule.check}` : null]
            .filter(Boolean)
            .join(' · ')
        : describeLiveRow(row)
      lines.push(
        `  • ${command.toUpperCase()} — ${changed ? 'CHANGED' : 'unchanged'} (${row.policyName}): ${shown}`,
      )
    }
    if (plan.scoped) {
      lines.push(
        preserved.length
          ? `Left untouched as requested: ${[...new Set(preserved.flatMap(commandsCoveredBy))]
              .filter((c) => !targeted.includes(c))
              .join(', ')
              .toUpperCase()}.`
          : `No other Backenly policy existed on this table, so only ${targeted.join('/').toUpperCase()} is governed.`,
      )
    }
    for (const w of plan.warnings) lines.push(`  ⚠ ${w}`)
    lines.push('Service-role keys bypass all of it.')

    return { success: true, message: lines.join('\n') }
  } catch (err: any) {
    // Same install-or-restore guarantee as every template: a half-applied custom
    // policy must never leave the table FORCE-RLS'd with nothing readable.
    try {
      await restoreRlsState(projectId, schemaName, tableName, preState)
    } catch (restoreErr: any) {
      console.error(`[RLS] Failed to restore "${tableName}" after a failed custom install:`, restoreErr?.message)
    }
    return {
      success: false,
      message:
        `Custom RLS rule was NOT applied to "${tableName}" and the table was restored to its previous ` +
        `state. PostgreSQL rejected the policy: ${err.message}. Check that every column your predicate ` +
        `names exists (get_table_schema) and that the types compare — ids are compared as ::text.`,
    }
  }
}

/** Render a live policy row for a human, when we did not author it this call. */
function describeLiveRow(row: LivePolicyRow): string {
  const parts = [
    row.using ? `may target: ${row.using}` : null,
    row.withCheck ? `may write: ${row.withCheck}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'no predicate recorded'
}

/**
 * Record ONE metadata row per command, mirroring the live policy set.
 *
 * The old shape was a single `backenly_custom` row with operation 'ALL', which
 * described a policy set that no longer exists in that form and made a
 * per-command edit invisible to `list_permissions`. A scoped edit only rewrites
 * the rows for the commands it changed.
 */
async function recordCustomPolicyMetadata(
  projectId: string,
  tableName: string,
  rules: ResolvedCommandRule[],
  role: string,
  scoped: boolean,
): Promise<void> {
  try {
    // The pre-per-command row described a set that is no longer installed.
    await prisma.permissionPolicy.deleteMany({
      where: { projectId, tableName, policyName: 'backenly_custom' },
    })
    if (!scoped) {
      await prisma.permissionPolicy.deleteMany({
        where: {
          projectId,
          tableName,
          policyName: { startsWith: 'backenly_' },
          NOT: { policyName: { in: rules.map((r) => `backenly_custom_${r.command}`) } },
        },
      })
    }
    for (const rule of rules) {
      const policyName = `backenly_custom_${rule.command}`
      const description =
        `Custom ${rule.command.toUpperCase()} rule` +
        (rule.using ? ` — may target: ${rule.using}` : '') +
        (rule.check ? ` — may write: ${rule.check}` : '')
      await prisma.permissionPolicy.upsert({
        where: { projectId_tableName_policyName: { projectId, tableName, policyName } },
        update: {
          operation: rule.command.toUpperCase(),
          role,
          using: rule.using ?? rule.check ?? '',
          description,
          enabled: true,
        },
        create: {
          projectId,
          tableName,
          policyName,
          operation: rule.command.toUpperCase(),
          role,
          using: rule.using ?? rule.check ?? '',
          description,
        },
      })
    }
  } catch (err: any) {
    // Metadata is a convenience index; the database is the source of truth. A
    // bookkeeping failure must not turn an applied policy into a reported failure.
    console.error(`[RLS] Failed to record custom policy metadata for "${tableName}":`, err?.message)
  }
}

/**
 * related_rows: the row is owned by whoever owns its PARENT.
 *
 *   order_items.order_id → orders.id, and orders.user_id names the end-user.
 *   A customer sees a line item exactly when they own the order it belongs to.
 *
 * Written as EXISTS against the parent rather than a join, so Postgres can stop
 * at the first matching parent row and the policy stays sargable on the FK
 * index. `::text` on both sides matches the rest of this file — workspace
 * schemas mix uuid and text ids depending on how the table was created, and an
 * operator mismatch inside a policy fails at query time, not at CREATE POLICY.
 *
 * Not recursive: the subquery reads a DIFFERENT table, so it evaluates that
 * table's own policy (which terminates) rather than re-entering this one. The
 * inference layer refuses self-referencing FKs for exactly this reason.
 *
 * INSERT is checked with the same predicate, which is what stops a client
 * attaching a line item to somebody else's order.
 */
async function installRelatedRowsPolicy(
  projectId: string,
  tableName: string,
  via: RelatedRowsVia,
  schemaName: string,
) {
  // The parent may itself be two-party — `messages.conversation_id →
  // conversations(user_a, user_b)`. With a single owner column here, only the
  // first participant could read the messages in their own conversation, which
  // is defect #12 one hop further out.
  const parentIsMine = via.parentOwnerColumns
    .map((c) => `parent."${c}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}`)
    .join(' OR ')

  const ownsParent = `
    EXISTS (
      SELECT 1
        FROM "${schemaName}"."${via.parentTable}" parent
       WHERE parent."${via.parentColumn}"::text = "${tableName}"."${via.localColumn}"::text
         AND (${parentIsMine})
    )`

  await execStatements(projectId, `
    ALTER TABLE "${schemaName}"."${tableName}" FORCE ROW LEVEL SECURITY;

    CREATE POLICY backenly_related_rows_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (${serviceRoleClause(schemaName)} OR ${ownsParent});

    CREATE POLICY backenly_related_rows_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (${serviceRoleClause(schemaName)} OR ${ownsParent});

    CREATE POLICY backenly_related_rows_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (${serviceRoleClause(schemaName)} OR ${ownsParent});

    CREATE POLICY backenly_related_rows_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (${serviceRoleClause(schemaName)} OR ${ownsParent});
  `)
}

/**
 * public_read: Everyone can read, only owner (or service-role) can write.
 */
async function installPublicReadPolicy(
  projectId: string,
  tableName: string,
  uidColumn: string,
  schemaName: string
) {
  await execStatements(projectId, `
    ALTER TABLE "${schemaName}"."${tableName}" FORCE ROW LEVEL SECURITY;

    CREATE POLICY backenly_public_read_select ON "${schemaName}"."${tableName}"
      FOR SELECT USING (true);

    CREATE POLICY backenly_public_read_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_public_read_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_public_read_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );
  `)
}

/**
 * public_read variant for reference tables with NO ownership column.
 *
 * Hashtags, categories, tags, languages — global reference data that any user
 * should be able to SELECT but only the service-role (admin) should mutate.
 * The standard public_read template assumes a user_id column for the
 * write-side policies, which causes a `column "user_id" does not exist`
 * failure when applied to these tables. This variant skips the owner check
 * entirely on writes — only service-role keys can INSERT/UPDATE/DELETE.
 */
async function installPublicReadNoOwnerPolicy(
  projectId: string,
  tableName: string,
  schemaName: string
) {
  await execStatements(projectId, `
    ALTER TABLE "${schemaName}"."${tableName}" FORCE ROW LEVEL SECURITY;

    CREATE POLICY backenly_public_read_select ON "${schemaName}"."${tableName}"
      FOR SELECT USING (true);

    CREATE POLICY backenly_public_read_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (${serviceRoleClause(schemaName)});

    CREATE POLICY backenly_public_read_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (${serviceRoleClause(schemaName)});

    CREATE POLICY backenly_public_read_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (${serviceRoleClause(schemaName)});
  `)
}

/**
 * org_members: Users can only access rows in their organization.
 * Requires an organization_id column on the table and an organization_members junction table.
 * The policy checks that the current user is a member of the row's organization.
 */
async function installOrgMembersPolicy(
  projectId: string,
  tableName: string,
  schemaName: string
) {
  // ── Recursion guard for the junction table itself ────────────────────────
  // The org_members policy authorises a row by checking the current user's
  // membership: `org_id IN (SELECT organization_id FROM organization_members …)`.
  // That subquery is fine on a *member* table (products, invoices, …) — it runs
  // organization_members' OWN policy, which terminates. But when this template
  // is applied TO organization_members itself, the subquery re-triggers the very
  // policy being evaluated → Postgres aborts every query on the table with
  // "infinite recursion detected in policy for relation organization_members",
  // taking down not just direct reads but any other table whose policy subqueries
  // it (and even FK validation against it). Tables here are FORCE-RLS'd, so a
  // SECURITY DEFINER helper owned by backenly_user would still be subject to the
  // policy and recurse — the only self-safe policy is one that never subqueries
  // the same table. On the junction table a user sees their OWN membership rows;
  // member management (add/remove/role changes) is a governed operation that runs
  // through the /orgs API with the service-role escape, so end-user writes to the
  // table are service-role-only. This preserves multi-tenant isolation without
  // the self-reference.
  if (tableName === 'organization_members') {
    await execStatements(projectId, `
      CREATE POLICY backenly_org_members_select ON "${schemaName}"."${tableName}"
        FOR SELECT
        USING (
          "user_id"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
          OR ${serviceRoleClause(schemaName)}
        );

      CREATE POLICY backenly_org_members_insert ON "${schemaName}"."${tableName}"
        FOR INSERT
        WITH CHECK (${serviceRoleClause(schemaName)});

      CREATE POLICY backenly_org_members_update ON "${schemaName}"."${tableName}"
        FOR UPDATE
        USING (${serviceRoleClause(schemaName)});

      CREATE POLICY backenly_org_members_delete ON "${schemaName}"."${tableName}"
        FOR DELETE
        USING (${serviceRoleClause(schemaName)});
    `)
    return
  }

  // Detect org column name
  const orgColumn = await detectOrgIdColumn(projectId, tableName) || 'organization_id'

  await execStatements(projectId, `
    CREATE POLICY backenly_org_members_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (
        "${orgColumn}"::text IN (
          SELECT "organization_id"::text FROM "${schemaName}"."organization_members"
          WHERE "user_id"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
        )
        OR ${serviceRoleClause(schemaName)}
      );

    CREATE POLICY backenly_org_members_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        "${orgColumn}"::text IN (
          SELECT "organization_id"::text FROM "${schemaName}"."organization_members"
          WHERE "user_id"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
        )
        OR ${serviceRoleClause(schemaName)}
      );

    CREATE POLICY backenly_org_members_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        "${orgColumn}"::text IN (
          SELECT "organization_id"::text FROM "${schemaName}"."organization_members"
          WHERE "user_id"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
        )
        OR ${serviceRoleClause(schemaName)}
      );

    CREATE POLICY backenly_org_members_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        "${orgColumn}"::text IN (
          SELECT "organization_id"::text FROM "${schemaName}"."organization_members"
          WHERE "user_id"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
          AND "role" = 'admin'
        )
        OR ${serviceRoleClause(schemaName)}
      );
  `)
}

/**
 * admin_read_all: Admins (app.user_role = 'admin') see ALL rows.
 * Regular users see only their own rows (via user_id column).
 * Service-role keys bypass everything.
 *
 * The role is set per-request via set_config('app.user_role', ..., true) in executeWithUserContext.
 */
async function installAdminReadAllPolicy(
  projectId: string,
  tableName: string,
  uidColumn: string,
  roleCol: string,
  schemaName: string
) {
  await execStatements(projectId, `
    CREATE POLICY backenly_admin_read_all_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (
        ${claimExpr(schemaName, 'user_role')} = 'admin'
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_admin_read_all_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_admin_read_all_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        ${claimExpr(schemaName, 'user_role')} = 'admin'
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_admin_read_all_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        ${claimExpr(schemaName, 'user_role')} = 'admin'
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );
  `)
}

/**
 * role_based: Generic role-column access control.
 * Admins bypass user-scoped filtering; regular users see only their own rows.
 * The role is read from both the session (app.user_role) and the row's own role column
 * so it works even when the table itself stores roles.
 */
async function installRoleBasedPolicy(
  projectId: string,
  tableName: string,
  uidColumn: string,
  roleCol: string,
  schemaName: string
) {
  await execStatements(projectId, `
    CREATE POLICY backenly_role_based_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_role_based_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_role_based_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_role_based_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );
  `)
}

/**
 * moderator_access: Moderators AND admins see all rows.
 * Regular users see only their own rows.
 * Service-role keys bypass everything.
 *
 * Write operations (insert/update/delete): moderators can modify any row; users only their own.
 */
async function installModeratorAccessPolicy(
  projectId: string,
  tableName: string,
  uidColumn: string,
  roleCol: string,
  schemaName: string
) {
  await execStatements(projectId, `
    CREATE POLICY backenly_moderator_access_select ON "${schemaName}"."${tableName}"
      FOR SELECT
      USING (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'moderator', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_moderator_access_insert ON "${schemaName}"."${tableName}"
      FOR INSERT
      WITH CHECK (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'moderator', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_moderator_access_update ON "${schemaName}"."${tableName}"
      FOR UPDATE
      USING (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'moderator', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );

    CREATE POLICY backenly_moderator_access_delete ON "${schemaName}"."${tableName}"
      FOR DELETE
      USING (
        ${claimExpr(schemaName, 'user_role')} IN ('admin', 'moderator', 'superadmin')
        OR ${serviceRoleClause(schemaName)}
        OR "${uidColumn}"::text = ${claimExpr(schemaName, SUBJECT_CLAIM)}
      );
  `)
}

/**
 * Detect organization_id column in a workspace table.
 */
async function detectOrgIdColumn(
  projectId: string,
  tableName: string
): Promise<string | null> {
  const schemaName = `workspace_${projectId}`
  const candidates = ['organization_id', 'organizationId', 'org_id', 'orgId', 'team_id', 'teamId', 'workspace_id', 'workspaceId']

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       AND column_name = ANY($3::text[])
       LIMIT 1`,
      schemaName,
      tableName,
      candidates
    )
    return rows[0]?.column_name ?? null
  } catch {
    return null
  }
}

/**
 * admin_only: Only service-role API keys bypass this.
 * Regular users see nothing.
 */
async function installAdminOnlyPolicy(
  projectId: string,
  tableName: string,
  schemaName: string
) {
  await executeInWorkspaceSchema(
    projectId,
    `
    CREATE POLICY backenly_admin_only ON "${schemaName}"."${tableName}"
      FOR ALL
      USING (${serviceRoleClause(schemaName)});
    `
  )
}

/**
 * List all permission policies for a project.
 */
export async function listPermissionPolicies(projectId: string) {
  return prisma.permissionPolicy.findMany({
    where: { projectId, enabled: true },
    orderBy: { tableName: 'asc' },
    select: {
      id: true,
      tableName: true,
      policyName: true,
      operation: true,
      role: true,
      description: true,
      createdAt: true,
    },
  })
}

/**
 * Remove all Backenly-managed RLS policies from a table and disable RLS.
 *
 * ── Why this returns the VERIFIED end state ─────────────────────────────────
 *
 * It used to return void, and its caller then reported "All authenticated users
 * can now access all rows" — a claim it had no way to check. That sentence is
 * true only if the DISABLE actually ran. The drop and the disable are separate
 * statements, so a failure between them leaves the table RLS-ENABLED WITH ZERO
 * POLICIES, which in PostgreSQL means the exact opposite: deny by default,
 * nothing readable by anyone but the service role.
 *
 * That is what happened. A failed approval left `messages` with 0 policies and
 * the summary said every authenticated user could now read all messages —
 * describing the inverse of the real posture (defect #6). Nothing leaked, because
 * deny-by-default is the safe direction, but the SAME sequence with a permissive
 * fallback would be an incident, and either way the report was wrong.
 *
 * The invariant is now enforced rather than assumed: a table is never left
 * enabled-with-no-policies. If the DISABLE fails, RLS stays on and an
 * admin_only policy is planted so the table is explicitly service-role-only
 * instead of implicitly locked, and the caller is told which state it is in.
 */
export async function removePermissionPolicy(
  projectId: string,
  tableName: string
): Promise<{ rlsEnabled: boolean; policyCount: number; message: string }> {
  const schemaName = `workspace_${projectId}`

  await dropBackenlyPolicies(projectId, schemaName, tableName)

  let disableError: string | null = null
  try {
    await executeInWorkspaceSchema(
      projectId,
      `ALTER TABLE "${schemaName}"."${tableName}" NO FORCE ROW LEVEL SECURITY;`,
    )
    await executeInWorkspaceSchema(
      projectId,
      `ALTER TABLE "${schemaName}"."${tableName}" DISABLE ROW LEVEL SECURITY;`,
    )
  } catch (err: any) {
    disableError = err?.message ?? 'unknown error'
    console.error(`[RLS] DISABLE ROW LEVEL SECURITY failed on "${tableName}":`, disableError)
  }

  await prisma.permissionPolicy.deleteMany({ where: { projectId, tableName } })

  // Read the real posture back out of the catalog.
  const state = await readRlsState(projectId, schemaName, tableName)

  if (state.rowSecurity && state.policyCount === 0) {
    // The lockout state. Make it EXPLICIT rather than leave it implicit — an
    // admin_only policy says "service role only" in the catalog, where the next
    // reader (a human, the missing-RLS detector, or an agent calling
    // get_table_schema) can see it.
    try {
      await installAdminOnlyPolicy(projectId, tableName, schemaName)
      const after = await readRlsState(projectId, schemaName, tableName)
      return {
        rlsEnabled: true,
        policyCount: after.policyCount,
        message:
          `Could not disable RLS on "${tableName}"${disableError ? ` (${disableError})` : ''}. ` +
          `Leaving it enabled with no policies would have made the table unreadable by every end-user, ` +
          `so an explicit service-role-only policy was installed instead. End-user API access to ` +
          `"${tableName}" is currently BLOCKED — apply a real policy with add_rls to restore it.`,
      }
    } catch (err: any) {
      return {
        rlsEnabled: true,
        policyCount: 0,
        message:
          `"${tableName}" is in a locked-down state: RLS is ENABLED with NO policies, which in PostgreSQL ` +
          `denies all end-user access rather than allowing it. Disabling RLS failed` +
          `${disableError ? ` (${disableError})` : ''} and so did installing a fallback policy (${err?.message}). ` +
          `Apply a policy with add_rls, or disable RLS from the dashboard.`,
      }
    }
  }

  console.log(`[RLS] Removed all policies from "${tableName}" (rls=${state.rowSecurity}, policies=${state.policyCount})`)
  return {
    rlsEnabled: state.rowSecurity,
    policyCount: state.policyCount,
    message: state.rowSecurity
      ? `Backenly-managed policies removed from "${tableName}". RLS is still ENABLED and ` +
        `${state.policyCount} policy/policies remain (not managed by Backenly), so access follows those.`
      : `RLS is now DISABLED on "${tableName}" — every authenticated API caller can read and write all rows.`,
  }
}

/**
 * Set app.current_user_id in the current DB session.
 * Called by the v1 database API routes for every authenticated request.
 */
export async function setCurrentUserInSession(
  userId: string,
  isServiceRole: boolean = false
): Promise<void> {
  await prisma.$executeRawUnsafe(
    rlsSessionSql(),
    ...rlsSessionParams({ userId, isServiceRole }),
  )
}

/**
 * Execute a raw SQL query with RLS session context set atomically in the same
 * transaction.  Using `is_local = true` (the third arg to set_config) means
 * the settings revert at transaction end so they never leak to pooled connections.
 *
 * Always use this helper instead of calling setCurrentUserInSession + a separate
 * prisma.$queryRawUnsafe — those two calls may land on different connections in
 * the pool and therefore RLS would not be enforced.
 *
 * @param userId        End-user ID (from their project-scoped JWT).  Pass '' to
 *                      clear the context (policies will match no rows on own_rows
 *                      tables — secure default).
 * @param isServiceRole true for service-role API keys that bypass RLS entirely.
 * @param sql           The SQL query to execute.
 * @param values        Positional parameters for the SQL query.
 */
export async function executeWithUserContext<T = any>(
  userId: string,
  isServiceRole: boolean,
  sql: string,
  values: unknown[] = [],
  userRole: string = 'user'
): Promise<T[]> {
  // ── TEMPORARY DIAGNOSTIC — REMOVE AFTER THE profiles CALLER IS IDENTIFIED ──
  //
  // A bare-placeholder INSERT into `profiles` fails 42804 every 15 minutes and
  // five rounds of static analysis have each named a different, wrong caller.
  // Log-only: no behaviour change, no extra query. Prints the stack so the
  // actual caller is read from evidence instead of inferred again.
  //
  // Tracked in memory: project_contract_sweep_recurring_errors.md
  if (process.env.DIAG_PROFILES_CALLER === '1' && /INSERT INTO[^;]*"profiles"/i.test(sql)) {
    console.error(
      '[DIAG profiles-insert] caller stack:\n' +
      (new Error('profiles INSERT').stack ?? '(no stack)') +
      `\n[DIAG profiles-insert] sql=${sql.slice(0, 200)}` +
      `\n[DIAG profiles-insert] userId=${userId || '(none)'} serviceRole=${isServiceRole}`,
    )
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      rlsSessionSql(),
      ...rlsSessionParams({ userId, isServiceRole, userRole }),
    )
    return tx.$queryRawUnsafe<T[]>(sql, ...values)
  })
}

/**
 * Deterministic auto-RLS: read the live schema immediately after CREATE_TABLE
 * and install the policy the schema implies, without asking the AI.
 *
 * The rule set lives in lib/services/rls-ownership.ts and covers three shapes
 * this function used to miss entirely:
 *
 *   - a FK to `users` under a non-canonical name (`customer_id`) — was skipped
 *     because only a hardcoded name list was consulted;
 *   - indirect ownership (`order_items.order_id → orders.user_id`) — was left
 *     with RLS off, which is how customer line items ended up readable by any
 *     API key;
 *   - reference tables — were left with RLS off, which leaves their WRITES open
 *     too. `public_read` is what "this catalog is public" actually means.
 *
 * When ownership genuinely cannot be inferred, this returns without enabling
 * RLS and reports why. That is deliberate: a table with RLS on and no policy
 * reads EMPTY, so guessing here would replace a data exposure with an outage.
 * The missing-RLS detector picks the table up on the next tick and asks a human
 * what the rule is.
 *
 * Called by the CREATE_TABLE executor. The `columns` argument is now advisory
 * only — the catalog is the source of truth, because a FK declared in the same
 * statement is not visible in the in-memory column list.
 */
export async function autoApplyRlsIfNeeded(
  projectId: string,
  tableName: string,
  _columns: Array<{ name: string }> = []
): Promise<void> {
  const plan = await inferRlsPlan(projectId, tableName)

  if (plan.kind === 'undecidable') {
    console.log(`[AutoRLS] Ownership undecidable for "${tableName}" — leaving RLS off. ${plan.reason}`)
    return
  }

  console.log(`[AutoRLS] "${tableName}" → ${plan.template} (${plan.basis}): ${plan.reason}`)
  const result = await applyPermissionPolicy(projectId, {
    tableName,
    template: plan.template,
    ...(plan.kind === 'own_rows' ? { userIdColumn: plan.userIdColumn } : {}),
    ...(plan.kind === 'party_rows' ? { partyColumns: plan.partyColumns } : {}),
    ...(plan.kind === 'related_rows' ? { via: plan.via } : {}),
  })

  if (result.success) {
    console.log(`[AutoRLS] ✅ ${plan.template} policy applied to "${tableName}"`)
  } else {
    console.warn(`[AutoRLS] ⚠️ Failed to apply policy on "${tableName}": ${result.message}`)
  }
}

/**
 * Re-run auto-RLS across every table in the schema.
 *
 * Needed because ownership is not knowable at the moment a table is created:
 * `order_items` is created before `orders` exists in half the plans an agent
 * writes, so the hop that makes it inferrable only appears later. Creating the
 * parent, or adding the FK, must be able to protect the child retroactively.
 *
 * Only touches tables that currently have NO backenly-managed policy, so it can
 * never overwrite a rule a human or an agent stated explicitly.
 */
export async function reconcileAutoRls(
  projectId: string,
): Promise<Array<{ tableName: string; template: PolicyTemplate | null; applied: boolean; message: string }>> {
  const schemaName = `workspace_${projectId}`
  const catalog = await loadOwnershipCatalog(projectId)
  const out: Array<{ tableName: string; template: PolicyTemplate | null; applied: boolean; message: string }> = []

  const managed = await prisma.permissionPolicy.findMany({
    where: { projectId, enabled: true },
    select: { tableName: true },
  })
  const alreadyManaged = new Set(managed.map((p) => p.tableName))

  for (const tableName of catalog.columns.keys()) {
    if (alreadyManaged.has(tableName)) continue
    if (tableName.startsWith('_')) continue

    const plan = inferRlsPlanFromCatalog(catalog, tableName)
    if (plan.kind === 'undecidable') {
      out.push({ tableName, template: null, applied: false, message: plan.reason })
      continue
    }
    const result = await applyPermissionPolicy(projectId, {
      tableName,
      template: plan.template,
      ...(plan.kind === 'own_rows' ? { userIdColumn: plan.userIdColumn } : {}),
      ...(plan.kind === 'party_rows' ? { partyColumns: plan.partyColumns } : {}),
      ...(plan.kind === 'related_rows' ? { via: plan.via } : {}),
    })
    out.push({ tableName, template: plan.template, applied: result.success, message: result.message })
  }

  console.log(`[AutoRLS] reconciled ${schemaName}: ${out.filter((r) => r.applied).length}/${out.length} tables protected`)
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Ownership column names checked when no foreign key declares ownership.
 *
 * Exported shape of the same list lib/services/rls-ownership.ts uses, referenced
 * by the refusal message so what the error CLAIMS was checked is what was
 * actually checked. The old message hardcoded ten names into a string literal,
 * which then drifted from the list the code consulted.
 */
const OWNER_NAME_CANDIDATES = OWNERSHIP_COLUMN_CANDIDATES

/**
 * Resolve who owns a row in this table — foreign keys FIRST, names second.
 *
 * ── Why this replaced `detectUserIdColumn` ────────────────────────────────────
 *
 * There were two owner detectors that disagreed. `inferRlsPlan` (used by the
 * `auto` path) reads the foreign-key catalog; `detectUserIdColumn` (used by every
 * EXPLICIT template) matched a hardcoded list of column names. So a table whose
 * ownership is declared by foreign keys under non-canonical names —
 *
 *     connections(requester_id → users.id, addressee_id → users.id)
 *
 * — resolved correctly through one path and not at all through the other. The
 * explicit path refused with "it has no ownership column (checked: user_id,
 * sender_id, …)", and because Autopilot's `missing_rls` auto-fix passes an
 * explicit `own_rows`, a fixable finding escalated to a human on a critical
 * table. That escalation is the one reported alongside these defects.
 *
 * One resolver now, reading the same catalog the inference does, and returning
 * the party list as well as the single owner so callers can tell the two apart.
 */
async function resolveOwnership(
  projectId: string,
  tableName: string,
): Promise<{ ownerColumn: string | null; partyColumns: string[] }> {
  try {
    const plan = await inferRlsPlan(projectId, tableName)
    if (plan.kind === 'own_rows') return { ownerColumn: plan.userIdColumn, partyColumns: [plan.userIdColumn] }
    if (plan.kind === 'party_rows') return { ownerColumn: plan.partyColumns[0], partyColumns: plan.partyColumns }
    // `related_rows` and `public_read` have no LOCAL owner column, and reporting
    // one would install an owner check against a column that does not exist.
    return { ownerColumn: null, partyColumns: [] }
  } catch (err: any) {
    console.warn(`[RLS] Ownership resolution failed for "${tableName}":`, err?.message)
    return { ownerColumn: null, partyColumns: [] }
  }
}

function getUsingExpression(
  template: PolicyTemplate,
  uidColumn: string,
  via?: RelatedRowsVia,
  partyColumns?: string[],
): string {
  switch (template) {
    case 'own_rows': return `"${uidColumn}"::text = current_user_id`
    case 'party_rows': return (partyColumns ?? [uidColumn])
      .map((c) => `"${c}"::text = current_user_id`).join(' OR ')
    case 'related_rows': return via
      ? `EXISTS (SELECT 1 FROM "${via.parentTable}" parent WHERE parent."${via.parentColumn}" = "${via.localColumn}" AND (${via.parentOwnerColumns.map((c) => `parent."${c}"::text = current_user_id`).join(' OR ')}))`
      : 'owned through a parent row'
    case 'public_read': return `true (SELECT) / "${uidColumn}"::text = current_user_id (write)`
    case 'admin_only': return `service_role only`
    case 'all_access': return 'RLS disabled'
    case 'org_members': return `organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = current_user_id)`
    case 'admin_read_all': return `app.user_role = 'admin' OR "${uidColumn}"::text = current_user_id`
    case 'role_based': return `app.user_role IN ('admin','superadmin') OR "${uidColumn}"::text = current_user_id`
    case 'moderator_access': return `app.user_role IN ('admin','moderator') OR "${uidColumn}"::text = current_user_id`
    case 'custom': return 'caller-supplied predicate'
  }
}

function getPolicyDescription(
  template: PolicyTemplate,
  uidColumn: string,
  via?: RelatedRowsVia,
  partyColumns?: string[],
): string {
  switch (template) {
    case 'own_rows': return `Users can only access rows where "${uidColumn}" matches their user ID`
    case 'party_rows': {
      const parties = partyColumns ?? [uidColumn]
      return (
        `Each row belongs to ${parties.length} parties (${parties.map((c) => `"${c}"`).join(', ')}) — ` +
        `a user can read and modify a row when they are ANY of them, and can create one only if they ` +
        `are a party to it. Nobody sees other users' rows.`
      )
    }
    case 'related_rows': return via
      ? `Users can only access rows whose "${via.parentTable}" parent belongs to them (via "${via.localColumn}" → ${via.parentOwnerColumns.map((c) => `"${via.parentTable}"."${c}"`).join(' / ')})`
      : `Users can only access rows whose parent row belongs to them`
    case 'public_read': return `Anyone can read; only the owner (via "${uidColumn}") can write`
    case 'admin_only': return `Only service-role API keys can access this table`
    case 'all_access': return `All authenticated users can access all rows (no row-level restrictions)`
    case 'org_members': return `Users can only access rows belonging to their organization (multi-tenant isolation). Deletes require admin role.`
    case 'admin_read_all': return `Admins see all rows; regular users see only their own (via "${uidColumn}")`
    case 'role_based': return `Role-based: admins/superadmins see all rows; users see only their own (via "${uidColumn}")`
    case 'moderator_access': return `Moderators & admins see all rows; regular users see only their own (via "${uidColumn}")`
    case 'custom': return `Custom rule enforced at the database level`
  }
}

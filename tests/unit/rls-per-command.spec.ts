/**
 * Per-command row-level security: the four commands are INDEPENDENT.
 *
 * These tests exist because one predicate used to be broadcast to all four
 * commands, which turned a correct request ("public read, owner-only writes")
 * into a live data-loss vulnerability: DELETE inherited the read rule, so any
 * authenticated caller could delete any public row.
 *
 * `resolveCustomCommands` is pure — no database — so the refusals that prevent
 * that are testable without a Postgres.
 */

import {
  resolveCustomCommands,
  splitTopLevelOr,
  isIdentityIndependent,
  type CustomPolicyPlan,
} from '@/lib/services/workspace-rls'

/**
 * A stand-in for lib/db/sql-expression's validator: accepts anything that is not
 * obviously hostile, and normalises whitespace so the identity comparison in the
 * widening guard behaves the way the real one does.
 */
const validate = (expr: string) =>
  /;|--|\bselect\b/i.test(expr)
    ? ({ ok: false, reason: 'rejected by the test validator' } as const)
    : ({ ok: true, expression: expr.replace(/\s+/g, ' ').trim() } as const)

const OWNER = "user_id::text = backenly_jwt_claim('sub')"
const PUBLIC_OR_OWNER = `(is_public = true AND is_flagged = false) OR ${OWNER}`

function ok(plan: CustomPolicyPlan): Extract<CustomPolicyPlan, { kind: 'ok' }> {
  if (plan.kind !== 'ok') throw new Error(`expected ok, got refusal: ${plan.reason}`)
  return plan
}
function refused(plan: CustomPolicyPlan): string {
  if (plan.kind !== 'refused') throw new Error('expected a refusal, got ok')
  return plan.reason
}

function ruleFor(plan: CustomPolicyPlan, command: string) {
  return ok(plan).rules.find((r) => r.command === command)
}

describe('splitTopLevelOr', () => {
  it('does not split an OR nested inside parentheses', () => {
    expect(splitTopLevelOr('(a OR b) AND c')).toEqual(['(a OR b) AND c'])
  })

  it('splits the top-level disjunction', () => {
    expect(splitTopLevelOr('a = 1 OR b = 2')).toEqual(['a = 1', 'b = 2'])
  })

  it('ignores OR inside a string literal', () => {
    expect(splitTopLevelOr("status = 'a OR b'")).toEqual(["status = 'a OR b'"])
  })

  it('does not treat a column named "order_id" as an OR', () => {
    expect(splitTopLevelOr('order_id = 1')).toEqual(['order_id = 1'])
  })

  it('splits the reported public-read predicate into its two branches', () => {
    expect(splitTopLevelOr(PUBLIC_OR_OWNER)).toEqual([
      '(is_public = true AND is_flagged = false)',
      OWNER,
    ])
  })
})

describe('isIdentityIndependent', () => {
  it('is true when a branch never references the caller', () => {
    expect(isIdentityIndependent(PUBLIC_OR_OWNER)).toBe(true)
  })

  it('is false for a single owner check', () => {
    expect(isIdentityIndependent(OWNER)).toBe(false)
  })

  // A two-party table expressed as a custom rule must stay broadcastable —
  // every branch names the caller, so nobody gains access without proving who
  // they are. Treating this as dangerous would be a false positive that breaks
  // connections / conversations.
  it('is false when EVERY branch references the caller', () => {
    expect(
      isIdentityIndependent(
        "requester_id::text = backenly_jwt_claim('sub') OR addressee_id::text = backenly_jwt_claim('sub')",
      ),
    ).toBe(false)
  })

  it('is true for a bare true', () => {
    expect(isIdentityIndependent('true')).toBe(true)
    expect(isIdentityIndependent('(true)')).toBe(true)
  })
})

describe('resolveCustomCommands — P0-1: predicate must not bleed across commands', () => {
  // The exact reported request. Previously all four commands received the read
  // predicate; DELETE with no WITH CHECK meant any authenticated caller could
  // delete any public profile.
  it('refuses to broadcast an identity-independent read rule onto the writes', () => {
    const reason = refused(resolveCustomCommands({ using: PUBLIC_OR_OWNER }, validate))
    // One refusal naming EVERY affected command, so the caller learns the whole
    // fact in one round trip instead of three.
    expect(reason).toMatch(/INSERT, UPDATE, DELETE/)
    expect(reason).toMatch(/without the caller proving who they are/)
    expect(reason).toMatch(/including rows they do not own/)
    // The refusal has to be actionable, not just a "no".
    expect(reason).toMatch(/commands/)
    expect(reason).toMatch(/withCheck/)
  })

  it('broadcasts a plain owner rule to all four commands', () => {
    const plan = ok(resolveCustomCommands({ using: OWNER }, validate))
    expect(plan.scoped).toBe(false)
    expect(plan.rules.map((r) => r.command)).toEqual(['select', 'insert', 'update', 'delete'])
    expect(ruleFor(plan, 'select')).toMatchObject({ using: OWNER })
    expect(ruleFor(plan, 'delete')).toMatchObject({ using: OWNER })
    expect(ruleFor(plan, 'insert')).toMatchObject({ check: OWNER })
    expect(plan.warnings).toEqual([])
  })

  it('gives each command its own rule when asked', () => {
    const plan = ok(
      resolveCustomCommands(
        {
          commands: {
            select: PUBLIC_OR_OWNER,
            insert: OWNER,
            update: OWNER,
            delete: OWNER,
          },
        },
        validate,
      ),
    )
    expect(ruleFor(plan, 'select')).toMatchObject({ using: PUBLIC_OR_OWNER })
    expect(ruleFor(plan, 'update')).toMatchObject({ using: OWNER, check: OWNER })
    expect(ruleFor(plan, 'delete')).toMatchObject({ using: OWNER })
    expect(ruleFor(plan, 'delete')?.check).toBeUndefined()
  })

  // `using` + `withCheck` is the terse form of the same thing. The critical part
  // is that `withCheck` governs UPDATE/DELETE's USING too: USING alone decides
  // which rows you may TARGET, so a read rule there lets a caller aim at
  // somebody else's row and rewrite the owner column to themselves.
  it('lets withCheck govern the USING of every write command', () => {
    const plan = ok(resolveCustomCommands({ using: PUBLIC_OR_OWNER, withCheck: OWNER }, validate))
    expect(ruleFor(plan, 'select')).toMatchObject({ using: PUBLIC_OR_OWNER })
    expect(ruleFor(plan, 'update')).toMatchObject({ using: OWNER, check: OWNER })
    expect(ruleFor(plan, 'delete')).toMatchObject({ using: OWNER })
    expect(ruleFor(plan, 'insert')).toMatchObject({ check: OWNER })
    expect(plan.warnings).toEqual([])
  })

  it('never emits a WITH CHECK for DELETE or a USING for INSERT', () => {
    const plan = ok(resolveCustomCommands({ using: OWNER }, validate))
    expect(ruleFor(plan, 'delete')?.check).toBeUndefined()
    expect(ruleFor(plan, 'insert')?.using).toBeUndefined()
  })

  // "Never widen a write predicate beyond a read one without saying so" — an
  // explicitly requested open DELETE is applied, and reported as a warning.
  it('applies an explicitly requested open DELETE but warns loudly', () => {
    const plan = ok(
      resolveCustomCommands({ commands: { delete: PUBLIC_OR_OWNER } }, validate),
    )
    expect(ruleFor(plan, 'delete')).toMatchObject({ identityIndependent: true })
    expect(plan.warnings.join(' ')).toMatch(/DELETE is governed by/)
    expect(plan.warnings.join(' ')).toMatch(/any authenticated caller can delete/)
  })
})

describe('resolveCustomCommands — P0-2: a scoped edit touches only what it names', () => {
  it('marks an edit scoped and targets only the named commands', () => {
    const plan = ok(
      resolveCustomCommands({ commands: { update: OWNER, delete: OWNER } }, validate),
    )
    expect(plan.scoped).toBe(true)
    expect(plan.rules.map((r) => r.command)).toEqual(['update', 'delete'])
  })

  it('does not synthesise rules for unnamed commands', () => {
    const plan = ok(resolveCustomCommands({ commands: { update: OWNER } }, validate))
    expect(ruleFor(plan, 'select')).toBeUndefined()
    expect(ruleFor(plan, 'insert')).toBeUndefined()
    expect(ruleFor(plan, 'delete')).toBeUndefined()
  })

  it('accepts the explicit { using, check } form per command', () => {
    const plan = ok(
      resolveCustomCommands(
        { commands: { update: { using: OWNER, check: `${OWNER} AND is_flagged = false` } } },
        validate,
      ),
    )
    expect(ruleFor(plan, 'update')).toMatchObject({
      using: OWNER,
      check: `${OWNER} AND is_flagged = false`,
    })
  })

  it('reports an ignored clause instead of silently dropping it', () => {
    const plan = ok(
      resolveCustomCommands({ commands: { delete: { using: OWNER, check: OWNER } } }, validate),
    )
    expect(plan.warnings.join(' ')).toMatch(/commands\.delete\.check` was ignored/)
  })
})

describe('resolveCustomCommands — refusals', () => {
  it('refuses with no predicate at all', () => {
    expect(refused(resolveCustomCommands({}, validate))).toMatch(/needs a predicate/)
  })

  it('refuses an unknown command name', () => {
    const reason = refused(
      resolveCustomCommands({ commands: { upsert: OWNER } as never }, validate),
    )
    expect(reason).toMatch(/Unknown command/)
    expect(reason).toMatch(/select, insert, update, delete/)
  })

  it('propagates the validator refusal with the command that caused it', () => {
    const reason = refused(
      resolveCustomCommands({ commands: { select: 'a = (SELECT 1)' } }, validate),
    )
    expect(reason).toMatch(/select\.using/)
  })

  it('refuses an empty rule object for a command', () => {
    expect(refused(resolveCustomCommands({ commands: { update: {} } }, validate)))
      .toMatch(/needs a `using` predicate/)
  })
})

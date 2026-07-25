import { validateBooleanExpression, type ExistsContext } from '@/lib/db/sql-expression'

const ctx: ExistsContext = {
  schemaName: 'workspace_p1',
  selfTable: 'messages',
  tables: new Map([
    ['messages', new Set(['id', 'conversation_id', 'sender_id', 'body', 'read_at'])],
    ['conversations', new Set(['id', 'user_a', 'user_b'])],
  ]),
}

const REAL =
  "EXISTS (SELECT 1 FROM conversations parent WHERE parent.id = messages.conversation_id AND (parent.user_a::text = backenly_jwt_claim('sub') OR parent.user_b::text = backenly_jwt_claim('sub')))"

describe('governed EXISTS', () => {
  it("accepts the reporter's messages predicate and qualifies the parent", () => {
    const r = validateBooleanExpression(REAL, { requireColumn: false, exists: ctx })
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.expression).toContain('"workspace_p1"."conversations"')
  })

  it('accepts EXISTS AND a narrowing own-column conjunct — the rule that kept collapsing', () => {
    const r = validateBooleanExpression(`${REAL} AND sender_id::text = backenly_jwt_claim('sub')`, {
      requireColumn: false, exists: ctx,
    })
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.expression).toContain('sender_id')
    expect(r.expression).toContain('"workspace_p1"."conversations"')
  })

  it('still refuses EXISTS when the caller did not opt in', () => {
    expect(validateBooleanExpression(REAL, { requireColumn: false }).kind).toBe('rejected')
  })

  it('refuses a table outside the project', () => {
    const r = validateBooleanExpression(
      'EXISTS (SELECT 1 FROM users u WHERE u.id = messages.sender_id)',
      { requireColumn: false, exists: ctx },
    )
    expect(r.kind).toBe('rejected')
    if (r.kind === 'rejected') expect(r.reason).toContain('not a table in this project')
  })

  it('refuses a column that does not exist on the parent', () => {
    const r = validateBooleanExpression(
      'EXISTS (SELECT 1 FROM conversations p WHERE p.owner_id = messages.sender_id)',
      { requireColumn: false, exists: ctx },
    )
    expect(r.kind).toBe('rejected')
    if (r.kind === 'rejected') expect(r.reason).toContain('does not exist on "conversations"')
  })

  it.each([
    ['a scalar subquery', 'id = (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id)'],
    ['IN (SELECT …)', 'conversation_id IN (SELECT id FROM conversations)'],
    ['a projection that is not 1', 'EXISTS (SELECT id FROM conversations p WHERE p.id = messages.conversation_id)'],
    ['a JOIN', 'EXISTS (SELECT 1 FROM conversations p JOIN messages m ON m.id = p.id WHERE p.id = messages.conversation_id)'],
    ['LIMIT', 'EXISTS (SELECT 1 FROM conversations p WHERE p.id = messages.conversation_id LIMIT 1)'],
    ['a missing WHERE', 'EXISTS (SELECT 1 FROM conversations p)'],
    ['a nested EXISTS', 'EXISTS (SELECT 1 FROM conversations p WHERE EXISTS (SELECT 1 FROM conversations q WHERE q.id = p.id))'],
    ['a foreign-schema reach', 'EXISTS (SELECT 1 FROM pg_authid p WHERE p.rolname = messages.sender_id)'],
  ])('refuses %s', (_label, bad) => {
    expect(validateBooleanExpression(bad, { requireColumn: false, exists: ctx }).kind).toBe('rejected')
  })

  it('does not let an alias reach a third table', () => {
    const r = validateBooleanExpression(
      'EXISTS (SELECT 1 FROM conversations p WHERE other.secret = p.id)',
      { requireColumn: false, exists: ctx },
    )
    expect(r.kind).toBe('rejected')
  })
})

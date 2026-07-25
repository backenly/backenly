import { toAuthorForm } from '@/lib/mcp/schema-introspection'
import { validateBooleanExpression, type ExistsContext } from '@/lib/db/sql-expression'

const SCHEMA = 'workspace_p1'
const ctx: ExistsContext = {
  schemaName: SCHEMA,
  selfTable: 'messages',
  tables: new Map([
    ['messages', new Set(['id', 'conversation_id', 'sender_id', 'body'])],
    ['conversations', new Set(['id', 'user_a', 'user_b'])],
  ]),
}

/** How PostgreSQL renders a policy Backenly installed. */
const live = (author: string) =>
  `((${SCHEMA}.backenly_jwt_claim('role'::text) = 'service_role'::text) OR (${author}))`

describe('a live policy can be read and sent straight back (the read-then-patch loop)', () => {
  it('strips the service-role clause Backenly adds', () => {
    const out = toAuthorForm(live(`sender_id::text = "${SCHEMA}"."backenly_jwt_claim"('sub')`), SCHEMA)
    expect(out).not.toMatch(/service_role/)
  })

  it('unqualifies the claim reader so the grammar accepts it again', () => {
    const out = toAuthorForm(live(`sender_id::text = "${SCHEMA}"."backenly_jwt_claim"('sub')`), SCHEMA)
    expect(out).toContain("backenly_jwt_claim('sub')")
    expect(out).not.toContain(SCHEMA)
  })

  it('ROUND TRIPS: the editable form re-validates cleanly', () => {
    const out = toAuthorForm(live(`sender_id::text = "${SCHEMA}"."backenly_jwt_claim"('sub')`), SCHEMA)
    const re = validateBooleanExpression(out!, { requireColumn: false, exists: ctx })
    expect(re.kind).toBe('ok')
  })

  it('ROUND TRIPS a cross-table EXISTS policy', () => {
    const author =
      `EXISTS (SELECT 1 FROM "${SCHEMA}"."conversations" p WHERE (p.id = messages.conversation_id) ` +
      `AND ((p.user_a)::text = "${SCHEMA}"."backenly_jwt_claim"('sub')))`
    const out = toAuthorForm(live(author), SCHEMA)
    expect(out).toBeTruthy()
    const re = validateBooleanExpression(out!, { requireColumn: false, exists: ctx })
    expect(re.kind).toBe('ok')
  })

  it('returns null for a policy Backenly did not install, rather than guessing', () => {
    // bkn_direct_read USING (true) — a direct-connection policy. Reporting a
    // wrong "editable" form would invite an agent to overwrite it with
    // something that does not mean the same thing.
    expect(toAuthorForm('true', SCHEMA)).toBeNull()
    expect(toAuthorForm('(owner_id = 1)', SCHEMA)).toBeNull()
  })

  it('returns null for null input', () => {
    expect(toAuthorForm(null, SCHEMA)).toBeNull()
    expect(toAuthorForm(undefined, SCHEMA)).toBeNull()
  })
})

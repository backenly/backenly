/**
 * The Agents admin tab reports numbers that leave the building in external
 * claims ("N automated schema modifications executed by agents, none of which
 * corrupted data"). These tests pin the two classification decisions those
 * numbers rest on, because both have a failure mode that inflates the claim.
 */

import {
  classifyTool,
  classifyOutcome,
  SCHEMA_TOOL_NAMES,
} from '@/lib/admin/agent-ops'

describe('classifyTool', () => {
  it('counts structural DDL as schema', () => {
    for (const tool of SCHEMA_TOOL_NAMES) {
      expect(classifyTool(tool)).toBe('schema')
    }
  })

  it('keeps RLS and auth writes out of the schema count', () => {
    // "An agent rewrote a security policy" is a different claim from "an agent
    // added a column" — reported separately so neither hides inside the other.
    expect(classifyTool('set_rls')).toBe('policy')
    expect(classifyTool('add_rls')).toBe('policy')
    expect(classifyTool('enable_auth')).toBe('policy')
  })

  it('counts row writes as data, not schema', () => {
    expect(classifyTool('db_insert')).toBe('data')
    expect(classifyTool('db_update')).toBe('data')
    expect(classifyTool('db_delete')).toBe('data')
    expect(classifyTool('truncate_table')).toBe('data')
  })

  it('does NOT fold backend_chat into schema', () => {
    // The usage row records only "backend_chat" — never which tools the turn
    // actually ran. Counting it as a schema modification would make the
    // headline number a guess, so it gets its own bucket.
    expect(classifyTool('backend_chat')).toBe('chat')
  })

  it('never counts reads as work', () => {
    expect(classifyTool('read_backend_state')).toBe('read')
    expect(classifyTool('run_query')).toBe('read')
    expect(classifyTool('get_table_schema')).toBe('read')
  })

  it('falls back to other for an unrecognised tool', () => {
    // A tool added to the brain but not to this taxonomy must land somewhere
    // harmless — never silently inside the schema count.
    expect(classifyTool('some_future_tool')).toBe('other')
  })
})

describe('classifyOutcome', () => {
  it('counts a 2xx write as applied', () => {
    expect(classifyOutcome({ tool: 'create_table', statusCode: 200, code: '', mutation: true }))
      .toBe('applied')
  })

  it('does NOT count a failed write tool as applied', () => {
    // recordMcpCall stamps metadata.mutation from the TOOL NAME before the
    // outcome is known, so a refused create_table still carries mutation:true.
    // Reading that flag as "a change landed" is the one error that would
    // inflate the applied count with operations that changed nothing.
    expect(classifyOutcome({ tool: 'create_table', statusCode: 400, code: 'TOOL_ERROR', mutation: true }))
      .toBe('refused')
  })

  it('counts a destructive refusal as refused, not as a failure', () => {
    // The guardrail routing a drop_table to human approval is the platform
    // working. Nothing was applied.
    expect(classifyOutcome({ tool: 'drop_table', statusCode: 403, code: 'DESTRUCTIVE_NOT_ALLOWED', mutation: true }))
      .toBe('refused')
  })

  it('flags a migration that stopped mid-plan as unresolved', () => {
    // apply_migration stops at the first failing statement; earlier statements
    // may already be in. This is the only bucket that is a safety liability,
    // and it must never be quietly absorbed into "refused".
    expect(classifyOutcome({ tool: 'apply_migration', statusCode: 400, code: 'MIGRATION_FAILED', mutation: true }))
      .toBe('unresolved')
  })

  it('flags a backend_chat turn that threw after applying as unresolved', () => {
    // chat/route.ts only sets mutation:true on a failure path when at least one
    // tool had already succeeded that turn.
    expect(classifyOutcome({ tool: 'backend_chat', statusCode: 500, code: 'Brain failed', mutation: true }))
      .toBe('unresolved')
  })

  it('treats a backend_chat failure that applied nothing as refused', () => {
    expect(classifyOutcome({ tool: 'backend_chat', statusCode: 400, code: 'BAD_BODY', mutation: false }))
      .toBe('refused')
  })

  it('counts a 5xx with nothing applied as errored', () => {
    expect(classifyOutcome({ tool: 'create_table', statusCode: 500, code: 'DISPATCH_FAILED', mutation: false }))
      .toBe('errored')
  })

  it('counts rate limits and quota stops as refused', () => {
    expect(classifyOutcome({ tool: 'apply_migration', statusCode: 429, code: 'RATE_LIMITED', mutation: true }))
      .toBe('refused')
    expect(classifyOutcome({ tool: 'apply_migration', statusCode: 429, code: 'PLAN_LIMIT_EXCEEDED', mutation: true }))
      .toBe('refused')
  })
})

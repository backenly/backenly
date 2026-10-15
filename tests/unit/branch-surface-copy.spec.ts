/**
 * The branch summaries tell the agent what the key really reaches
 * (medium finding BR-05).
 *
 * The connect/create summary line said "auth, functions, storage and
 * realtime refuse this key" while the SAME response's instructions said
 * "End-user auth runs on the branch" — and BRANCH_SCOPED_SURFACES, the
 * authority both ride on, lists the auth sign-in surface. The create_branch
 * description also claimed apply_migration cannot target a branch, which
 * lib/branches/migrate.ts has served via { sql, branchId } since preview
 * environments landed.
 */
import fs from 'fs'
import path from 'path'

import { BRANCH_SCOPED_SURFACES } from '@/lib/branches/key-scope'

const ROOT = process.cwd()
const tools = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', 'tools.ts'), 'utf8')

describe('BR-05: summaries agree with the scope authority', () => {
  it('the authority really lists end-user auth on the branch', () => {
    expect(BRANCH_SCOPED_SURFACES.some((s) => s.includes('/auth/'))).toBe(true)
  })

  it('the endpoint summary names auth as branch-scoped and the refusing surfaces by code', () => {
    expect(tools).not.toContain('auth, functions, storage and realtime refuse this key')
    expect(tools).toContain('end-user auth (signup, signin, refresh-token, logout)')
    expect(tools).toContain('BRANCH_SURFACE_UNAVAILABLE')
  })

  it('create_branch stops claiming migrations cannot target a branch', () => {
    expect(tools).not.toContain('REFUSED by every other endpoint (auth, functions, storage, realtime)')
    expect(tools).toContain('apply_migration is called WITH its branchId')
  })
})

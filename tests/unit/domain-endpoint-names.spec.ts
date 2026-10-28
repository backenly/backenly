/**
 * The change history tells a table's generated endpoints from every other
 * function by name alone (lib/changes/resources/functions.ts): those follow
 * their table through a restore, every other function is in the history.
 * Every name the builders generate must be recognised, or a table's endpoint
 * would be restored twice; and a name a person or a model chose must not be,
 * or that function would be missing from the history.
 */

import { generateDomainEndpoints, isDomainEndpointName } from '@/lib/ai/build-runtime/domain-business-logic'
import { isGeneratedEndpoint } from '@/lib/changes/resources/functions'

const TABLES = [
  'users', 'accounts', 'members', 'profiles', 'jobs', 'render_jobs', 'video_tasks', 'credits', 'credit_wallet', 'wallets',
  'subscriptions', 'team_subscriptions', 'projects', 'workspaces', 'albums', 'payments', 'checkouts', 'audit_logs',
  'orders', 'sales', 'sellers', 'products', 'inventory', 'transactions', 'posts', 'comments',
]

describe('a generated endpoint name', () => {
  it('is recognised for every endpoint the builders generate, in any project', () => {
    for (const subset of [TABLES, ['users', 'jobs'], ['projects', 'assets'], ['posts']]) {
      for (const t of subset) {
        for (const ep of generateDomainEndpoints(t, 'proj', subset)) {
          expect([t, ep.name, isDomainEndpointName(ep.name)]).toEqual([t, ep.name, true])
        }
      }
    }
  })

  it('is not one a person or a model chose', () => {
    for (const name of ['send-welcome-email', 'posts-create', 'orders-summary', 'comments-schema-check', 'admin-dashboard', 'create', '-schema']) {
      expect([name, isDomainEndpointName(name)]).toEqual([name, false])
    }
  })
})

describe('a function row', () => {
  const route = (name: string) => `POST /api/v1/proj/fn/${name}`
  it('is a table endpoint only on its own route, with the origin GENERATE_API gives it', () => {
    expect(isGeneratedEndpoint({ name: 'jobs-create', codeOrigin: 'generated', triggerType: 'manual', triggerTable: route('jobs-create') })).toBe(true)
    expect(isGeneratedEndpoint({ name: 'posts-schema', codeOrigin: 'generated', triggerType: 'manual', triggerTable: route('posts-schema') })).toBe(true)
  })

  it('a model generated on request is not, though its origin and route look the same', () => {
    expect(isGeneratedEndpoint({ name: 'send-invoice', codeOrigin: 'generated', triggerType: 'manual', triggerTable: route('send-invoice') })).toBe(false)
  })

  it('an agent deployed over a generated name is not, nor one served on another route', () => {
    expect(isGeneratedEndpoint({ name: 'jobs-create', codeOrigin: 'agent', triggerType: 'manual', triggerTable: route('jobs-create') })).toBe(false)
    expect(isGeneratedEndpoint({ name: 'jobs-create', codeOrigin: 'generated', triggerType: 'manual', triggerTable: route('jobs-retry') })).toBe(false)
    expect(isGeneratedEndpoint({ name: 'jobs-create', codeOrigin: 'generated', triggerType: 'on_db_insert', triggerTable: 'jobs' })).toBe(false)
  })
})

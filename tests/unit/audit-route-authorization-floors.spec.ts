/**
 * The role-floor dimension of scripts/audit-route-authorization.ts.
 *
 * A handler that can change a project and admits any member of it is
 * reported, and the baseline lists each one with the reason it changes
 * nothing. These cases pin how the audit reads a handler: a wrapper's method
 * default and its `floor` option, a hand check, a handler exported through a
 * factory, an export list or a re-export, and a comment or a string that names
 * a guard without calling it. The last block reads real route files.
 */

import {
  admitsAnyMember,
  compareFloors,
  exportedHandlers,
  handlerFloor,
  handlerFloors,
  withoutComments,
  type FloorBaselineEntry,
  type HandlerFloor,
} from '@/scripts/audit-route-authorization'

const FILE = 'app/api/example/route.ts'

function floorsOf(src: string): Record<string, ReturnType<typeof handlerFloor>> {
  return Object.fromEntries(
    exportedHandlers(FILE, src).map(h => [h.method, handlerFloor(h.method, h.source)]),
  )
}

describe('role floors: how a handler is read', () => {
  it('holds a mutating handler under a wrapper to the Developer role by default', () => {
    const floors = floorsOf(`
import { withProjectAccess } from '@/lib/auth/route-protection'

export const GET = withProjectAccess(async (request, ctx) => NextResponse.json({ ok: true }))

export const DELETE = withProjectAccess(async (request, ctx) => {
  await dropTable(ctx.projectId)
  return NextResponse.json({ ok: true })
})
`)

    expect(floors.GET).toEqual({ floor: 'view', via: 'withProjectAccess default' })
    expect(floors.DELETE).toEqual({ floor: 'write', via: 'withProjectAccess default' })
  })

  it('reads a floor option, including one that lowers a POST to view', () => {
    const floors = floorsOf(`
export async function POST(request: NextRequest) {
  return withProjectValidation(request, async () => NextResponse.json({}), { floor: 'view' })
}

export async function DELETE(request: NextRequest) {
  return withProjectValidation(request, async () => NextResponse.json({}), { floor: 'administer' })
}
`)

    expect(floors.POST).toEqual({ floor: 'view', via: "withProjectValidation { floor: 'view' }" })
    expect(floors.DELETE).toEqual({ floor: 'administer', via: "withProjectValidation { floor: 'administer' }" })
  })

  it('reads withTenantIsolation called inside a handler body', () => {
    const floors = floorsOf(`
export async function DELETE(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      await removeFile(projectId)
      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
`)

    expect(floors.DELETE).toEqual({ floor: 'write', via: 'withTenantIsolation default' })
  })

  it('reports a hand check that establishes membership and nothing more', () => {
    const floors = floorsOf(`
export async function POST(request: NextRequest) {
  const projectId = await getCurrentProjectId(request)
  await prisma.thing.create({ data: { projectId } })
  return NextResponse.json({ ok: true })
}

export async function PUT(request: NextRequest) {
  const user = await requireAuth(request)
  const projectId = await getCurrentProjectId(request)
  if (!(await canWriteProject(user.userId, projectId))) {
    return roleRefusal(request.method)
  }
  return NextResponse.json({ ok: true })
}
`)

    expect(floors.POST).toEqual({ floor: 'view', via: 'getCurrentProjectId only' })
    expect(floors.PUT).toEqual({ floor: 'write', via: 'canWriteProject' })
  })

  it('does not take a guard named in a comment or a string for a call to it', () => {
    const floors = floorsOf(`
export async function POST(request: NextRequest) {
  // canWriteProject is asked for by the service
  /* canAdministerProject, too */
  const note = 'canWriteProject'
  const url = 'https://example.com/a' // canAdministerProject
  const projectId = await getCurrentProjectId(request)
  return NextResponse.json({ note, url, projectId })
}
`)

    expect(floors.POST).toEqual({ floor: 'view', via: 'getCurrentProjectId only' })
  })

  it('reads through a factory to the function it wraps', () => {
    const floors = floorsOf(`
async function handlePOST(request: NextRequest, { params }: Ctx) {
  const { projectId } = await params
  if (!(await canWriteProject(userId, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return NextResponse.json({ ok: true })
}

export const POST = recordedV1(handlePOST)
`)

    expect(floors.POST).toEqual({ floor: 'write', via: 'canWriteProject' })
  })

  it('finds a handler exported without async, and one exported through an export list', () => {
    const handlers = exportedHandlers(FILE, `
export function GET() {
  return NextResponse.json({ ok: true })
}

async function update(request: NextRequest) {
  const projectId = await getCurrentProjectId(request)
  return NextResponse.json({ projectId })
}

export { update as PATCH }
`)

    expect(handlers.map(h => h.method).sort()).toEqual(['GET', 'PATCH'])
    const patch = handlers.find(h => h.method === 'PATCH')!
    expect(handlerFloor('PATCH', patch.source)).toEqual({ floor: 'view', via: 'getCurrentProjectId only' })
  })

  it('reads the access a webhook route asks for, and the guard handed to requireProjectCapability', () => {
    const floors = floorsOf(`
export async function DELETE(request: NextRequest) {
  const denied = await guardWebhookRoute(user.userId, projectId, 'admin', 'stop')
  if (denied) return denied
  return NextResponse.json({ ok: true })
}

export async function POST(request: NextRequest) {
  const { projectId } = await requireProjectCapability(request, canAccessProject)
  return NextResponse.json({ projectId })
}

export async function PUT(request: NextRequest) {
  const { projectId } = await requireProjectCapability(request, canAdministerProject)
  return NextResponse.json({ projectId })
}
`)

    expect(floors.DELETE).toEqual({ floor: 'administer', via: "guardWebhookRoute 'admin'" })
    expect(floors.POST).toEqual({ floor: 'view', via: 'canAccessProject only' })
    expect(floors.PUT).toEqual({ floor: 'administer', via: 'canAdministerProject' })
  })

  it('leaves out a handler that reaches no project through a session', () => {
    const floors = floorsOf(`
export const POST = withAuth(async (request, { user }) => {
  return NextResponse.json({ userId: user.userId })
})
`)

    expect(floors.POST).toBeNull()
  })

  it('keeps a regular expression literal whole while blanking comments', () => {
    const out = withoutComments(`const rel = filePath.replace(/^workspace\\//, '') // canWriteProject`)

    expect(out).toContain(`filePath.replace(/^workspace\\//, '')`)
    expect(out).not.toContain('canWriteProject')
    expect(out).toHaveLength(`const rel = filePath.replace(/^workspace\\//, '') // canWriteProject`.length)
  })
})

describe('role floors: the baseline ratchet', () => {
  const handler = (route: string, method: string, floor: HandlerFloor['floor']): HandlerFloor =>
    ({ route, method, floor, via: 'test' })
  const entry = (route: string, method: string, reason: string): FloorBaselineEntry =>
    ({ route, method, floor: 'view', reason })

  it('counts only mutating handlers that admit any member', () => {
    expect(admitsAnyMember(handler('/api/a', 'GET', 'view'))).toBe(false)
    expect(admitsAnyMember(handler('/api/a', 'POST', 'write'))).toBe(false)
    expect(admitsAnyMember(handler('/api/a', 'POST', 'view'))).toBe(true)
    expect(admitsAnyMember(handler('/api/a', 'DELETE', 'view'))).toBe(true)
  })

  it('passes when every such handler is listed with a reason', () => {
    const result = compareFloors(
      [handler('/api/query', 'POST', 'view'), handler('/api/rows', 'POST', 'write')],
      [entry('/api/query', 'POST', 'Runs read-only SQL.')],
    )

    expect(result.added).toEqual([])
    expect(result.stale).toEqual([])
    expect(result.unexplained).toEqual([])
  })

  it('reports a new handler, an entry that no longer applies, and an entry without a reason', () => {
    const result = compareFloors(
      [
        handler('/api/new', 'DELETE', 'view'),
        handler('/api/floored-again', 'POST', 'write'),
        handler('/api/quiet', 'POST', 'view'),
      ],
      [
        entry('/api/floored-again', 'POST', 'Used to change nothing.'),
        entry('/api/quiet', 'POST', 'UNREVIEWED'),
      ],
    )

    expect(result.added.map(h => `${h.method} ${h.route}`)).toEqual(['DELETE /api/new'])
    expect(result.stale.map(e => `${e.method} ${e.route}`)).toEqual(['POST /api/floored-again'])
    expect(result.unexplained.map(e => `${e.method} ${e.route}`)).toEqual(['POST /api/quiet'])
  })

  it('tells methods of one route apart', () => {
    const result = compareFloors(
      [handler('/api/shares', 'POST', 'view'), handler('/api/shares', 'DELETE', 'view')],
      [entry('/api/shares', 'POST', 'Changes nothing.')],
    )

    expect(result.added.map(h => h.method)).toEqual(['DELETE'])
  })
})

describe('role floors: the route files', () => {
  it.each([
    ['app/api/database/delete-table/route.ts', 'DELETE', 'write'],
    ['app/api/database/query/route.ts', 'POST', 'view'],
    ['app/api/storage/files/[fileId]/route.ts', 'DELETE', 'write'],
    ['app/api/workspace/download/route.ts', 'GET', 'administer'],
    ['app/api/workspace/files/route.ts', 'POST', 'write'],
    ['app/api/preview-shares/route.ts', 'DELETE', 'administer'],
    ['app/api/projects/[id]/webhooks/[webhookId]/route.ts', 'DELETE', 'administer'],
    ['app/api/v1/[projectId]/triggers/route.ts', 'POST', 'write'],
  ])('%s %s needs %s', (file, method, floor) => {
    const found = handlerFloors(file).find(h => h.method === method)

    expect(found?.floor).toBe(floor)
  })

  it('reads a re-exported handler in the file that defines it', () => {
    const register = exportedHandlers('app/api/v1/[projectId]/auth/register/route.ts')
    const signup = exportedHandlers('app/api/v1/[projectId]/auth/signup/route.ts')

    expect(register.map(h => h.method)).toEqual(['POST'])
    expect(register[0].source.length).toBeGreaterThan(0)
    expect(register[0].source).toBe(signup.find(h => h.method === 'POST')?.source)
  })
})

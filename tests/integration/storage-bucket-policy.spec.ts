/**
 * THE SERVING PATH IS THE POLICY, OR THERE IS NO POLICY
 * ====================================================
 *
 * `StorageBucket.accessPolicy` already existed, with four values:
 * `public_read`, `cdn_cacheable`, `private`, `owner_only`. So the register's
 * "a public/private flag and nothing finer" was understating what was declared
 * and overstating what was enforced.
 *
 * What it was actually used for:
 *
 *   - deriving `StorageFile.isPublic` AT UPLOAD TIME, as a snapshot
 *   - choosing a `Cache-Control` header
 *
 * And what the download route gates on: `record.isPublic`, the FILE's own
 * column. Which means an operator who tightens a bucket from `public_read` to
 * `private` gets a success response, a bucket row that says `private`, and every
 * object already in it still served to an anonymous caller for ever.
 *
 * That is the shape this program keeps finding, in its most consequential form
 * yet: the control exists, the dashboard reports it applied, and the path that
 * actually serves bytes never reads it. The first test below is written to FAIL
 * against that behaviour, and it did.
 *
 * ── What these tests hold ───────────────────────────────────────────────────
 *
 * The bucket's CURRENT policy is evaluated when the request arrives, and it is a
 * CEILING: a file may be more restricted than its bucket, never less. That is
 * what makes tightening a bucket effective immediately, which is the property an
 * operator is relying on when they reach for it — usually because something has
 * already leaked.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import jwt from 'jsonwebtoken'
import { ACCESS_POLICIES, clampIsPublic, mayRead } from '@/lib/storage/access-policy'

// ── The driver has to be chosen BEFORE the route is loaded ───────────────────
//
// `storageService` is a module-level singleton built from STORAGE_DRIVER at
// import time, and this developer's .env points it at real S3. A suite that let
// that stand would be reading and writing a live bucket, and the first run of
// this file returned 404 for every case because the temp files it had written to
// disk meant nothing to the S3 driver.
//
// So the driver is pinned here and the route is imported DYNAMICALLY, after the
// assignment. A static import would be hoisted above it and the singleton would
// already exist. This pins the driver, not the access logic: the route's checks,
// the database and the file system all run for real.
process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'storage-policy-suite-secret'

type DownloadHandler = (
  request: unknown,
  ctx: { params: Promise<{ fileId: string }> },
) => Promise<any>

let download: DownloadHandler

const prisma = new PrismaClient()

const SECRET_BYTES = 'TOP-SECRET-BYTES'

let ownerId: string
let strangerId: string
let projectId: string
let dir: string

/**
 * The request surface the download route reads: `nextUrl.searchParams`,
 * `headers.get` and `cookies.get`. A NextRequest cannot be constructed under
 * jest (jest.setup.js stubs `global.Request` with a constructor that assigns
 * `url`, which NextRequest declares getter-only), so the envelope is built here.
 * The route's own logic, the database and the file system all run for real.
 */
function request(opts: { token?: string; bearer?: string } = {}) {
  const params = new URLSearchParams()
  if (opts.token) params.set('token', opts.token)
  return {
    nextUrl: { searchParams: params },
    headers: { get: (n: string) => (n.toLowerCase() === 'authorization' && opts.bearer ? `Bearer ${opts.bearer}` : null) },
    cookies: { get: () => undefined },
  } as any
}

/**
 * Read the served bytes in a way that survives jest's Response stub.
 *
 * `jest.setup.js` replaces `global.Response` with a class that stores `body` and
 * has no `text()`. The route returns `new NextResponse(Buffer.from(...))`, so the
 * bytes are on `.body` under jest and behind `text()` in production. Both are
 * handled rather than asserting against whichever the runtime happens to
 * provide, which is the trap `lib/security/outbound-guard.ts` documents.
 */
async function readBody(res: any): Promise<string> {
  if (typeof res.text === 'function') return res.text()
  const body = res.body
  if (body == null) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (typeof body === 'string') return body
  return String(body)
}

async function get(fileId: string, opts: { token?: string; bearer?: string } = {}) {
  const res = await download(request(opts), { params: Promise.resolve({ fileId }) })
  return { status: res.status, body: res.status === 200 ? await readBody(res) : '' }
}

/**
 * A real platform session for a real user.
 *
 * `authenticateRequest` -> `verifySession` verifies the JWT AND requires a live
 * `Session` row keyed by that exact token, so a hand-signed JWT alone is not a
 * session. The first version of this suite signed one and every operator case
 * came back 401 — a fixture defect that would have been easy to misread as the
 * route refusing the owner.
 */
async function sessionFor(userId: string): Promise<string> {
  const token = jwt.sign({ userId, email: `${userId}@example.test`, role: 'user' }, process.env.JWT_SECRET!, {
    expiresIn: '10m',
  })
  await prisma.session.create({
    data: { userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) },
  })
  return token
}

async function makeFile(bucketId: string, isPublic: boolean, name = 'secret.txt') {
  const path = join(dir, `${crypto.randomBytes(5).toString('hex')}-${name}`)
  writeFileSync(path, SECRET_BYTES)
  return prisma.storageFile.create({
    data: {
      bucketId,
      projectId,
      name,
      path,
      isPublic,
      size: BigInt(SECRET_BYTES.length),
      mimeType: 'text/plain',
    },
  })
}

async function makeBucket(accessPolicy: string) {
  return prisma.storageBucket.create({
    data: {
      name: `b-${crypto.randomBytes(4).toString('hex')}`,
      projectId,
      isPublic: accessPolicy === 'public_read' || accessPolicy === 'cdn_cacheable',
      accessPolicy,
    },
  })
}

beforeAll(async () => {
  ;({ GET: download } = (await import(
    '@/app/api/storage/files/[fileId]/download/route'
  )) as unknown as { GET: DownloadHandler })

  dir = mkdtempSync(join(tmpdir(), 'storage-policy-'))

  const mkUser = async (label: string) =>
    (
      await prisma.user.create({
        data: {
          email: `storage-${label}-${crypto.randomBytes(5).toString('hex')}@example.test`,
          password: 'not-a-real-hash',
          name: label,
        },
        select: { id: true },
      })
    ).id

  ownerId = await mkUser('owner')
  strangerId = await mkUser('stranger')

  projectId = (
    await prisma.project.create({ data: { name: 'storage-policy', userId: ownerId }, select: { id: true } })
  ).id
}, 180_000)

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, strangerId] } } }).catch(() => {})
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  await prisma.$disconnect()
}, 180_000)

describe('a public bucket serves, which is the control for every refusal below', () => {
  it('serves an object in a public_read bucket to an anonymous caller', async () => {
    const bucket = await makeBucket('public_read')
    const file = await makeFile(bucket.id, true)

    const res = await get(file.id)
    expect(res.status).toBe(200)
    expect(res.body).toContain(SECRET_BYTES)
  }, 60_000)
})

describe('tightening a bucket takes effect immediately', () => {
  it('STOPS serving existing objects once the bucket becomes private', async () => {
    const bucket = await makeBucket('public_read')
    const file = await makeFile(bucket.id, true)

    // Precondition stated, not assumed.
    expect((await get(file.id)).status).toBe(200)

    // Exactly what the dashboard does: change the bucket's policy.
    await prisma.storageBucket.update({
      where: { id: bucket.id },
      data: { accessPolicy: 'private', isPublic: false },
    })

    // The regression this pins. Before the fix this returned 200 and the bytes,
    // for ever, because the route read the FILE's snapshotted isPublic and the
    // operator had only changed the bucket.
    const after = await get(file.id)
    expect(after.status).toBe(401)
    expect(after.body).not.toContain(SECRET_BYTES)
  }, 60_000)

  it('does not need the file rows rewritten for the change to hold', async () => {
    const bucket = await makeBucket('public_read')
    const file = await makeFile(bucket.id, true)
    await prisma.storageBucket.update({
      where: { id: bucket.id },
      data: { accessPolicy: 'private', isPublic: false },
    })

    // The file row is deliberately left saying isPublic: true. A fix that
    // cascaded a column update would pass the test above and still leave every
    // other writer of that column able to reopen the hole; evaluating the
    // bucket at request time is what closes it.
    const row = await prisma.storageFile.findUniqueOrThrow({ where: { id: file.id } })
    expect(row.isPublic).toBe(true)
    expect((await get(file.id)).status).toBe(401)
  }, 60_000)

  it('serves again when the bucket is opened back up', async () => {
    const bucket = await makeBucket('private')
    // Marked public on the FILE while the bucket forbids it, which is the
    // write-time bypass case: the row says public and the ceiling refuses it.
    const file = await makeFile(bucket.id, true)
    expect((await get(file.id)).status).toBe(401)

    await prisma.storageBucket.update({
      where: { id: bucket.id },
      data: { accessPolicy: 'public_read', isPublic: true },
    })

    // Not one-directional: the policy is evaluated per request, so loosening
    // works the same way tightening does.
    const after = await get(file.id)
    expect(after.status).toBe(200)
    expect(after.body).toContain(SECRET_BYTES)
  }, 60_000)

  it('does NOT retroactively publish files that are marked private', async () => {
    const bucket = await makeBucket('private')
    const file = await makeFile(bucket.id, false)

    await prisma.storageBucket.update({
      where: { id: bucket.id },
      data: { accessPolicy: 'public_read', isPublic: true },
    })

    // Opening a bucket raises the ceiling; it does not reach down and publish
    // objects that say they are not public. Narrowing is always the file's to
    // keep, and an operator widening a bucket has not consented to exposing
    // everything that was deliberately held back inside it.
    expect((await get(file.id)).status).toBe(401)
  }, 60_000)
})

describe('the bucket policy is a ceiling, not a default', () => {
  it('refuses a file marked public inside a private bucket', async () => {
    const bucket = await makeBucket('private')
    // The dangerous combination: a per-file flag that is more permissive than
    // the bucket. Containment means the narrower of the two wins.
    const file = await makeFile(bucket.id, true)

    expect((await get(file.id)).status).toBe(401)
  }, 60_000)

  it('keeps a file marked private inside a public bucket private', async () => {
    const bucket = await makeBucket('public_read')
    const file = await makeFile(bucket.id, false)

    // More restricted than its bucket is allowed. Only less is not.
    expect((await get(file.id)).status).toBe(401)

    // CONTROL: a public file in the same bucket is served, so the refusal above
    // is about the file's own flag and not about the bucket being broken.
    const sibling = await makeFile(bucket.id, true, 'sibling.txt')
    expect((await get(sibling.id)).status).toBe(200)
  }, 60_000)
})

describe('who may read a private object', () => {
  it('refuses an anonymous caller', async () => {
    const bucket = await makeBucket('private')
    const file = await makeFile(bucket.id, false)
    expect((await get(file.id)).status).toBe(401)
  }, 60_000)
})

/**
 * The operator and cross-tenant cases are asserted on the DECISION, not through
 * the route, and that is a statement about the edition rather than a shortcut.
 *
 * In single-tenant — which is what self-host is — `canAccessProject` treats any
 * authenticated account as the operator of the one project, so a "stranger with
 * a valid session" does not exist there. The resolver goes further and REFUSES
 * outright when it finds several projects, which is what this shared test
 * database has: driving the route produced
 * `MultipleProjectsInSingleTenantError`, correctly, because one deployment is
 * one project and choosing between them would hand one tenant's data to
 * another.
 *
 * So the cross-tenant claim is a Cloud claim. It lives where the logic lives,
 * and the route's job — classifying a caller as operator or stranger via
 * canAccessProject — is covered by the authorization baseline and its own suite.
 */
describe('the policy decision for operators and strangers', () => {
  const privateObject = { bucketPolicy: 'private', fileIsPublic: false, uploadedBy: null }

  it('lets the project operator read under every policy', () => {
    for (const policy of ACCESS_POLICIES) {
      const decision = mayRead(
        { bucketPolicy: policy, fileIsPublic: false, uploadedBy: 'someone-else' },
        { kind: 'operator', userId: ownerId },
      )
      expect(decision.allowed).toBe(true)
    }
  })

  it('refuses an authenticated caller with no access to the project', () => {
    const decision = mayRead(privateObject, { kind: 'stranger', userId: strangerId })
    expect(decision.allowed).toBe(false)
    // 403, not 401: they are identified, and retrying with the same credential
    // will not help.
    expect(decision.status).toBe(403)
  })

  it('lets that same stranger read something genuinely public', () => {
    // CONTROL: the stranger is not refused everything, so the refusal above is
    // about entitlement rather than about the branch denying unconditionally.
    const decision = mayRead(
      { bucketPolicy: 'public_read', fileIsPublic: true, uploadedBy: null },
      { kind: 'stranger', userId: strangerId },
    )
    expect(decision.allowed).toBe(true)
  })

  it('fails closed on a policy value this build does not recognise', () => {
    // A row predating the column, or written by a newer version. Serving it to
    // anyone because the string did not match is the wrong default.
    for (const reader of [
      { kind: 'anonymous' } as const,
      { kind: 'signed' } as const,
      { kind: 'endUser', userId: 'u' } as const,
    ]) {
      const decision = mayRead(
        { bucketPolicy: 'something_new', fileIsPublic: true, uploadedBy: 'u' },
        reader,
      )
      // Treated as `private`: a signed link still works, nothing else does.
      if (reader.kind === 'signed') expect(decision.allowed).toBe(true)
      else expect(decision.allowed).toBe(false)
    }
  })

  it('clamps a requested public flag to what the bucket permits', () => {
    // The write-time half. A caller asking for public inside a private bucket
    // gets false, which is what stopped an API-key holder putting a
    // world-readable object into a private bucket.
    expect(clampIsPublic(true, 'private')).toBe(false)
    expect(clampIsPublic(true, 'owner_only')).toBe(false)
    expect(clampIsPublic(true, 'public_read')).toBe(true)
    expect(clampIsPublic(false, 'public_read')).toBe(false)
    // Unspecified in a public bucket keeps the previous default of public.
    expect(clampIsPublic(undefined, 'public_read')).toBe(true)
    expect(clampIsPublic(undefined, 'private')).toBe(false)
  })
})

describe('signed links', () => {
  function sign(fileId: string, expiresAt: number): string {
    const secret = process.env.STORAGE_SECRET ?? ''
    const hmac = crypto.createHmac('sha256', secret).update(`${fileId}:${expiresAt}`).digest('hex')
    return `${expiresAt}:${hmac}`
  }

  it('honours a valid signature, and refuses a forged or expired one', async () => {
    // Skipping would be silent; saying so is not. Without the secret the route
    // cannot verify anything and this proves nothing.
    if (!process.env.STORAGE_SECRET) {
      throw new Error('STORAGE_SECRET is not set, so the signed-link claims cannot be tested')
    }

    const bucket = await makeBucket('private')
    const file = await makeFile(bucket.id, false)

    // CONTROL: a correct signature works, so the refusals below are about the
    // signature rather than about signed links being broken.
    const valid = await get(file.id, { token: sign(file.id, Date.now() + 60_000) })
    expect(valid.status).toBe(200)
    expect(valid.body).toContain(SECRET_BYTES)

    // Expired.
    expect((await get(file.id, { token: sign(file.id, Date.now() - 1_000) })).status).toBe(401)
    // Forged.
    expect((await get(file.id, { token: `${Date.now() + 60_000}:${'0'.repeat(64)}` })).status).toBe(401)
    // Signed for a DIFFERENT file: a signature is not a bearer token for the
    // whole bucket.
    const other = await makeFile(bucket.id, false, 'other.txt')
    expect((await get(other.id, { token: sign(file.id, Date.now() + 60_000) })).status).toBe(401)
  }, 60_000)

  it('does not let a signed link outlive the bucket being made private', async () => {
    if (!process.env.STORAGE_SECRET) {
      throw new Error('STORAGE_SECRET is not set, so the signed-link claims cannot be tested')
    }

    const bucket = await makeBucket('public_read')
    const file = await makeFile(bucket.id, true)
    const token = sign(file.id, Date.now() + 3_600_000)

    // A signed link is a deliberate grant and stays valid while the bucket
    // allows reading at all. Asserted as the control for the tightening below.
    expect((await get(file.id, { token })).status).toBe(200)

    await prisma.storageBucket.update({
      where: { id: bucket.id },
      data: { accessPolicy: 'owner_only', isPublic: false },
    })

    // owner_only means only the uploading end user, so a link signed for
    // anonymous delivery must stop working. An hour-long token that survives an
    // operator locking the bucket down is the same defect in another costume.
    expect((await get(file.id, { token })).status).toBe(403)
  }, 60_000)
})

describe('owner_only restricts to the end user who uploaded the object', () => {
  it('lets that end user read it, and refuses another end user of the same project', async () => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    // A project without a signing secret cannot mint end-user tokens, so there
    // is nothing to test rather than nothing to find.
    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      await prisma.project.update({
        where: { id: projectId },
        data: { jwtSecret: crypto.randomBytes(32).toString('hex') },
      })
    }
    const secret = (
      await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { jwtSecret: true } })
    ).jwtSecret!

    const bucket = await makeBucket('owner_only')
    const uploader = crypto.randomUUID()
    const bystander = crypto.randomUUID()

    const path = join(dir, `${crypto.randomBytes(5).toString('hex')}-owned.txt`)
    writeFileSync(path, SECRET_BYTES)
    const file = await prisma.storageFile.create({
      data: {
        bucketId: bucket.id,
        projectId,
        name: 'owned.txt',
        path,
        isPublic: false,
        uploadedBy: uploader,
        size: BigInt(SECRET_BYTES.length),
        mimeType: 'text/plain',
      },
    })

    const endUserToken = (userId: string) =>
      jwt.sign({ userId, projectId, email: `${userId}@example.test`, role: 'user' }, secret, {
        expiresIn: '10m',
      })

    // The uploader reads their own object.
    const mine = await get(file.id, { bearer: endUserToken(uploader) })
    expect(mine.status).toBe(200)
    expect(mine.body).toContain(SECRET_BYTES)

    // Another end user of the SAME project does not. This is the whole point of
    // owner_only, and before this tranche it behaved identically to `private`:
    // the value was accepted, stored, and meant nothing at serve time.
    const theirs = await get(file.id, { bearer: endUserToken(bystander) })
    expect(theirs.status).toBe(403)
    expect(theirs.body).not.toContain(SECRET_BYTES)

    // And anonymous is refused, as always.
    expect((await get(file.id)).status).toBe(401)
  }, 60_000)

  it('still lets the project operator read it, because they administer the bucket', () => {
    // owner_only narrows which END USER may read, not whether the operator can
    // administer their own storage. Stated explicitly so nobody later "fixes"
    // it into locking an operator out of their own bucket, which would also
    // make the dashboard unable to list a project's own files.
    //
    // At the decision level, for the edition reason given above.
    const owned = { bucketPolicy: 'owner_only', fileIsPublic: false, uploadedBy: crypto.randomUUID() }
    expect(mayRead(owned, { kind: 'operator', userId: ownerId }).allowed).toBe(true)
    expect(mayRead(owned, { kind: 'stranger', userId: strangerId }).allowed).toBe(false)
  })
})

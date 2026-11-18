/**
 * The Firebase import driver end to end (lib/import/drivers/firebase.ts), with
 * Google faked at the HTTP layer (tests/helpers/fake-google.ts) and the new
 * Backenly project held in memory (the FirebaseDestination seam the real
 * writer implements in lib/import/drivers/firebase-destination.ts):
 *
 *   inspect  the Review step's preview: tables with counts and notes, users,
 *            the files bucket, one rule per table, what does not move;
 *   check    the fast refusal before a project is created;
 *   run      tables created as one change, rows linked parent to child,
 *            counts verified, users with hashes sign-in accepts, files with
 *            their paths, progress the ledger can show, and only Google's
 *            API hosts ever called.
 *
 * Database-free.
 */

import { createFirebaseDriver, FIREBASE_NEVER_MOVES } from '@/lib/import/drivers/firebase'
import type { FirebaseDestination, FileUpload } from '@/lib/import/drivers/firebase-destination'
import type { ImportedUser } from '@/lib/import/drivers/firebase-users'
import type { PlannedColumn, TablePlan } from '@/lib/import/drivers/firebase-schema'
import { GOOGLE_API_HOSTS } from '@/lib/import/google-http'
import { ImportInputError, type RunContext } from '@/lib/import/driver'
import { ImportAborted } from '@/lib/import/pg-engine'
import { verifyFirebaseHash } from '@/lib/auth/firebase-scrypt'
import { FakeGoogle, makeServiceAccount } from '../../tests/helpers/fake-google'

const SA = makeServiceAccount('demo-shop')
const noSleep = async () => {}

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read: if true; // "public" posts
      allow write: if request.auth != null && request.auth.uid == resource.data.author;
      match /comments/{commentId} {
        allow read, write: if request.auth != null;
      }
    }
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }
  }
}`

/** A small shop: posts with comments (one under a deleted post), profiles, logs with a late subcollection, users, files. */
function demoProject(): FakeGoogle {
  const g = new FakeGoogle(SA)
  g.put('posts/p1', {
    title: { stringValue: 'Hello' },
    likes: { integerValue: '3' },
    createdAt: { timestampValue: '2024-03-01T10:15:30.123456789Z' },
    author: { referenceValue: `${g.root}/users/kYi4EvWQlQTKSfnJ3dRSP6IH3ed2` },
  })
  g.put('posts/p1/comments/c1', { body: { stringValue: 'First!' } })
  g.put('posts/p1/comments/c2', { body: { stringValue: 'Second' } })
  g.put('posts/p2', { title: { stringValue: 'Again' }, likes: { integerValue: '5' } })
  g.put('posts/p2/comments/c1', { body: { stringValue: 'Same id, other post' } })
  g.put('posts/ghost/comments/g1', { body: { stringValue: 'Its post was deleted' } })
  g.put('users/kYi4EvWQlQTKSfnJ3dRSP6IH3ed2', { displayName: { stringValue: 'Test User 1' }, plan: { stringValue: 'pro' } })
  for (let i = 0; i < 30; i++) g.put(`logs/l${String(i).padStart(2, '0')}`, { level: { stringValue: 'info' }, n: { integerValue: String(i) } })
  // Under the last log only: the preview's sample of parents never reaches it.
  g.put('logs/l29/entries/e1', { text: { stringValue: 'found while moving' } })

  g.hashConfig = {
    algorithm: 'SCRYPT',
    signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
    saltSeparator: 'Bw==',
    rounds: 8,
    memoryCost: 14,
  }
  g.users = [
    {
      localId: 'kYi4EvWQlQTKSfnJ3dRSP6IH3ed2',
      email: 'user1@test.com',
      displayName: 'Test User 1',
      passwordHash: 'lSrfV15cpx95_sZS2W9c9Kp6i_LVgQNDNC_qzrCnh1SAyZvqmZqAjTdn3aoItz-VHjoZilo78198JAdRuid5lQ==',
      salt: '42xEC-ixf3L2lw==',
      providerUserInfo: [{ providerId: 'password', email: 'user1@test.com', rawId: 'user1@test.com' }],
      createdAt: '1508893925000',
      lastLoginAt: '1508893925000',
    },
    {
      localId: 'G00gl3Us3r0000000000000001',
      email: 'grace@example.com',
      emailVerified: true,
      providerUserInfo: [{ providerId: 'google.com', rawId: '108765432109876543210', email: 'grace@example.com' }],
      createdAt: '1700000000000',
    },
    { localId: 'Ph0n30nly000000000000000001', phoneNumber: '+15555550123', providerUserInfo: [{ providerId: 'phone', rawId: '+15555550123' }] },
  ]

  g.objects.set('avatars/u1.png', { contentType: 'image/png', data: Buffer.from('png-bytes') })
  g.objects.set('docs/readme.txt', { contentType: 'application/octet-stream', data: Buffer.from('hello') })
  g.objects.set('bin/tool.sh', { contentType: 'text/x-sh', data: Buffer.from('#!/bin/sh') })
  g.objects.set('big/video.mp4', { contentType: 'video/mp4', data: Buffer.alloc(200, 1) })
  g.rulesSource = RULES
  return g
}

/** The new project, in memory: what the real writer would put in PostgreSQL and Storage. */
class MemoryProject implements FirebaseDestination {
  readonly created: Array<{ title: string; tables: string[] }> = []
  readonly tables = new Map<string, { plan: TablePlan; extra: boolean; rows: Array<Record<string, unknown>> }>()
  readonly extraAdded: string[] = []
  users: ImportedUser[] = []
  usersPrepared = false
  readonly files = new Map<string, { size: number; mimeType: string | null }>()
  bucketMax: number | null = null
  quotaFiles = Infinity
  closed = false

  async createTables(plans: TablePlan[], title: string) {
    this.created.push({ title, tables: plans.map((p) => p.name) })
    for (const p of plans) {
      if (this.tables.has(p.name)) throw new Error(`table ${p.name} created twice`)
      this.tables.set(p.name, { plan: p, extra: p.extraColumn, rows: [] })
    }
    return []
  }
  async addExtraColumn(table: string) {
    this.tables.get(table)!.extra = true
    this.extraAdded.push(table)
  }
  async insertRows(table: string, columns: PlannedColumn[], rows: unknown[][]) {
    const t = this.tables.get(table)
    if (!t) throw new Error(`no table ${table}`)
    if (columns.some((c) => c.name === 'extra_fields') && !t.extra) throw new Error(`${table} has no extra_fields`)
    let n = 0
    for (const row of rows) {
      const obj = Object.fromEntries(columns.map((c, i) => [c.name, row[i]]))
      if (t.rows.some((r) => r.id === obj.id)) continue // ON CONFLICT DO NOTHING
      t.rows.push(obj)
      n++
    }
    return n
  }
  async countRows(table: string) {
    return this.tables.get(table)!.rows.length
  }
  /** What the rows held come to, as the real writer's pg_table_size would say it. */
  async measureRows() {
    let bytes = 0
    for (const t of this.tables.values()) for (const r of t.rows) bytes += JSON.stringify(r).length
    for (const u of this.users) bytes += JSON.stringify(u).length
    return bytes
  }
  async prepareUsers() {
    this.usersPrepared = true
  }
  async insertUsers(users: ImportedUser[]) {
    let n = 0
    for (const u of users) {
      if (this.users.some((x) => x.email === u.email)) continue
      this.users.push(u)
      n++
    }
    return n
  }
  async countImportedUsers() {
    return this.users.length
  }
  async prepareFilesBucket(maxFileBytes: number) {
    this.bucketMax = maxFileBytes
    return 'bucket-files'
  }
  async uploadFile(bucketId: string, file: FileUpload) {
    expect(bucketId).toBe('bucket-files')
    if (this.files.size >= this.quotaFiles) return { ok: false, code: 'STORAGE_QUOTA_EXCEEDED', message: 'Storage quota exceeded.', stop: true }
    this.files.set(file.name, { size: file.buffer.length, mimeType: file.mimeType })
    return { ok: true }
  }
  async close() {
    this.closed = true
  }
}

function runContext(project: MemoryProject, patch: Partial<RunContext> = {}) {
  const progress: Array<Parameters<RunContext['progress']>[0]> = []
  const ctx: RunContext = {
    userId: 'user-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    jobId: 'job-1',
    signal: new AbortController().signal,
    include: { users: true, files: true },
    progress: (p) => progress.push(p),
    ...patch,
  }
  return { ctx, progress, project }
}

function driverFor(g: FakeGoogle, project: MemoryProject, limits: Record<string, number> = {}) {
  return createFirebaseDriver({
    transport: g.transport,
    sleep: noSleep,
    destination: () => project,
    limits: { maxFileBytes: 100, ...limits },
    now: () => Date.UTC(2026, 10, 16, 12, 0, 0),
  })
}

const inspectCtx = (limits?: any) => ({ userId: 'user-1', orgId: 'org-1', signal: new AbortController().signal, ...(limits ? { limits } : {}) })

describe('inspect: the Review step', () => {
  it('previews every table, the users, the files and the rules, reading only', async () => {
    const g = demoProject()
    const preview = await driverFor(g, new MemoryProject()).inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx())

    expect(preview.source).toBe('firebase')
    expect(preview.sourceLabel).toBe('Demo Shop')
    expect(preview.refusal).toBeNull()
    expect(preview.tables.map((t) => [t.sourceName, t.name, t.rows])).toEqual([
      ['logs', 'logs', 30],
      ['posts', 'posts', 2],
      ['users', 'profiles', 1],
      ['posts/{id}/comments', 'posts_comments', 4],
    ])
    const posts = preview.tables.find((t) => t.name === 'posts')!
    expect(posts.columns).toBe(3 + 4) // id, createdAt, updatedAt + firebase_id, author, likes, title
    expect(posts.notes).toEqual(expect.arrayContaining(['Document ids are in firebase_id.', '"createdAt" fills Backenly\'s own createdAt.']))
    expect(preview.tables.find((t) => t.name === 'profiles')!.notes[0]).toBe("users is Backenly's sign-in table, so these documents arrive in profiles.")
    // Every log was read for its types, so nothing is said about a partial sample.
    expect(preview.tables.find((t) => t.name === 'logs')!.notes.some((n) => n.startsWith('Column types come from'))).toBe(false)

    expect(preview.users).toEqual({ total: 3, withPassword: 1, providerOnly: 1, skipped: 1 })
    expect(preview.buckets).toEqual([{ sourceName: 'demo-shop.appspot.com', name: 'files', files: 4, bytes: 9 + 5 + 9 + 200, public: false }])

    expect(preview.rules.map((r) => r.table)).toEqual(['logs', 'posts', 'profiles', 'posts_comments'])
    expect(preview.rules.every((r) => r.summary.startsWith('Waits for your approval.'))).toBe(true)
    expect(preview.rules.find((r) => r.table === 'posts')!.definition).toMatch(/^match \/posts\/\{postId\} \{[\s\S]*allow read: if true;[\s\S]*\}$/)
    expect(preview.rules.find((r) => r.table === 'posts_comments')!.definition).toBe(
      'match /comments/{commentId} {\n        allow read, write: if request.auth != null;\n      }',
    )
    expect(preview.rules.find((r) => r.table === 'profiles')!.definition).toMatch(/^match \/users\/\{userId\}/)
    expect(preview.rules.find((r) => r.table === 'logs')!.definition).toBeNull()

    expect(preview.warnings).toEqual(expect.arrayContaining([
      ...FIREBASE_NEVER_MOVES,
      '1 user signs in only with a phone number, so it is not moved.',
      // The test's file limit is 100 bytes; sizes are said in MB, at least 1.
      "1 file is over 1 MB and won't move: big/video.mp4 (1 MB).",
      "1 executable file won't move (Backenly doesn't store them): bin/tool.sh.",
    ]))

    // Read only, and only from Google.
    expect(g.calls.every((c) => c.method === 'GET' || /:(listCollectionIds|runAggregationQuery|query)$|\/token$/.test(c.url))).toBe(true)
    expect(g.hostsCalled().every((h) => GOOGLE_API_HOSTS.has(h))).toBe(true)
    expect(g.calls.some((c) => c.url.includes('attacker'))).toBe(false)
  })

  it("refuses under the key field when the key can't read Firestore, naming the role", async () => {
    const g = demoProject()
    g.deny.add('firestore')
    const err = await driverFor(g, new MemoryProject()).inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx()).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.field).toBe('serviceAccountJson')
    expect(err.message).toBe("This key can't read Firestore. Give the service account the Cloud Datastore Viewer role.")
  })

  it('refuses under the key field when Google refuses the key', async () => {
    const g = demoProject()
    g.tokenRefusal = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }
    const err = await driverFor(g, new MemoryProject()).inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx()).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toMatch(/deleted or replaced/)
  })

  it('says which part will not move when the key can read only some of the project', async () => {
    const g = demoProject()
    g.deny.add('auth')
    g.deny.add('storage')
    g.deny.add('rules')
    const preview = await driverFor(g, new MemoryProject()).inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx())
    expect(preview.users).toBeNull()
    expect(preview.buckets).toBeNull()
    expect(preview.tables).toHaveLength(4)
    expect(preview.rules.every((r) => r.definition === null)).toBe(true)
    expect(preview.warnings).toEqual(expect.arrayContaining([
      "Users won't move: This key can't read Firebase Authentication. Give the service account the Firebase Authentication Admin role.",
      "Files won't move: This key can't read Cloud Storage. Give the service account the Storage Object Viewer role.",
    ]))
  })

  it('treats a project without Firestore as having no tables, and an empty project as nothing to move', async () => {
    const g = demoProject()
    g.firestoreMissing = true
    const preview = await driverFor(g, new MemoryProject()).inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx())
    expect(preview.tables).toEqual([])
    expect(preview.warnings).toContain('This project has no Firestore database, so there are no documents to move.')
    expect(preview.refusal).toBeNull()

    const empty = new FakeGoogle(SA)
    empty.authConfigured = false
    const nothing = await driverFor(empty, new MemoryProject()).inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx())
    expect(nothing.users).toEqual({ total: 0, withPassword: 0, providerOnly: 0, skipped: 0 })
    expect(nothing.refusal).toBe('There is nothing to move: this Firebase project has no Firestore documents, users or files.')
  })

  it("says the plan's limits: rows refuse, files can be left out", async () => {
    const g = demoProject()
    const preview = await driverFor(g, new MemoryProject()).inspect(
      { source: 'firebase', serviceAccountJson: SA.json },
      inspectCtx({ maxRowBytes: 200, maxFileBytes: 10, planName: 'Free' }),
    )
    expect(preview.refusal).toMatch(/^This source holds about .* of rows, and Free includes 200 bytes of database storage\./)
    expect(preview.warnings[0]).toMatch(/^The files come to about .*, and Free includes 10 bytes of file storage\. Leave files out/)
  })
})

describe('check: before the project is created', () => {
  it('passes a key that can read, and refuses one that cannot or a source over the plan', async () => {
    const driver = driverFor(demoProject(), new MemoryProject())
    await expect(driver.check!({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx())).resolves.toBeUndefined()

    const denied = demoProject()
    denied.deny.add('firestore')
    const err = await driverFor(denied, new MemoryProject()).check!({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx()).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toBe("This key can't read Firestore. Give the service account the Cloud Datastore Viewer role.")

    const big = await driver.check!({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx({ maxRowBytes: 100, maxFileBytes: null, planName: 'Free' })).catch((e) => e)
    expect(big).toBeInstanceOf(ImportInputError)
    expect(big.message).toMatch(/Free includes 100 bytes of database storage/)

    await expect(driver.check!({ source: 'firebase', serviceAccountJson: '{"type":"authorized_user"}' }, inspectCtx())).rejects.toThrow(/personal Google sign-in/)
  })
})

describe('run: the move', () => {
  it('moves tables, users and files, verified, into the new project', async () => {
    const g = demoProject()
    const project = new MemoryProject()
    const { ctx, progress } = runContext(project)
    const result = await driverFor(g, project).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)

    // Tables: the planned ones as one change, the one found while moving on its own.
    expect(project.created).toEqual([
      { title: 'Move in from Firebase: 4 tables', tables: ['logs', 'posts', 'profiles', 'posts_comments'] },
      { title: 'Move in from Firebase: logs_entries', tables: ['logs_entries'] },
    ])
    const rows = (t: string) => project.tables.get(t)!.rows
    expect(rows('posts').map((r) => r.firebase_id)).toEqual(['p1', 'p2'])
    expect(rows('posts')[0]).toMatchObject({ title: 'Hello', likes: '3', author: 'users/kYi4EvWQlQTKSfnJ3dRSP6IH3ed2', createdAt: '2024-03-01T10:15:30.123456Z' })
    expect(rows('posts_comments')).toHaveLength(4)
    const p1 = rows('posts').find((r) => r.firebase_id === 'p1')!
    const underP1 = rows('posts_comments').filter((r) => r.parent_id === p1.id).map((r) => r.firebase_id)
    expect(underP1.sort()).toEqual(['c1', 'c2'])
    // The comment of the deleted post arrives; its parent_id points to no row.
    const orphan = rows('posts_comments').find((r) => r.firebase_id === 'g1')!
    expect(rows('posts').some((r) => r.id === orphan.parent_id)).toBe(false)
    expect(rows('profiles')).toHaveLength(1)
    expect(rows('logs')).toHaveLength(30)
    expect(rows('logs_entries')).toEqual([expect.objectContaining({ firebase_id: 'e1', parent_id: rows('logs').find((r) => r.firebase_id === 'l29')!.id })])

    // Users: the password user keeps their password, the provider user their identity.
    expect(project.usersPrepared).toBe(true)
    expect(project.users.map((u) => u.email)).toEqual(['user1@test.com', 'grace@example.com'])
    await expect(verifyFirebaseHash('user1password', project.users[0].password!)).resolves.toBe(true)
    expect(project.users[1]).toMatchObject({ oauthProvider: 'google', oauthId: '108765432109876543210', password: null })

    // Files: paths kept, types from Storage or the name; the executable and the oversized one left behind.
    expect(project.bucketMax).toBe(100)
    expect([...project.files.entries()]).toEqual([
      ['avatars/u1.png', { size: 9, mimeType: 'image/png' }],
      ['docs/readme.txt', { size: 5, mimeType: 'text/plain' }],
    ])

    expect(result.importedFrom).toEqual({
      source: 'firebase',
      at: '2026-11-16T12:00:00.000Z',
      tables: 5,
      rows: 30 + 2 + 1 + 4 + 1,
      users: 2,
      files: 2,
      rulesPending: 5,
    })
    expect(result.warnings).toEqual(expect.arrayContaining([
      "All 5 moved tables answer only your server key until you set their access rules: Firestore rules aren't translated.",
      'posts_comments: 1 row belongs to posts documents deleted in Firebase; parent_id points to no row.',
      '1 user signs in only with a phone number, so it is not moved.',
      "1 file is over 1 MB and didn't move: big/video.mp4 (1 MB).",
      "1 file didn't move: bin/tool.sh (an executable file).",
    ]))
    expect(project.closed).toBe(true)

    // Progress: the phases in order, every table verified with all of its rows.
    const phases = progress.map((p) => p.phase).filter(Boolean)
    expect(phases).toEqual(['tables', 'rows', 'users', 'files', 'verifying'])
    const last = new Map<string, any>()
    for (const p of progress) for (const t of p.tables ?? []) last.set(t.name, t)
    for (const [name, t] of last) {
      expect({ name, ...t }).toEqual({ name, sourceRows: rows(name).length, copiedRows: rows(name).length, verified: true })
    }
    const lastUsers = progress.filter((p) => p.users).at(-1)!.users!
    expect(lastUsers).toEqual({ total: 3, copied: 2 })
    const lastFiles = progress.filter((p) => p.files).at(-1)!.files!
    expect(lastFiles).toEqual({ total: 4, copied: 2, bytes: 223, copiedBytes: 14 })

    // Read only, and only from Google.
    expect(g.hostsCalled().every((h) => GOOGLE_API_HOSTS.has(h))).toBe(true)
    expect(g.calls.every((c) => c.method === 'GET' || /:(listCollectionIds|runAggregationQuery|query)$|\/token$/.test(c.url))).toBe(true)
  })

  it('keeps a field the sample never saw in extra_fields, added when it first arrives', async () => {
    const g = demoProject()
    g.put('posts/p2', { title: { stringValue: 'Again' }, likes: { doubleValue: 2.5 }, subtitle: { stringValue: 'new' } })
    const project = new MemoryProject()
    const { ctx, progress } = runContext(project, { include: { users: false, files: false } })
    const result = await driverFor(g, project, { sampleSize: 1 }).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)
    expect(project.extraAdded).toContain('posts')
    const p2 = project.tables.get('posts')!.rows.find((r) => r.firebase_id === 'p2')!
    expect(p2.likes).toBeNull()
    expect(JSON.parse(p2.extra_fields as string)).toEqual({ likes: 2.5, subtitle: 'new' })
    expect(result.importedFrom.users).toBeUndefined()
    expect(result.importedFrom.files).toBeUndefined()
    expect(progress.some((p) => p.phase === 'users' || p.phase === 'files')).toBe(false)
    expect(result.warnings.some((w) => /didn't fit .* kept in extra_fields/.test(w))).toBe(true)
  })

  it('moves the same rows when the database refuses a recursive listing', async () => {
    const g = demoProject()
    g.recursiveUnsupported = true
    const project = new MemoryProject()
    const { ctx } = runContext(project, { include: { users: false, files: false } })
    const result = await driverFor(g, project).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)
    expect(result.importedFrom.rows).toBe(38)
    expect(project.tables.get('posts_comments')!.rows).toHaveLength(4)
    expect(project.tables.get('logs_entries')!.rows).toHaveLength(1)
    expect(result.warnings).toContain("This database could not be listed in one pass, so each document's subcollections were looked up one by one.")
  })

  it('stops files, not the import, when the plan runs out of storage', async () => {
    const g = demoProject()
    const project = new MemoryProject()
    project.quotaFiles = 1
    const { ctx } = runContext(project)
    const result = await driverFor(g, project).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)
    expect(project.files.size).toBe(1)
    expect(result.importedFrom.files).toBe(1)
    expect(result.warnings.some((w) => /^Files stopped at 1 of 4: Storage quota exceeded\./.test(w))).toBe(true)
  })

  it("ends only the files when Backenly's own storage fails, and finishes with what moved", async () => {
    const g = demoProject()
    const project = new MemoryProject()
    project.uploadFile = async () => {
      throw new Error('STORAGE_SECRET is not set')
    }
    const { ctx } = runContext(project)
    const result = await driverFor(g, project).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)
    expect(result.importedFrom.rows).toBe(38)
    expect(result.importedFrom.users).toBe(2)
    expect(result.importedFrom.files).toBe(0)
    expect(result.warnings).toContain('Files stopped at 0 of 2: Backenly could not store the files: STORAGE_SECRET is not set')
  })

  it('stops with ImportAborted when the person cancels', async () => {
    const g = demoProject()
    const project = new MemoryProject()
    const controller = new AbortController()
    const { ctx } = runContext(project, {
      signal: controller.signal,
      progress: (p) => {
        if (p.phase === 'rows') controller.abort(new ImportAborted('canceled'))
      },
    })
    const err = await driverFor(g, project).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(ImportAborted)
    expect(err.reason).toBe('canceled')
    expect(project.users).toHaveLength(0)
    expect(project.closed).toBe(true)
  })

  it('plans a collection found while moving from what it holds once that passes the byte budget, instead of holding on', async () => {
    const g = demoProject()
    // Under the last log only, so the preview never meets them: 200 entries of 1 KB, the later half with a field the first half lacks.
    for (let i = 0; i < 200; i++) {
      g.put(`logs/l29/entries/e${String(i).padStart(3, '0')}`, {
        text: { stringValue: 'y'.repeat(1000) },
        ...(i >= 100 ? { late: { stringValue: 'arrived late' } } : {}),
      })
    }
    const project = new MemoryProject()
    const { ctx } = runContext(project, { include: { users: false, files: false } })
    await driverFor(g, project, { heldBytes: 50_000 }).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)
    // Planned from about the first 50 KB of entries, so `late` made no column: its values are kept in extra_fields.
    expect(project.extraAdded).toContain('logs_entries')
    const entries = project.tables.get('logs_entries')!
    expect(entries.plan.createColumns.map((c) => c.name)).not.toContain('late')
    expect(entries.rows).toHaveLength(201)
    expect(entries.rows.filter((r) => typeof r.extra_fields === 'string' && JSON.parse(r.extra_fields).late === 'arrived late')).toHaveLength(100)
  })

  it("stops at the plan's room when the documents outgrow what the sample said", async () => {
    // The sample (the first five documents) is small, so the estimate passes the plan's limit; the rest are not.
    const g = new FakeGoogle(SA)
    for (let i = 0; i < 5; i++) g.put(`blobs/a${i}`, { n: { integerValue: String(i) } })
    for (let i = 0; i < 700; i++) g.put(`blobs/b${String(i).padStart(3, '0')}`, { body: { stringValue: 'x'.repeat(1000) } })
    const project = new MemoryProject()
    const limits = { maxRowBytes: 500_000, maxFileBytes: null, planName: 'Free', planRowBytes: 600_000 }
    const { ctx } = runContext(project, { include: { users: false, files: false }, limits })
    const err = await driverFor(g, project, { sampleSize: 5 }).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toMatch(
      /^Backenly stopped the import after \d+ KB of rows: the organization has 488 KB left of the 586 KB of database storage on Free\. Free some space or upgrade the organization, then import again\.$/,
    )
    const held = project.tables.get('blobs')!.rows.length
    expect(held).toBeGreaterThan(0)
    expect(held).toBeLessThan(705)
    expect(await project.measureRows()).toBeLessThanOrEqual(limits.maxRowBytes)
    expect(project.closed).toBe(true)
  })

  it('refuses a project with more collections than one import makes tables, before reading any of them', async () => {
    const g = new FakeGoogle(SA)
    for (let i = 0; i <= 1000; i++) g.put(`c${String(i).padStart(4, '0')}/d`, { n: { integerValue: '1' } })
    const driver = driverFor(g, new MemoryProject())
    const said = 'This source has more than 1,000 tables; one import moves up to 1,000. Contact us to move a larger database.'
    const err = await driver.check!({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx()).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toBe(said)
    // Collection ids only: nothing was sampled or counted.
    expect(g.calls.some((c) => /:runAggregationQuery$/.test(c.url) || /\/documents\/c\d{4}/.test(c.url))).toBe(false)
    const preview = await driver.inspect({ source: 'firebase', serviceAccountJson: SA.json }, inspectCtx()).catch((e) => e)
    expect(preview).toBeInstanceOf(ImportInputError)
    expect(preview.message).toBe(said)
  })

  it("fails in plain words when the key can't read Firestore", async () => {
    const g = demoProject()
    g.deny.add('firestore')
    const project = new MemoryProject()
    const { ctx } = runContext(project)
    await expect(driverFor(g, project).run({ source: 'firebase', serviceAccountJson: SA.json }, ctx)).rejects.toThrow(
      "This key can't read Firestore. Give the service account the Cloud Datastore Viewer role.",
    )
    expect(project.created).toEqual([])
  })
})

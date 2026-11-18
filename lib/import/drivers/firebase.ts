/**
 * The Firebase import driver: a Firebase project (Firestore, Firebase
 * Authentication users, Cloud Storage files) into a new Backenly project.
 *
 * It plugs into the import runner (lib/import/driver.ts): `inspect` reads what
 * would move and returns the Review step's preview; `run` copies it into the
 * project the runner created. Both only read Firebase, through Google's REST
 * APIs, with a token minted from the service account key the person pasted
 * (lib/import/google-auth.ts). The key lives in memory for the call and goes
 * nowhere else.
 *
 * What moves, and how (spec: Onboarding + import, 2026-11-16):
 *   Firestore  each collection a table, each subcollection `{parent}_{child}`
 *              with parent_id; types from up to 1,000 documents; ids kept in
 *              firebase_id (./firebase-schema.ts). Copied in batches, counted
 *              again at the end.
 *   Users      with their Firebase password hashes, which sign-in accepts once
 *              and replaces with bcrypt (lib/auth/end-user-password.ts), and
 *              their provider identities (./firebase-users.ts).
 *   Files      the default bucket into a private bucket `files`, paths kept
 *              (./firebase-storage.ts).
 *   Rules      never translated: every table waits, closed, for the person to
 *              approve a rule; each is listed with Firestore's own rule text
 *              when it can be read (./firebase-rules.ts).
 */

import { randomBytes } from 'crypto'
import type { ImportPreview, ImportPreviewBucket, ImportPreviewTable, ImportProgressTable } from '../contract'
import { ImportInputError, type DriverContext, type ImportDriver, type ImportLimits, type RunContext, type RunResult } from '../driver'
import { GoogleTokenSource, parseServiceAccount, type ServiceAccount } from '../google-auth'
import { GoogleApiError, GoogleClient, GoogleNetworkError, type GoogleTransport } from '../google-http'
import { DANGEROUS_EXTENSIONS, MAX_BUFFERED_UPLOAD_BYTES, uploadExtension } from '@/lib/storage/upload-policy'
import { FirestoreReader, discoverCollections, mapLimit, type DiscoveredCollection } from './firebase-firestore'
import {
  CollectionProfile,
  TableNames,
  convertDocument,
  documentBytes,
  locate,
  newConvertStats,
  planTable,
  writeColumns,
  writeRow,
  type ConvertedRow,
  type DocLocation,
  type FsDocument,
  type TablePlan,
} from './firebase-schema'
import { UserTally, countUsers, listUsers, listUsersPage, mapFirebaseUser, readHashSettings, type ImportedUser } from './firebase-users'
import { downloadObject, findDefaultBucket, listObjects, listObjectsPage, mimeTypeFor, readProjectInfo } from './firebase-storage'
import { pendingRules, readFirestoreRules } from './firebase-rules'
import { backenlyDestination, type FirebaseDestination } from './firebase-destination'
import { batchCost, throwIfAborted } from '../pg-engine'
import { MAX_IMPORT_TABLES, MAX_IMPORT_USERS, RowRoom, fileRefusal, rowRefusal, tableCountRefusal, userCountRefusal } from '../limits'
import { ByteBudget, FILE_BYTES_IN_FLIGHT, waitForHeadroom } from '../pressure'

export interface FirebaseLimits {
  /** Documents read per collection for column types. */
  sampleSize: number
  /** One file larger than this is not moved. (Sizes over the plan's storage: ctx.limits, lib/import/limits.ts.) */
  maxFileBytes: number
  /** Pages of 1,000 users the preview reads before it only counts. */
  previewUserPages: number
  /** Pages of 1,000 files the preview reads before it stops. */
  previewFilePages: number
  /**
   * Bytes of documents held, over every collection the preview never met,
   * while each waits for `sampleSize` documents to plan its table from. Past
   * it, each is planned from what it holds: a document is up to 1 MiB, so
   * waiting for 1,000 of each could hold gigabytes in the web process.
   */
  heldBytes: number
}

export const DEFAULT_FIREBASE_LIMITS: FirebaseLimits = {
  sampleSize: 1000,
  maxFileBytes: Number(MAX_BUFFERED_UPLOAD_BYTES),
  previewUserPages: 10,
  previewFilePages: 10,
  heldBytes: 32 * 1024 * 1024,
}

export interface FirebaseDriverOptions {
  /** How bytes reach Google; recorded answers in tests. */
  transport?: GoogleTransport
  /** Where `run` writes; the real project unless a test hands in its own. */
  destination?: (ctx: RunContext) => FirebaseDestination
  limits?: Partial<FirebaseLimits>
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Always true of a Firebase move, said on the Review step. */
export const FIREBASE_NEVER_MOVES = [
  'Cloud Functions don\'t move. Rebuild what they did as Backenly functions.',
  'Firestore security rules don\'t move as code. Each table waits for a rule you approve; until then only your server key can read or write it.',
  'Firebase Extensions don\'t move.',
  'Realtime Database data doesn\'t move; only Firestore does.',
]

const n = (x: number) => x.toLocaleString('en-US')

function mb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** About how many bytes of documents the collections hold: each sample's average size times its count. */
export function estimateBytes(found: DiscoveredCollection[]): number {
  let bytes = 0
  for (const c of found) {
    if (c.profile.docs === 0) continue
    bytes += (c.profile.bytes / c.profile.docs) * (c.count ?? c.profile.docs)
  }
  return Math.round(bytes)
}

/** The plan's refusal for this many bytes of documents (lib/import/limits.ts), or null. */
function sizeRefusal(bytes: number, planLimits: ImportLimits | undefined): string | null {
  return rowRefusal(bytes, planLimits)
}

/** Firestore that is not there (no database, API off, Datastore mode) is an empty source, said in words. */
function firestoreAbsence(err: unknown): string | null {
  if (!(err instanceof GoogleApiError)) return null
  if (err.serviceDisabled) return 'Firestore isn\'t turned on for this project, so there are no documents to move.'
  if (err.status === 404) return 'This project has no Firestore database, so there are no documents to move.'
  if (/datastore mode/i.test(err.googleMessage)) return 'This project\'s database is in Datastore mode, which Backenly can\'t move.'
  return null
}

const FIRESTORE_DENIED = 'This key can\'t read Firestore. Give the service account the Cloud Datastore Viewer role.'

/** The files phase ends here; what moved stays, and the import finishes with the reason. */
class FilesStopped extends Error {}

export function createFirebaseDriver(options: FirebaseDriverOptions = {}): ImportDriver<'firebase'> {
  const limits: FirebaseLimits = { ...DEFAULT_FIREBASE_LIMITS, ...(options.limits ?? {}) }

  function google(sa: ServiceAccount, signal?: AbortSignal) {
    const tokens = new GoogleTokenSource(sa, { transport: options.transport, now: options.now, signal, sleep: options.sleep })
    const client = new GoogleClient({ token: tokens.token, transport: options.transport, signal, sleep: options.sleep })
    return { tokens, client }
  }

  /** Discovery plus the plan every table gets; shared by the preview and the import. */
  function planCollections(found: DiscoveredCollection[]) {
    const names = new TableNames()
    names.assignAll(found.map((c) => c.pattern))
    const plans: TablePlan[] = []
    for (const pattern of TableNames.order(found.map((c) => c.pattern))) {
      const c = found.find((x) => x.pattern === pattern)!
      plans.push(planFor(names, pattern, c.profile, c.count))
    }
    return { names, plans }
  }

  function planFor(names: TableNames, pattern: string, profile: CollectionProfile, total: number | null): TablePlan {
    const parentPattern = pattern.includes('/*/') ? pattern.slice(0, pattern.lastIndexOf('/*/')) : null
    return planTable({
      pattern,
      name: names.nameFor(pattern),
      parentTable: parentPattern ? names.nameFor(parentPattern) : null,
      profile,
      total,
    })
  }

  // ── inspect ──────────────────────────────────────────────────────────────────

  async function previewFirestore(client: GoogleClient, projectId: string, signal: AbortSignal) {
    const reader = new FirestoreReader(client, projectId)
    let found: DiscoveredCollection[]
    try {
      found = await discoverCollections(reader, { sampleSize: limits.sampleSize, signal })
    } catch (err) {
      const absent = firestoreAbsence(err)
      if (absent) return { tables: [] as ImportPreviewTable[], plans: [] as TablePlan[], warnings: [absent], bytes: 0 }
      if (err instanceof GoogleApiError && err.permissionDenied) throw new ImportInputError(FIRESTORE_DENIED, 'serviceAccountJson')
      throw err
    }
    const { plans } = planCollections(found)
    const tables = plans.map((plan): ImportPreviewTable => {
      const c = found.find((x) => x.pattern === plan.pattern)!
      const notes = [...plan.notes]
      if (c.count === null) notes.unshift(`At least ${n(c.profile.docs)} documents. ${c.countNote ?? 'Counted while moving.'}`)
      return { sourceName: plan.sourceName, name: plan.name, rows: c.count ?? c.profile.docs, columns: plan.createColumns.length + 3, notes }
    })
    return { tables, plans, warnings: [] as string[], bytes: estimateBytes(found) }
  }

  async function previewUsers(client: GoogleClient, projectId: string): Promise<{ users: ImportPreview['users']; warnings: string[] }> {
    try {
      const hash = await readHashSettings(client, projectId)
      const tally = new UserTally()
      let token: string | undefined
      let pages = 0
      do {
        const page = await listUsersPage(client, projectId, token)
        for (const u of page.users) tally.add(u, mapFirebaseUser(u, hash.params))
        token = page.nextPageToken
        pages++
      } while (token && pages < limits.previewUserPages)
      const warnings = tally.warnings(hash.problem)
      let total = tally.total
      if (token) {
        const all = await countUsers(client, projectId)
        if (all !== null && all > total) {
          warnings.unshift(`The numbers below describe the first ${n(tally.total)} of ${n(all)} users; all of them move.`)
          total = all
        }
      }
      return {
        users: { total, withPassword: tally.withPassword, providerOnly: tally.providerOnly, skipped: tally.skipped },
        warnings,
      }
    } catch (err) {
      if (err instanceof GoogleApiError) {
        // Firebase Authentication never set up: no users, nothing to say.
        if (/CONFIGURATION_NOT_FOUND/i.test(err.googleMessage) || err.status === 404) {
          return { users: { total: 0, withPassword: 0, providerOnly: 0, skipped: 0 }, warnings: [] }
        }
        return { users: null, warnings: [`Users won't move: ${err.message}`] }
      }
      throw err
    }
  }

  async function previewFiles(client: GoogleClient, projectId: string, configBucket: string | null): Promise<{ buckets: ImportPreviewBucket[] | null; warnings: string[] }> {
    try {
      const found = await findDefaultBucket(client, projectId, configBucket)
      if (found.problem) return { buckets: null, warnings: [`Files won't move: ${found.problem}`] }
      if (!found.bucket) return { buckets: [], warnings: [] }
      let files = 0
      let bytes = 0
      const tooLarge: string[] = []
      const executable: string[] = []
      let token: string | undefined
      let pages = 0
      do {
        const page = await listObjectsPage(client, found.bucket, token)
        for (const o of page.objects) {
          files++
          bytes += o.size
          if (o.size > limits.maxFileBytes) tooLarge.push(`${o.name} (${mb(o.size)})`)
          else if (DANGEROUS_EXTENSIONS.includes(uploadExtension(o.name))) executable.push(o.name)
        }
        token = page.nextPageToken
        pages++
      } while (token && pages < limits.previewFilePages)
      const warnings: string[] = []
      if (token) warnings.push(`Counted the first ${n(files)} files; the rest are counted while moving.`)
      if (tooLarge.length) {
        warnings.push(`${n(tooLarge.length)} ${tooLarge.length === 1 ? 'file is' : 'files are'} over ${mb(limits.maxFileBytes)} and won't move: ${tooLarge.slice(0, 3).join(', ')}${tooLarge.length > 3 ? ` and ${n(tooLarge.length - 3)} more` : ''}.`)
      }
      if (executable.length) {
        warnings.push(`${n(executable.length)} executable ${executable.length === 1 ? 'file' : 'files'} won't move (Backenly doesn't store them): ${executable.slice(0, 3).join(', ')}${executable.length > 3 ? ` and ${n(executable.length - 3)} more` : ''}.`)
      }
      return { buckets: [{ sourceName: found.bucket, name: 'files', files, bytes, public: false }], warnings }
    } catch (err) {
      if (err instanceof GoogleApiError) return { buckets: null, warnings: [`Files won't move: ${err.message}`] }
      throw err
    }
  }

  async function inspect(connection: { serviceAccountJson: string }, ctx: DriverContext): Promise<ImportPreview> {
    const sa = parseServiceAccount(connection.serviceAccountJson)
    const { tokens, client } = google(sa, ctx.signal)
    // A key Google refuses is the person's to fix, under the field: find out first.
    await tokens.token('firestore')
    const project = await readProjectInfo(client, sa.projectId)

    const [fs, users, files, rulesSource] = await Promise.all([
      previewFirestore(client, sa.projectId, ctx.signal),
      previewUsers(client, sa.projectId),
      previewFiles(client, sa.projectId, project.storageBucket),
      readFirestoreRules(client, sa.projectId),
    ])

    const warnings = [...fs.warnings, ...users.warnings, ...files.warnings, ...FIREBASE_NEVER_MOVES]
    // Files over the plan's storage do not stop the import: they can be left out.
    const fileBytes = (files.buckets ?? []).reduce((sum, b) => sum + b.bytes, 0)
    const overFiles = fileRefusal(fileBytes, ctx.limits)
    if (overFiles) warnings.unshift(overFiles)
    let refusal: string | null = sizeRefusal(fs.bytes, ctx.limits)
    if (!refusal && fs.tables.length > MAX_IMPORT_TABLES) refusal = tableCountRefusal(fs.tables.length)
    const movingUsers = users.users ? users.users.total - users.users.skipped : 0
    if (!refusal && movingUsers > MAX_IMPORT_USERS) refusal = userCountRefusal(movingUsers)
    const empty =
      fs.tables.length === 0 &&
      users.users !== null && users.users.total === 0 &&
      files.buckets !== null && files.buckets.every((b) => b.files === 0)
    if (!refusal && empty) {
      refusal = 'There is nothing to move: this Firebase project has no Firestore documents, users or files.'
    }

    return {
      source: 'firebase',
      sourceLabel: project.displayName ?? sa.projectId,
      tables: fs.tables,
      users: users.users,
      buckets: files.buckets,
      rules: pendingRules(fs.plans.map((p) => ({ name: p.name, pattern: p.pattern })), rulesSource),
      warnings,
      refusal,
    }
  }

  /**
   * Fast and read-only, before the runner creates the project: the key works,
   * Firestore answers it, and the top-level collections (their counts and the
   * size of their first 100 documents) are not over the plan's limit.
   */
  async function check(connection: { serviceAccountJson: string }, ctx: DriverContext): Promise<void> {
    const sa = parseServiceAccount(connection.serviceAccountJson)
    const { tokens, client } = google(sa, ctx.signal)
    await tokens.token('firestore')
    const reader = new FirestoreReader(client, sa.projectId)
    let tops: string[]
    try {
      tops = await reader.listCollectionIds(null, MAX_IMPORT_TABLES)
    } catch (err) {
      if (firestoreAbsence(err)) return
      if (err instanceof GoogleApiError && err.permissionDenied) throw new ImportInputError(FIRESTORE_DENIED, 'serviceAccountJson')
      throw err
    }
    if (tops.length > MAX_IMPORT_TABLES) throw new ImportInputError(tableCountRefusal(null))
    const found = await mapLimit(tops, 4, async (id): Promise<DiscoveredCollection> => {
      const profile = new CollectionProfile()
      for (const d of await reader.sample(id, 100)) profile.add(d)
      const count = await reader.count(id).catch(() => null)
      return { pattern: id, profile, count, countNote: null }
    })
    const over = sizeRefusal(estimateBytes(found), ctx.limits)
    if (over) throw new ImportInputError(over)
  }

  // ── run ──────────────────────────────────────────────────────────────────────

  interface TableState {
    plan: TablePlan
    /** Documents read from Firestore for this table. */
    read: number
    copied: number
    /** Known total before copying, when counted. */
    known: number | null
    buffer: ConvertedRow[]
    orphans: number
    verified: boolean
  }

  async function moveFirestore(client: GoogleClient, projectId: string, ctx: RunContext, dest: FirebaseDestination, warnings: string[], room: RowRoom) {
    ctx.progress({ phase: 'tables' })
    const reader = new FirestoreReader(client, projectId)
    let found: DiscoveredCollection[]
    try {
      found = await discoverCollections(reader, { sampleSize: limits.sampleSize, signal: ctx.signal })
    } catch (err) {
      const absent = firestoreAbsence(err)
      if (absent) {
        warnings.push(absent)
        return { tables: 0, rows: 0 }
      }
      if (err instanceof GoogleApiError && err.permissionDenied) throw new Error(FIRESTORE_DENIED)
      throw err
    }

    // Over the plan's database storage, or over what one import moves: refused
    // before anything is written.
    const over = sizeRefusal(estimateBytes(found), ctx.limits)
    if (over) throw new ImportInputError(over)

    const { names, plans } = planCollections(found)
    const state = new Map<string, TableState>()
    const namespace = randomBytes(32)
    const stats = newConvertStats()
    const ledger = (s: TableState): ImportProgressTable => ({
      name: s.plan.name,
      sourceRows: Math.max(s.known ?? 0, s.read),
      copiedRows: s.copied,
      verified: s.verified,
    })

    const create = async (batch: Array<{ plan: TablePlan; known: number | null }>, title: string) => {
      throwIfAborted(ctx.signal)
      // Collections found while moving count too: past the limit, no more tables are made.
      if (state.size + batch.length > MAX_IMPORT_TABLES) throw new ImportInputError(tableCountRefusal(null))
      const unindexed = await dest.createTables(batch.map((b) => b.plan), title)
      for (const t of unindexed) {
        const p = batch.find((b) => b.plan.name === t)?.plan
        warnings.push(`${t}: firebase_id could not be made unique within each ${p?.parentTable ?? 'parent'} row; every row arrived.`)
      }
      const made = batch.map(({ plan, known }) => {
        const s: TableState = { plan, read: 0, copied: 0, known, buffer: [], orphans: 0, verified: false }
        state.set(plan.pattern, s)
        return s
      })
      ctx.progress({ tables: made.map(ledger) })
      return made
    }

    await create(
      plans.map((plan) => ({ plan, known: found.find((c) => c.pattern === plan.pattern)!.count })),
      `Move in from Firebase: ${plans.length} ${plans.length === 1 ? 'table' : 'tables'}`,
    )

    const flush = async (s: TableState) => {
      if (s.buffer.length === 0) return
      if (!s.plan.extraColumn && s.buffer.some((r) => r.extra !== null)) {
        await dest.addExtraColumn(s.plan.name)
        s.plan.extraColumn = true
      }
      const rows = s.buffer.map((r) => writeRow(s.plan, r))
      s.buffer = []
      // The estimate from a sample passed the plan's limit; what arrives is counted against its room.
      await room.take(batchCost(rows))
      s.copied += await dest.insertRows(s.plan.name, writeColumns(s.plan), rows)
    }

    const take = (s: TableState, doc: FsDocument, loc: DocLocation) => {
      s.read++
      s.buffer.push(convertDocument(doc, loc, s.plan, { namespace, root: reader.root, stats }))
    }

    // Collections the preview never met, held until enough documents show their
    // shape, or until all that is held passes limits.heldBytes: then each is
    // planned from what it holds, and later documents that do not fit its
    // columns keep their fields in extra_fields, as for any table.
    const pending = new Map<string, Array<{ doc: FsDocument; loc: DocLocation }>>()
    const pendingBytes = new Map<string, number>()
    let heldBytes = 0
    const materialize = async (pattern: string) => {
      const held = pending.get(pattern) ?? []
      pending.delete(pattern)
      heldBytes -= pendingBytes.get(pattern) ?? 0
      pendingBytes.delete(pattern)
      const profile = new CollectionProfile()
      for (const h of held) profile.add(h.doc)
      const plan = planFor(names, pattern, profile, null)
      const [s] = await create([{ plan, known: null }], `Move in from Firebase: ${plan.name}`)
      for (const h of held) take(s, h.doc, h.loc)
      await flush(s)
    }

    ctx.progress({ phase: 'rows' })
    const tops = found.filter((c) => !c.pattern.includes('/*/')).map((c) => c.pattern)
    const readPerTop = new Map<string, number>()
    for (const top of tops) {
      // Documents arrive in name order, a document before everything under it,
      // so the open ancestors say whether a child's parent document exists.
      const open: string[] = []
      for await (const page of reader.walk(top)) {
        throwIfAborted(ctx.signal)
        await waitForHeadroom(ctx.signal)
        for (const doc of page) {
          const loc = locate(doc.name, reader.root)
          if (!loc) continue
          readPerTop.set(top, (readPerTop.get(top) ?? 0) + (loc.parentPath ? 0 : 1))
          let orphan = false
          if (!reader.usedFallback) {
            while (open.length && !loc.path.startsWith(`${open[open.length - 1]}/`)) open.pop()
            orphan = !!loc.parentPath && open[open.length - 1] !== loc.parentPath
            open.push(loc.path)
          }
          const s = state.get(loc.pattern)
          if (!s) {
            const held = pending.get(loc.pattern) ?? []
            held.push({ doc, loc })
            pending.set(loc.pattern, held)
            const size = documentBytes(doc)
            pendingBytes.set(loc.pattern, (pendingBytes.get(loc.pattern) ?? 0) + size)
            heldBytes += size
            if (held.length >= limits.sampleSize) await materialize(loc.pattern)
            else if (heldBytes > limits.heldBytes) for (const pattern of TableNames.order(pending.keys())) await materialize(pattern)
            continue
          }
          if (orphan) s.orphans++
          take(s, doc, loc)
        }
        for (const s of state.values()) await flush(s)
        ctx.progress({ tables: [...state.values()].map(ledger) })
      }
      // Everything under this collection is read: what was held gets its table.
      for (const pattern of TableNames.order(pending.keys())) await materialize(pattern)
    }
    for (const s of state.values()) await flush(s)
    if (reader.usedFallback) warnings.push('This database could not be listed in one pass, so each document\'s subcollections were looked up one by one.')

    // Every table counted again in Backenly.
    for (const s of state.values()) {
      throwIfAborted(ctx.signal)
      const arrived = await dest.countRows(s.plan.name)
      s.verified = arrived === s.read
      if (!s.verified) warnings.push(`${s.plan.name}: ${n(arrived)} rows arrived for ${n(s.read)} documents read.`)
      if (s.orphans) {
        warnings.push(`${s.plan.name}: ${n(s.orphans)} ${s.orphans === 1 ? 'row belongs' : 'rows belong'} to ${s.plan.parentTable} documents deleted in Firebase; parent_id points to no row.`)
      }
    }
    ctx.progress({ tables: [...state.values()].map(ledger) })

    if (stats.nulRemoved) warnings.push(`${n(stats.nulRemoved)} text ${stats.nulRemoved === 1 ? 'value' : 'values'} contained a NUL character, which PostgreSQL can't store; it was removed.`)
    const withExtra = [...state.values()].filter((s) => s.plan.extraColumn).map((s) => s.plan.name)
    if (stats.extraValues && withExtra.length) {
      warnings.push(`${n(stats.extraValues)} ${stats.extraValues === 1 ? 'value' : 'values'} didn't fit ${stats.extraValues === 1 ? 'its' : 'their'} column and ${stats.extraValues === 1 ? 'is' : 'are'} kept in extra_fields (${withExtra.slice(0, 3).join(', ')}${withExtra.length > 3 ? '…' : ''}).`)
    }

    // Did Firestore change while it was read?
    for (const top of tops) {
      const table = state.get(top)
      if (!table) continue
      try {
        const now = await reader.count(top)
        const read = readPerTop.get(top) ?? 0
        if (now !== read) warnings.push(`${top} changed in Firebase while moving: it has ${n(now)} documents now, ${n(read)} were moved.`)
      } catch {
        /* the copy is verified on Backenly's side; a recount that fails says nothing new */
      }
    }

    let rows = 0
    for (const s of state.values()) rows += s.copied
    return { tables: state.size, rows }
  }

  async function moveUsers(
    client: GoogleClient,
    projectId: string,
    ctx: RunContext,
    dest: FirebaseDestination,
    warnings: string[],
    room: RowRoom,
  ): Promise<number | undefined> {
    try {
      const hash = await readHashSettings(client, projectId)
      const estimate = (await countUsers(client, projectId)) ?? 0
      ctx.progress({ phase: 'users', users: { total: estimate, copied: 0 } })
      await dest.prepareUsers()
      const tally = new UserTally()
      let imported = 0
      let copied = 0
      for await (const page of listUsers(client, projectId)) {
        throwIfAborted(ctx.signal)
        await waitForHeadroom(ctx.signal)
        const rows: ImportedUser[] = []
        for (const u of page) {
          const outcome = mapFirebaseUser(u, hash.params)
          tally.add(u, outcome)
          if (outcome.kind === 'imported') rows.push(outcome.user)
        }
        imported += rows.length
        if (imported > MAX_IMPORT_USERS) throw new ImportInputError(userCountRefusal(null))
        // Users are rows of the project's database too: the same room as the tables'.
        await room.take(batchCost(rows.map((u) => Object.values(u))))
        copied += await dest.insertUsers(rows)
        ctx.progress({ users: { total: Math.max(estimate, tally.total), copied } })
      }
      warnings.push(...tally.warnings(hash.problem))
      if (copied < imported) {
        const dup = imported - copied
        warnings.push(`${n(dup)} ${dup === 1 ? 'user shares' : 'users share'} an email address with another user; only the first of each moved.`)
      }
      const arrived = await dest.countImportedUsers()
      if (arrived !== copied) warnings.push(`Users: ${n(arrived)} arrived for ${n(copied)} written.`)
      return copied
    } catch (err) {
      if (err instanceof GoogleApiError) {
        if (/CONFIGURATION_NOT_FOUND/i.test(err.googleMessage) || err.status === 404) return 0
        warnings.push(`Users weren't moved: ${err.message}`)
        return undefined
      }
      if (err instanceof GoogleNetworkError) {
        warnings.push(`Users stopped part-way: ${err.message}`)
        return undefined
      }
      throw err
    }
  }

  async function moveFiles(client: GoogleClient, projectId: string, ctx: RunContext, dest: FirebaseDestination, warnings: string[]): Promise<number | undefined> {
    const progress = { total: 0, copied: 0, bytes: 0, copiedBytes: 0 }
    const tooLarge: string[] = []
    const refused: string[] = []
    let stopped: string | null = null
    const list = (items: string[]) => `${items.slice(0, 3).join(', ')}${items.length > 3 ? ` and ${n(items.length - 3)} more` : ''}`
    const say = () => {
      if (stopped) warnings.push(`Files stopped at ${n(progress.copied)} of ${n(progress.total)}: ${stopped}`)
      if (tooLarge.length) warnings.push(`${n(tooLarge.length)} ${tooLarge.length === 1 ? 'file is' : 'files are'} over ${mb(limits.maxFileBytes)} and didn't move: ${list(tooLarge)}.`)
      if (refused.length) warnings.push(`${n(refused.length)} ${refused.length === 1 ? 'file' : 'files'} didn't move: ${list(refused)}.`)
    }

    try {
      const project = await readProjectInfo(client, projectId)
      const found = await findDefaultBucket(client, projectId, project.storageBucket)
      if (found.problem) {
        warnings.push(`Files weren't moved: ${found.problem}`)
        return undefined
      }
      if (!found.bucket) return 0
      const bucket = found.bucket
      ctx.progress({ phase: 'files', files: { ...progress } })
      const bucketId = await dest.prepareFilesBucket(limits.maxFileBytes)
      // Four downloads at a time, holding at most FILE_BYTES_IN_FLIGHT between them (lib/import/pressure.ts).
      const fileBytes = new ByteBudget(FILE_BYTES_IN_FLIGHT)

      for await (const page of listObjects(client, bucket)) {
        throwIfAborted(ctx.signal)
        for (const o of page) {
          progress.total++
          progress.bytes += o.size
        }
        ctx.progress({ files: { ...progress } })
        await mapLimit(page, 4, async (o) => {
          if (stopped) return
          if (o.size > limits.maxFileBytes) {
            tooLarge.push(`${o.name} (${mb(o.size)})`)
            return
          }
          if (DANGEROUS_EXTENSIONS.includes(uploadExtension(o.name))) {
            refused.push(`${o.name} (an executable file)`)
            return
          }
          await waitForHeadroom(ctx.signal)
          const releaseBytes = await fileBytes.acquire(o.size)
          let buffer: Buffer
          try {
            buffer = await downloadObject(client, bucket, o.name, limits.maxFileBytes)
          } catch (err) {
            releaseBytes()
            // One file gone or refused since it was listed; the rest still move.
            if (err instanceof GoogleApiError) {
              refused.push(`${o.name} (${err.message})`)
              return
            }
            throw err
          }
          let outcome: Awaited<ReturnType<FirebaseDestination['uploadFile']>>
          try {
            outcome = await dest.uploadFile(bucketId, { name: o.name, buffer, mimeType: mimeTypeFor(o.name, o.contentType) })
          } catch (err) {
            releaseBytes()
            // Backenly's own storage failed (not a refusal of this file): no later file would fare better.
            throw new FilesStopped(`Backenly could not store the files: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'storage failed'}`)
          }
          releaseBytes()
          if (outcome.ok) {
            progress.copied++
            progress.copiedBytes += buffer.length
          } else if (outcome.stop) {
            stopped = outcome.message
          } else {
            refused.push(`${o.name} (${outcome.message})`)
          }
        })
        ctx.progress({ files: { ...progress } })
        if (stopped) break
      }
    } catch (err) {
      // Tables and users are in; a Storage failure ends only the files, said with what did move.
      if (err instanceof GoogleApiError || err instanceof GoogleNetworkError || err instanceof FilesStopped) {
        stopped = err.message
        say()
        return progress.copied
      }
      throw err
    }
    say()
    return progress.copied
  }

  async function run(connection: { serviceAccountJson: string }, ctx: RunContext): Promise<RunResult> {
    const sa = parseServiceAccount(connection.serviceAccountJson)
    const { client } = google(sa, ctx.signal)
    const dest = (options.destination ?? ((c: RunContext) => backenlyDestination({ projectId: c.projectId, userId: c.userId })))(ctx)
    const warnings: string[] = []
    // Documents and users are counted against the plan's room as they are written (lib/import/limits.ts).
    const room = new RowRoom(ctx.limits, () => dest.measureRows())
    try {
      const fs = await moveFirestore(client, sa.projectId, ctx, dest, warnings, room)
      if (fs.tables > 0) {
        // Nothing is queued to approve (a Firestore rule has no exact translation); the tables wait closed.
        warnings.push(
          `${fs.tables === 1 ? 'The moved table answers' : `All ${n(fs.tables)} moved tables answer`} only your server key until you set ${fs.tables === 1 ? 'its' : 'their'} access rules: Firestore rules aren't translated.`,
        )
      }
      const users = ctx.include.users ? await moveUsers(client, sa.projectId, ctx, dest, warnings, room) : undefined
      const files = ctx.include.files ? await moveFiles(client, sa.projectId, ctx, dest, warnings) : undefined
      ctx.progress({ phase: 'verifying', rulesPending: fs.tables })
      return {
        importedFrom: {
          source: 'firebase',
          at: new Date(options.now ? options.now() : Date.now()).toISOString(),
          tables: fs.tables,
          rows: fs.rows,
          ...(users !== undefined ? { users } : {}),
          ...(files !== undefined ? { files } : {}),
          rulesPending: fs.tables,
        },
        warnings,
      }
    } finally {
      await dest.close()
    }
  }

  return { source: 'firebase', inspect, check, run }
}

/** The driver the import runner uses. */
export const firebaseDriver: ImportDriver<'firebase'> = createFirebaseDriver()

/**
 * Egress from access logs: bytes that left AWS without passing through a
 * Backenly process, or measured on the wire rather than in the app.
 *
 *   alb         Load balancer access logs. `sent_bytes` is what the balancer
 *               sent the client: after compression, headers included. Cloud
 *               bills app-path egress from this instead of `app`
 *               (USAGE_EGRESS_SOURCES, lib/usage/close.ts).
 *   s3          S3 server access logs. Only presigned downloads
 *               (authentication type QueryString, operation REST.GET.OBJECT):
 *               a browser fetching a signed URL straight from the bucket. The
 *               app's own SDK reads (AuthHeader) are served on by the app, whose
 *               bytes are already counted.
 *   cloudfront  CloudFront standard logs. `sc-bytes` sent to viewers.
 *
 * Attribution is by path or object key:
 *   /api/v1/{project}/…, /api/v2/{project}/…     that project
 *   /api/storage/files/{file}/download          the file's project (looked up)
 *   {project}/{bucket}/…, projects/{project}/…   object keys, either layout
 * A line that attributes to no project (the dashboard, the marketing site, an
 * unknown key) is not tenant egress and is skipped.
 *
 * Exactly once: each log object is applied as ONE ledger batch whose id is its
 * S3 URI (lib/usage/ledger.ts applyUsageBatch), so listing a bucket again,
 * or two processes ingesting at once, never counts a log twice.
 *
 * Known limit: the behavioral verifier reaches the API through the public URL,
 * so its (small) responses appear in load balancer logs and cannot be told
 * apart there. Excluding traffic by something a client can set, such as its
 * user agent, would let any client opt out of egress billing, so it is not done.
 */

import { gunzipSync } from 'zlib'
import { prisma } from '@/lib/db/prisma'
import { applyUsageBatch, type LedgerEntry } from '@/lib/usage/ledger'
import type { UsageSource } from '@/lib/usage/axes'

export type LogKind = 'alb' | 's3' | 'cloudfront'

export interface LogSource {
  kind: LogKind
  bucket: string
  prefix: string
}

export interface ParsedHit {
  day: string // YYYY-MM-DD UTC
  bytes: number
  projectId?: string
  fileId?: string
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const API_PATH = new RegExp(`^/api/v[12]/(${UUID})(?:/|$|\\?)`, 'i')
const DOWNLOAD_PATH = new RegExp(`^/api/storage/files/(${UUID})/download(?:$|\\?)`, 'i')
const KEY_LAYOUT = new RegExp(`^(?:projects/)?(${UUID})/`, 'i')

/** Split a log line on spaces, keeping "quoted" and [bracketed] fields whole. */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === ' ') {
      i++
      continue
    }
    if (ch === '"' || ch === '[') {
      const close = ch === '"' ? '"' : ']'
      let j = i + 1
      while (j < line.length && line[j] !== close) j++
      out.push(line.slice(i + 1, j))
      i = j + 1
      continue
    }
    let j = i
    while (j < line.length && line[j] !== ' ') j++
    out.push(line.slice(i, j))
    i = j
  }
  return out
}

function attributePath(path: string): Pick<ParsedHit, 'projectId' | 'fileId'> | null {
  const api = API_PATH.exec(path)
  if (api) return { projectId: api[1].toLowerCase() }
  const dl = DOWNLOAD_PATH.exec(path)
  if (dl) return { fileId: dl[1].toLowerCase() }
  return null
}

function attributeKey(key: string): Pick<ParsedHit, 'projectId'> | null {
  let k = key
  try {
    k = decodeURIComponent(key)
  } catch {
    /* keep the raw key */
  }
  k = k.replace(/^\/+/, '')
  const m = KEY_LAYOUT.exec(k)
  return m ? { projectId: m[1].toLowerCase() } : null
}

/** One ALB access log line. */
export function parseAlbLine(line: string): ParsedHit | null {
  const f = tokenize(line)
  if (f.length < 13) return null
  const time = f[1]
  const sent = Number(f[11])
  const request = f[12] // "GET https://host:443/path?q HTTP/1.1"
  if (!/^\d{4}-\d{2}-\d{2}T/.test(time) || !Number.isFinite(sent) || sent <= 0) return null
  const url = request.split(' ')[1]
  if (!url) return null
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  const who = attributePath(path)
  return who ? { day: time.slice(0, 10), bytes: sent, ...who } : null
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/** One S3 server access log line. Only presigned object downloads count. */
export function parseS3Line(line: string): ParsedHit | null {
  const f = tokenize(line)
  if (f.length < 12) return null
  const time = f[2] // 06/Feb/2019:00:00:38 +0000
  const operation = f[6]
  const key = f[7]
  const bytes = Number(f[11])
  const auth = f[21] // authentication_type (field 22 of the documented format)
  if (operation !== 'REST.GET.OBJECT' || auth !== 'QueryString') return null
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  const t = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):/.exec(time)
  if (!t || !MONTHS[t[2]]) return null
  const who = attributeKey(key)
  return who ? { day: `${t[3]}-${MONTHS[t[2]]}-${t[1]}`, bytes, ...who } : null
}

/** CloudFront standard (W3C) logs: fields named by the #Fields header. */
export function parseCloudFront(text: string): ParsedHit[] {
  const out: ParsedHit[] = []
  let fields: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#Fields:')) {
      fields = line.slice('#Fields:'.length).trim().split(/\s+/)
      continue
    }
    if (!line || line.startsWith('#') || fields.length === 0) continue
    const v = line.split('\t')
    const at = (name: string) => v[fields.indexOf(name)]
    const date = at('date')
    const bytes = Number(at('sc-bytes'))
    const stem = at('cs-uri-stem')
    if (!date || !stem || !Number.isFinite(bytes) || bytes <= 0) continue
    const who = attributeKey(stem) ?? attributePath(stem)
    if (who) out.push({ day: date, bytes, ...who })
  }
  return out
}

export function parseLogObject(kind: LogKind, body: Buffer, key: string): ParsedHit[] {
  const text = (key.endsWith('.gz') ? gunzipSync(body) : body).toString('utf8')
  if (kind === 'cloudfront') return parseCloudFront(text)
  const parse = kind === 'alb' ? parseAlbLine : parseS3Line
  const out: ParsedHit[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const hit = parse(line)
    if (hit) out.push(hit)
  }
  return out
}

/** Resolve download file ids to their projects in one query. */
async function projectsForFiles(fileIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (fileIds.length === 0) return map
  const rows = await prisma.storageFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, projectId: true } })
  for (const r of rows) map.set(r.id, r.projectId)
  return map
}

/** Aggregate one object's hits into ledger entries (project, day). */
export async function entriesFor(kind: LogKind, hits: ParsedHit[]): Promise<LedgerEntry[]> {
  const files = await projectsForFiles(Array.from(new Set(hits.filter((h) => h.fileId).map((h) => h.fileId!))))
  const sums = new Map<string, LedgerEntry>()
  for (const h of hits) {
    const projectId = h.projectId ?? (h.fileId ? files.get(h.fileId) : undefined)
    if (!projectId) continue
    const k = `${projectId}|${h.day}`
    const e = sums.get(k)
    if (e) e.quantity += BigInt(h.bytes)
    else sums.set(k, { projectId, axis: 'egress_bytes', day: h.day, source: kind as UsageSource, quantity: BigInt(h.bytes), billingAccountId: null })
  }
  return Array.from(sums.values())
}

// ── Running an ingest ────────────────────────────────────────────────────────

export interface LogObjectStore {
  list(bucket: string, prefix: string): Promise<Array<{ key: string }>>
  get(bucket: string, key: string): Promise<Buffer>
}

/** USAGE_LOG_SOURCES="alb=s3://bucket/prefix,s3=s3://bucket/prefix,cloudfront=s3://bucket/prefix" */
export function logSourcesFromEnv(env: NodeJS.ProcessEnv = process.env): LogSource[] {
  const raw = env.USAGE_LOG_SOURCES?.trim()
  if (!raw) return []
  const out: LogSource[] = []
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(alb|s3|cloudfront)=s3:\/\/([^/]+)\/?(.*)$/.exec(part)
    if (!m) throw new Error(`USAGE_LOG_SOURCES entry is not kind=s3://bucket/prefix: "${part}"`)
    out.push({ kind: m[1] as LogKind, bucket: m[2], prefix: m[3] })
  }
  return out
}

export interface IngestSummary {
  objects: number
  alreadyApplied: number
  entries: number
}

/**
 * Ingest every not-yet-applied log object under each source. Idempotent: an
 * object's ledger batch id is its URI, checked before download and enforced by
 * applyUsageBatch.
 */
export async function ingestLogs(sources: LogSource[], store: LogObjectStore): Promise<IngestSummary> {
  const summary: IngestSummary = { objects: 0, alreadyApplied: 0, entries: 0 }
  for (const src of sources) {
    const objects = await store.list(src.bucket, src.prefix)
    const ids = objects.map((o) => `log:s3://${src.bucket}/${o.key}`)
    const done = new Set(
      ids.length === 0
        ? []
        : (
            await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "usage_applied_batches" WHERE "id" = ANY(${ids}::text[])`
          ).map((r) => r.id),
    )
    for (const obj of objects) {
      const id = `log:s3://${src.bucket}/${obj.key}`
      if (done.has(id)) {
        summary.alreadyApplied++
        continue
      }
      const hits = parseLogObject(src.kind, await store.get(src.bucket, obj.key), obj.key)
      const entries = await entriesFor(src.kind, hits)
      if (entries.length === 0) {
        // Still mark it, so an object with no tenant traffic is not re-read forever.
        await prisma.$executeRaw`
          INSERT INTO "usage_applied_batches" ("id", "kind", "entries") VALUES (${id}, 'log', 0)
          ON CONFLICT ("id") DO NOTHING`
      } else {
        const r = await applyUsageBatch({ id, kind: 'log', entries })
        if (!r.applied) {
          summary.alreadyApplied++
          continue
        }
        summary.entries += r.rows
      }
      summary.objects++
    }
  }
  return summary
}

/** The AWS SDK store. Credentials come from the environment (the ECS task role). */
export async function s3LogStore(): Promise<LogObjectStore> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({})
  return {
    async list(bucket, prefix) {
      const out: Array<{ key: string }> = []
      let token: string | undefined
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token }))
        for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key })
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return out
    },
    async get(bucket, key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const bytes = await res.Body!.transformToByteArray()
      return Buffer.from(bytes)
    },
  }
}

/** The scheduled job: a no-op until USAGE_LOG_SOURCES is configured. */
export async function ingestConfiguredLogs(): Promise<IngestSummary | null> {
  const sources = logSourcesFromEnv()
  if (sources.length === 0) return null
  return ingestLogs(sources, await s3LogStore())
}

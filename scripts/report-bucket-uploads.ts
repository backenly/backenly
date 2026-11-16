/**
 * report-bucket-uploads.ts — which buckets take uploads from any signed-in user.
 *
 * Read-only. A bucket says who may upload into it (lib/storage/upload-access.ts):
 * "signed_in" (any signed-in end user of the project) or "server_only" (a
 * service-role key, and the project's team from the console). Every bucket that
 * existed before buckets said this was given "signed_in", so it kept taking the
 * uploads it took; for some (a shop's product photos) the owner may want only
 * their server to upload. Changing that for them could break an app whose users
 * upload there, so this lists them, with who has uploaded into each, for the
 * owners to be told and to choose.
 *
 *   npx tsx scripts/report-bucket-uploads.ts                  # every project
 *   npx tsx scripts/report-bucket-uploads.ts --project <uuid>
 *   npx tsx scripts/report-bucket-uploads.ts --created-since <ISO time>
 *
 * --created-since lists every bucket made since then, whichever rule it has:
 * the buckets made since a release, say, for their owners to be told who may
 * upload into them.
 *
 * Prints one line per bucket: project, owner's email, bucket, uploads, read
 * policy, created, then its files by who sent them: end users, servers and the
 * console, the public key alone, and not recorded.
 */
import { prisma } from '@/lib/db'

function arg(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at > -1 ? process.argv[at + 1] ?? null : null
}

const ONLY = arg('--project')
const SINCE_RAW = arg('--created-since')
const SINCE = SINCE_RAW ? new Date(SINCE_RAW) : null

interface Row {
  projectId: string
  email: string | null
  bucket: string
  uploads: string
  accessPolicy: string
  createdAt: Date
  endUser: number
  serverOrConsole: number
  anonymous: number
  unrecorded: number
}

async function main(): Promise<void> {
  if (SINCE && Number.isNaN(SINCE.getTime())) throw new Error(`--created-since is not a time: ${SINCE_RAW}`)
  // Who sent each live file (lib/storage/uploader.ts): uploadedBy is the end
  // user; metadata.uploader.kind says the rest, where it was recorded.
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT b."projectId", u.email, b.name AS bucket, b."uploadPolicy" AS uploads, b."accessPolicy", b."createdAt",
            count(f.id) FILTER (WHERE f."uploadedBy" IS NOT NULL OR f.metadata->'uploader'->>'kind' = 'end_user')::int AS "endUser",
            count(f.id) FILTER (WHERE f."uploadedBy" IS NULL AND f.metadata->'uploader'->>'kind' IN ('server_key', 'console'))::int AS "serverOrConsole",
            count(f.id) FILTER (WHERE f."uploadedBy" IS NULL AND f.metadata->'uploader'->>'kind' = 'anonymous')::int AS anonymous,
            count(f.id) FILTER (WHERE f."uploadedBy" IS NULL AND f.metadata->'uploader'->>'kind' IS NULL)::int AS unrecorded
       FROM storage_buckets b
       JOIN projects p ON p.id = b."projectId"
       LEFT JOIN users u ON u.id = p."userId"
       LEFT JOIN storage_files f ON f."bucketId" = b.id AND f."deletedAt" IS NULL
      WHERE ($1::text IS NULL OR b."projectId" = $1)
        AND (CASE WHEN $2::timestamptz IS NULL THEN b."uploadPolicy" = 'signed_in' ELSE b."createdAt" >= $2::timestamptz END)
      GROUP BY b.id, u.email, p."createdAt"
      ORDER BY p."createdAt", b.name`,
    ONLY,
    SINCE ? SINCE.toISOString() : null,
  )

  for (const r of rows) {
    console.log(
      [
        r.projectId, r.email ?? '-', r.bucket, `uploads ${r.uploads}`, `read ${r.accessPolicy}`, `created ${r.createdAt.toISOString()}`,
        `${r.endUser} from end users`, `${r.serverOrConsole} from servers or the console`,
        `${r.anonymous} from the public key alone`, `${r.unrecorded} not recorded`,
      ].join('\t'),
    )
  }
  const projects = new Set(rows.map((r) => r.projectId)).size
  console.log(
    SINCE
      ? `${rows.length} bucket(s) created since ${SINCE.toISOString()} in ${projects} project(s).`
      : `${rows.length} bucket(s) take uploads from any signed-in user, in ${projects} project(s).`,
  )
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

/**
 * Refuse an unsafe managed Cloud deployment BEFORE anything is changed.
 *
 * Run this ahead of the directory swap, the PM2 restart and the database
 * migration. Every check here is cheap and read-only; every failure it catches
 * is expensive and discovered late.
 *
 * WHY THIS EXISTS
 *
 * Two contracts look contradictory and are both correct:
 *
 *   product runtime      BACKENLY_EDITION unset -> single-tenant, and START.
 *                        A self-hosted operator must not have to know that an
 *                        edition concept exists.
 *
 *   managed deployment   BACKENLY_EDITION unset -> REFUSE.
 *                        On a Cloud host, "unset" is never an intention. It is
 *                        a lost variable, and honouring it would serve a
 *                        multi-tenant database with single-tenant project
 *                        rules, treating any authenticated account as the
 *                        operator of whichever project it asked for.
 *
 * During the Stage A cutover the release resolved to `single-tenant (default)`
 * and reported "this checkout would start". Nothing would have stopped it. The
 * only reason production did not come up in the wrong tenancy model is that a
 * human happened to check `pm2 jlist` afterwards.
 *
 * WHAT IS CHECKED
 *
 *   1. the edition is EXPLICITLY cloud, not defaulted
 *   2. the private Cloud composition is present and usable
 *   3. the manifest's publicBaseSha equals this checkout's HEAD
 *   4. no tracked file has been modified since that commit
 *   5. optionally, the private repository's PUBLIC_BASE_SHA also equals HEAD
 *
 * Check 3 is the one nothing else performs. loadCloudExtension() validates that
 * the manifest is well formed and that the module it names exists, but never
 * compares its pin against the commit actually checked out, so an overlay built
 * for a different public commit composes and starts.
 *
 * USAGE
 *
 *   npx tsx scripts/verify-deploy-preflight.ts [--root DIR] [--private-root DIR]
 *
 *   --root           checkout to inspect, default: found upwards from cwd.
 *                    Pass it to vet a prepared release directory from
 *                    elsewhere, e.g. the new tree before a directory swap.
 *   --private-root   private repository root, when the host has one.
 *
 * Exit codes: 0 accept, 1 refuse, 2 usage error.
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { CLOUD_MANIFEST_PATH, findRepoRoot, loadCloudExtension } from '../lib/edition/cloud-extension'

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
}

function main(): number {
  let privateRoot: string | null = null
  let explicitRoot: string | null = null
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--private-root' || argv[i] === '--root') {
      const flag = argv[i]
      const value = argv[++i] ?? null
      if (!value) {
        console.error(`verify-deploy-preflight: ${flag} needs a directory`)
        return 2
      }
      if (flag === '--root') explicitRoot = value
      else privateRoot = value
    } else {
      console.error(`verify-deploy-preflight: unknown option ${argv[i]}`)
      return 2
    }
  }

  const root = explicitRoot ? path.resolve(explicitRoot) : findRepoRoot()
  if (!root) {
    console.error('verify-deploy-preflight: could not locate the repository root')
    return 1
  }
  if (!fs.existsSync(path.join(root, 'overlay-allowlist.json'))) {
    console.error(`verify-deploy-preflight: ${root} does not look like a Backenly checkout`)
    return 1
  }

  // 1. Edition must be explicitly cloud. Read the variable directly rather than
  //    through getEdition(), because getEdition() cannot distinguish "set to
  //    single-tenant" from "unset", and here that difference is the whole point.
  const raw = process.env.BACKENLY_EDITION
  const edition = raw?.trim().toLowerCase() ?? ''
  record(
    'edition is explicitly cloud',
    edition === 'cloud',
    raw === undefined
      ? 'BACKENLY_EDITION is UNSET. A managed Cloud deploy must never rely on the default.'
      : `BACKENLY_EDITION=${JSON.stringify(raw)}`,
  )

  // 2. Composition present and usable.
  const state = loadCloudExtension(root)
  record(
    'private Cloud composition present',
    state.status === 'present',
    state.status === 'present'
      ? `${CLOUD_MANIFEST_PATH} valid, extension ${state.manifest.extension}`
      : state.status === 'absent'
        ? `${CLOUD_MANIFEST_PATH} does not exist: the overlay was never applied`
        : `overlay unusable: ${state.reason}`,
  )

  // 3. The manifest pin must match the commit actually checked out.
  let head = ''
  try {
    head = git(root, ['rev-parse', 'HEAD'])
  } catch {
    record('public HEAD readable', false, 'git rev-parse HEAD failed: not a git checkout?')
  }

  if (head && state.status === 'present') {
    const pinned = state.manifest.publicBaseSha
    record(
      'overlay pinned to this public commit',
      pinned === head,
      pinned === head
        ? `publicBaseSha == HEAD (${head})`
        : `publicBaseSha ${pinned} != HEAD ${head}. This overlay was built for a different public commit.`,
    )
  }

  // 4. A dirty tree means the artifact under test is not the commit named.
  if (head) {
    let dirty = ''
    try {
      dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
    } catch {
      /* reported by check 3 */
    }
    const modified = dirty.split('\n').filter((l) => l.trim().length > 0)
    record(
      'no tracked file modified',
      modified.length === 0,
      modified.length === 0 ? 'working tree clean' : `${modified.length} tracked file(s) modified since ${head}`,
    )
  }

  // 5. The private repository's own pin, when the deploy host has it. A
  //    composed release contains the overlay's files but not the private
  //    repository root, so this is checked only when explicitly pointed at one.
  if (privateRoot) {
    const pinFile = path.join(privateRoot, 'PUBLIC_BASE_SHA')
    if (!fs.existsSync(pinFile)) {
      record('private PUBLIC_BASE_SHA', false, `${pinFile} does not exist`)
    } else {
      const pin = fs.readFileSync(pinFile, 'utf8').trim()
      record(
        'private PUBLIC_BASE_SHA matches HEAD',
        pin === head,
        pin === head ? `PUBLIC_BASE_SHA == HEAD (${head})` : `PUBLIC_BASE_SHA ${pin} != HEAD ${head}`,
      )
    }
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('deploy preflight')
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok    ' : 'REFUSE'} ${c.name}`)
    console.log(`         ${c.detail}`)
  }

  if (failed.length > 0) {
    console.error('')
    console.error(`REFUSING DEPLOY: ${failed.length} check(s) failed.`)
    console.error('Nothing has been changed. Do not swap directories, restart PM2 or migrate.')
    return 1
  }

  console.log('')
  console.log('deploy preflight: ACCEPTED')
  return 0
}

process.exit(main())

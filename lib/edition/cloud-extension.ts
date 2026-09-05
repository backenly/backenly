/**
 * Does the private Cloud composition exist, and is it intact?
 *
 * Backenly Cloud is this public repository plus a private add-only overlay
 * (backenly/backenly-cloud). The overlay CREATES files under the paths
 * `overlay-allowlist.json` reserves; it never overwrites public source. This
 * module is how a running process finds out whether that composition actually
 * happened.
 *
 * ── Why it must fail closed ─────────────────────────────────────────────────
 *
 * A `cloud` process that cannot find its private half must EXIT. It must not
 * warn and continue, and above all it must not fall back to single-tenant. The
 * single-tenant resolver treats every authenticated account as the operator of
 * the one project, so running it against the multi-tenant production database
 * would hand any logged-in user somebody else's project. That is a
 * cross-tenant breach produced by a missing file, which is exactly the class of
 * failure a fallback invents. `lib/edition/index.ts` has said so since the seam
 * was introduced; this is that requirement implemented.
 *
 * ── Why a manifest, and not an import ───────────────────────────────────────
 *
 * The obvious design, `import('@/lib/cloud/extension')`, cannot work in both
 * editions at once. A static import to a path that does not exist in OSS fails
 * `tsc` and fails `next build` for every self-hoster, and a runtime dynamic
 * import of a `.ts` source path cannot resolve inside the Next standalone
 * bundle, where the source tree is not what is being executed. A JSON manifest
 * read through `fs` behaves identically in the Next server, the Express runtime
 * and a jest process, and needs nothing from the bundler.
 *
 * So the private overlay ships `lib/cloud/manifest.json`, and its presence is
 * the proof. Phases 6 and 7 move real Cloud code into `lib/cloud/**` alongside
 * it; the manifest names the entry module so that move has somewhere to land.
 *
 * ── Absent is not the same as broken ────────────────────────────────────────
 *
 * Both refuse to start, but they are different operational problems: one means
 * the overlay was never applied, the other means it was applied and is wrong.
 * Collapsing them into one "provider missing" message would send an operator
 * looking for a deployment step that already ran. A broad catch would do
 * exactly that, so the states are distinguished explicitly.
 */
import * as fs from 'fs'
import * as path from 'path'

import { currentEdition, type Edition } from './index'

/** The file the private overlay contributes. Public code never writes it. */
export const CLOUD_MANIFEST_PATH = 'lib/cloud/manifest.json'

/**
 * Marks the repository root.
 *
 * Not `package.json`: `process.cwd()` is not reliably the repo root. Next's
 * standalone server can run with its own directory as cwd, and there are
 * `package.json` files under `packages/` too, so the first one found walking up
 * would be the wrong answer in both directions. This file exists once, only at
 * the root, in both editions.
 */
const ROOT_MARKER = 'overlay-allowlist.json'

export interface CloudManifest {
  /** Bumped only when the shape changes. */
  schema: 1
  /** Public commit this overlay was written against. */
  publicBaseSha: string
  /** Repo-relative path of the private entry module. */
  extension: string
  /** What this overlay contributes. Informational in Phase 5. */
  capabilities: string[]
}

export type CloudExtensionState =
  | { status: 'present'; manifest: CloudManifest; manifestPath: string }
  | { status: 'absent'; manifestPath: string }
  | { status: 'invalid'; manifestPath: string; reason: string }

/**
 * Was the edition asked for, or merely defaulted to?
 *
 * `DEFAULT_EDITION` is still `cloud`, so an unset `BACKENLY_EDITION` resolves
 * to cloud in CI, in local development and in every OSS build. Requiring the
 * private overlay for that case would break all three and leave only two ways
 * out: flip the default early, or weaken the guarantee. Both are worse than
 * asking the question precisely.
 *
 * So the composition requirement attaches to an EXPLICIT `BACKENLY_EDITION=cloud`,
 * which is what a Cloud deployment sets. When the default flips to
 * single-tenant, explicit is the only remaining route to cloud and this
 * distinction tightens on its own with nothing to rewrite.
 */
export function editionIsExplicit(): boolean {
  return (process.env.BACKENLY_EDITION?.trim() ?? '') !== ''
}

/** True when this process must have the private overlay to run. */
export function requiresCloudComposition(): boolean {
  return editionIsExplicit() && currentEdition() === 'cloud'
}

/** Walk up for the root marker. Bounded, so a bad cwd cannot loop. */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start)
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ROOT_MARKER))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function validate(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'manifest is not a JSON object'
  }
  const m = raw as Record<string, unknown>
  if (m.schema !== 1) return `unsupported manifest schema ${JSON.stringify(m.schema)}, expected 1`
  if (typeof m.publicBaseSha !== 'string' || !/^[0-9a-f]{40}$/.test(m.publicBaseSha)) {
    return 'publicBaseSha must be a full 40-character commit sha'
  }
  if (typeof m.extension !== 'string' || m.extension.length === 0) {
    return 'extension must name the private entry module'
  }
  if (!Array.isArray(m.capabilities) || m.capabilities.some(c => typeof c !== 'string')) {
    return 'capabilities must be an array of strings'
  }
  return null
}

/**
 * Read the private manifest, if the overlay put one there.
 *
 * Never throws: the caller decides what a given state means, and in
 * single-tenant it means nothing at all.
 */
export function loadCloudExtension(root?: string): CloudExtensionState {
  const repoRoot = root ?? findRepoRoot()
  if (!repoRoot) {
    return {
      status: 'invalid',
      manifestPath: CLOUD_MANIFEST_PATH,
      reason: `could not locate the repository root (no ${ROOT_MARKER} above ${process.cwd()})`,
    }
  }

  const manifestPath = path.join(repoRoot, CLOUD_MANIFEST_PATH)
  if (!fs.existsSync(manifestPath)) return { status: 'absent', manifestPath }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return { status: 'invalid', manifestPath, reason: `manifest is not valid JSON: ${(err as Error).message}` }
  }

  const problem = validate(parsed)
  if (problem) return { status: 'invalid', manifestPath, reason: problem }

  const manifest = parsed as CloudManifest

  // The manifest is a claim about the overlay. An entry module it names but did
  // not deliver is a half-applied overlay, which is the state apply-overlay.sh
  // exists to make impossible; finding one here means something bypassed it.
  const entry = path.join(repoRoot, manifest.extension)
  if (!fs.existsSync(entry)) {
    return { status: 'invalid', manifestPath, reason: `manifest names ${manifest.extension}, which is not present` }
  }

  return { status: 'present', manifest, manifestPath }
}

export class CloudCompositionError extends Error {
  readonly state: CloudExtensionState
  constructor(message: string, state: CloudExtensionState) {
    super(message)
    this.name = 'CloudCompositionError'
    this.state = state
  }
}

/**
 * Throw unless this process is allowed to serve traffic.
 *
 * A no-op unless the edition was explicitly set to cloud. Single-tenant never
 * looks for the private overlay, so a self-host install never needs to know it
 * exists.
 */
export function assertEditionComposition(root?: string): void {
  if (!requiresCloudComposition()) return

  const state = loadCloudExtension(root)
  if (state.status === 'present') return

  const detail =
    state.status === 'absent'
      ? `The private Cloud overlay was never applied: ${CLOUD_MANIFEST_PATH} does not exist.`
      : `The private Cloud overlay is present but unusable: ${state.reason}.`

  throw new CloudCompositionError(
    'BACKENLY_EDITION=cloud, but this checkout has no usable private Cloud composition.\n' +
      `  ${detail}\n` +
      '  Cloud runs as the public repository plus the private overlay from backenly/backenly-cloud.\n' +
      '  Apply it with scripts/apply-overlay.sh before building, or run BACKENLY_EDITION=single-tenant.\n' +
      '  Refusing to start: falling back to single-tenant would treat every authenticated\n' +
      '  account as the operator of whichever project it asked for.',
    state,
  )
}

/**
 * Startup form: report and exit rather than unwind.
 *
 * A throw from a server bootstrap can be swallowed by a supervisor that retries
 * forever, or by a framework that logs it and carries on listening. Exiting
 * non-zero is the one outcome no caller can misread, and PM2 surfaces it as a
 * crash loop rather than a process quietly serving the wrong tenancy model.
 */
export function assertEditionCompositionOrExit(label: string, root?: string): void {
  try {
    assertEditionComposition(root)
  } catch (err) {
    if (!(err instanceof CloudCompositionError)) throw err
    // The message names paths and configuration only. No token, secret or
    // manifest content reaches the log.
    console.error(`\n[${label}] REFUSING TO START\n${err.message}\n`)
    process.exit(1)
  }
}

/** Exported for diagnostics that want to state the edition without re-deriving it. */
export function describeComposition(root?: string): { edition: Edition; explicit: boolean; state: CloudExtensionState['status'] } {
  return {
    edition: currentEdition(),
    explicit: editionIsExplicit(),
    state: loadCloudExtension(root).status,
  }
}

/**
 * The edition, said the way an operator needs to read it.
 *
 * "cloud (default)" and "cloud (explicit)" are the same edition but a different
 * contract: only the explicit one is required to have the private overlay, and
 * a diagnostic that printed just "cloud" would leave someone unable to tell why
 * their checkout was or was not being held to it.
 */
export function currentEditionLabel(): string {
  return `${currentEdition()} (${editionIsExplicit() ? 'explicit' : 'default'})`
}

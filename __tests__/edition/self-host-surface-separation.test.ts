/**
 * The self-hosted build must not present itself as a hosted SaaS.
 *
 * A cold install on 2026-09-17 showed the opposite: the root URL served the
 * marketing site including pricing and the competitor comparisons, the shell
 * showed a hardcoded "Free" plan chip against unlimited entitlements, the
 * account Usage page was permanently broken because it called an endpoint that
 * only ships with the Cloud overlay, and the 404 page offered "Get started
 * free". Branching and backups were then moved to Cloud-only by founder
 * decision; snapshots were later un-gated once lib/recovery/ made the pair
 * coherent, and that reversal is asserted rather than left as a deletion.
 *
 * None of that is visible in a diff, and all of it regresses the moment
 * somebody adds a nav item, a CTA or a fetch without thinking about edition.
 * So this asserts the SHAPE of the separation rather than any one call site.
 *
 * Like `oss-surface.test.ts`, these are OSS contracts: composed Cloud restores
 * the surfaces asserted absent here, so the suite states that precondition
 * instead of asking private CI to maintain an exclusion list.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

/** True when the Cloud overlay has been applied over this checkout. */
const composed = fs.existsSync(path.join(ROOT, 'lib/cloud/manifest.json'))
const describeOss = composed ? describe.skip : describe

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Strip comments so prose explaining a removal is not read as the thing itself. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describeOss('self-host surface separation', () => {
  describe('the edition seam itself', () => {
    it('resolves CLOUD_CONTROL_PLANE false without the overlay', () => {
      expect(code('lib/edition/oss/control-plane.ts')).toMatch(
        /export const CLOUD_CONTROL_PLANE = false/
      )
    })

    it('exposes a server-side guard that is separate from the presentation flag', () => {
      const guard = code('lib/edition/cloud-only.ts')
      // The guard must read the edition on the server. CLOUD_CONTROL_PLANE is a
      // client-visible build constant and its own header forbids using it as an
      // access check, so a guard built on it would be trivially flipped.
      expect(guard).toMatch(/currentEdition\(\)/)
      expect(guard).not.toMatch(/CLOUD_CONTROL_PLANE/)
    })
  })

  describe('marketing belongs to Cloud', () => {
    it('middleware redirects marketing paths away when the overlay is absent', () => {
      const mw = code('middleware.ts')
      expect(mw).toMatch(/CLOUD_CONTROL_PLANE/)
      expect(mw).toMatch(/isMarketingPath/)
      // The redirect must be conditional on edition, never unconditional.
      expect(mw).toMatch(/!CLOUD_CONTROL_PLANE\s*&&\s*isMarketingPath\(pathname\)/)
    })

    it('covers every marketing route that exists in the tree', () => {
      const mw = read('middleware.ts')
      const marketingDirs = [
        'pricing',
        'comparisons',
        'alternatives',
        'features',
        'use-cases',
        'resources',
        'contact',
        'terms',
        'privacy',
        'refund-policy',
      ].filter((d) => fs.existsSync(path.join(ROOT, 'app', d)))

      // Every marketing directory present on disk must be named in the
      // middleware lists, or a new landing page silently becomes reachable on
      // somebody's private infrastructure.
      for (const dir of marketingDirs) {
        expect(mw).toContain(`'/${dir}'`)
      }
    })

    it('never blocks the routes that reach the product', () => {
      const mw = code('middleware.ts')
      const marketingBlock = mw.slice(
        mw.indexOf('const marketingRoutes'),
        mw.indexOf('function isMarketingPath')
      )
      for (const keep of ['/auth', '/login', '/signup', '/app']) {
        expect(marketingBlock).not.toContain(`'${keep}'`)
      }
    })
  })

  describe('no plan, no upsell', () => {
    it('does not report a Cloud plan name off Cloud', () => {
      // The Subscription table is not in the self-host schema, so the resolver
      // returns null and the fallback is what an operator actually sees.
      expect(code('lib/autonomy/autonomy-level.ts')).toMatch(
        /isCloudEdition\(\)\s*\?\s*'Free'\s*:\s*'Self-hosted'/
      )
    })

    it('renders no plan chip in the OSS identity chip', () => {
      const chip = code('lib/edition/oss/org-switcher.tsx')
      expect(chip).not.toMatch(/\{plan\}/)
    })

    it('gates every Upgrade affordance in the dashboard on the overlay', () => {
      // Any button that routes to /app/billing must sit behind the flag: the
      // page it targets ships only with the overlay, so an ungated one is a
      // guaranteed 404 and an upsell with nothing behind it.
      for (const rel of ['app/app/page.tsx', 'app/app/usage/page.tsx']) {
        const src = code(rel)
        if (!src.includes('/app/billing')) continue
        expect(src).toMatch(/CLOUD_CONTROL_PLANE/)
      }
    })

    it('keeps the 404 page free of marketing CTAs off Cloud', () => {
      const nf = code('app/not-found.tsx')
      expect(nf).toMatch(/CLOUD_CONTROL_PLANE/)
      // Pricing / signup links must be inside the guard, not at the top level.
      const guarded = nf.indexOf('CLOUD_CONTROL_PLANE &&')
      expect(guarded).toBeGreaterThan(-1)
      // JSX attribute form, not a quoted string literal.
      const pricingAt = nf.indexOf('href="/pricing"')
      expect(pricingAt).toBeGreaterThan(guarded)
      expect(nf.indexOf('href="/auth/signup"')).toBeGreaterThan(guarded)
    })
  })

  describe('Cloud-only capabilities refuse at the service layer', () => {
    // Gating the HTTP route alone leaves the agent tool and the scheduler open,
    // and MCP is the door this product leads with.
    it('branches engine refuses off Cloud', () => {
      const engine = code('lib/branches/engine.ts')
      expect(engine).toMatch(/assertCloudEdition\('Preview branches'\)/)
      for (const fn of ['createBranch', 'mergeBranch', 'discardBranch', 'diffBranch']) {
        const at = engine.indexOf(`export async function ${fn}`)
        expect(at).toBeGreaterThan(-1)
        // The guard must be inside the function, near the top.
        expect(engine.slice(at, at + 600)).toMatch(/assertCloudEdition/)
      }
    })

    it('read paths answer empty rather than throwing', () => {
      // "What exists here" has a correct answer off Cloud, and it is none.
      expect(code('lib/branches/engine.ts')).toMatch(
        /export async function listBranches[\s\S]{0,400}isCloudEdition\(\)[\s\S]{0,80}return \[\]/
      )
    })

    it('their HTTP routes answer 404, not 403', () => {
      // Off Cloud the capability does not exist; 403 would imply it is present
      // and merely withheld.
      for (const rel of [
        'app/api/projects/[id]/branches/route.ts',
        'app/api/projects/[id]/branches/[branchId]/route.ts',
      ]) {
        const src = code(rel)
        expect(src).toMatch(/isCloudEdition/)
        expect(src).toMatch(/status: 404/)
        expect(src).not.toMatch(/CLOUD_ONLY_FEATURE[\s\S]{0,120}status: 403/)
      }
    })
  })

  describe('data protection is available to self-hosters, and named honestly', () => {
    /**
     * Snapshots WERE Cloud-only, by founder decision, until lib/recovery made
     * the pair coherent. These assert the un-gating rather than leaving the
     * old Cloud-only assertions to be deleted quietly, because "a test was
     * removed" and "a decision was reversed" should not look the same in a
     * diff.
     */
    it('the snapshot service no longer refuses off Cloud', () => {
      const svc = code('lib/services/workspace-backup.ts')
      expect(svc).not.toMatch(/assertCloudEdition/)
    })

    it('listing snapshots is not stubbed to empty off Cloud', () => {
      expect(code('lib/services/workspace-backup.ts')).not.toMatch(
        /export async function listBackups[\s\S]{0,400}isCloudEdition\(\)[\s\S]{0,80}return \[\]/
      )
    })

    it('the snapshot route does not 404 by edition', () => {
      const src = code('app/api/projects/[id]/backup/route.ts')
      expect(src).not.toMatch(/CLOUD_ONLY_FEATURE/)
    })

    it('SCHEDULED snapshots still need an explicit opt-in off Cloud', () => {
      // Un-gating the feature must not start a daily pg_dump of every project
      // on every existing install at upgrade. The flag is the difference
      // between offering a capability and enabling a cron job on somebody's
      // behalf.
      const svc = code('lib/services/workspace-backup.ts')
      expect(svc).toMatch(/BACKENLY_SCHEDULED_SNAPSHOTS/)
      expect(svc).toMatch(
        /export async function runDailyBackups[\s\S]{0,400}scheduledSnapshotsEnabled\(\)[\s\S]{0,120}return \{ ran: 0/
      )
    })

    it('deployment recovery is refused in CLOUD, the other direction', () => {
      // The inverse gate. It reads every tenant's projects, users and secrets,
      // which is right when the single account is the operator of the machine
      // and is one tenant exporting everybody in Cloud.
      const route = code('app/api/deployment/recovery/export/route.ts')
      expect(route).toMatch(/assertSingleTenantEdition/)
      expect(route).toMatch(/status: 404/)

      // Before authentication: a 401 in Cloud would tell an unauthenticated
      // caller the capability exists and is merely gated.
      //
      // Measured inside the handler, not across the file. Comparing positions
      // in the whole source compares the IMPORT lines, which are ordered by
      // module path and say nothing about what runs first.
      const body = route.slice(route.indexOf('export async function POST'))
      expect(body.indexOf('assertSingleTenantEdition')).toBeGreaterThan(-1)
      expect(body.indexOf('requireUser')).toBeGreaterThan(-1)
      expect(body.indexOf('assertSingleTenantEdition'))
        .toBeLessThan(body.indexOf('requireUser'))
    })

    it('the two products are never called just "Backup" in the UI', () => {
      // The word is the problem: an operator who reads it and concludes their
      // server is safe has been misled by the product.
      const snapshots = code('components/database/DatabaseSnapshots.tsx')
      const recovery = code('components/app/DeploymentRecoverySection.tsx')
      expect(snapshots).toMatch(/snapshot/i)
      expect(recovery).toMatch(/recovery/i)
      // Each names its sibling, so neither can be mistaken for the other.
      expect(snapshots).toMatch(/Recovery/)
      expect(recovery).toMatch(/snapshot/i)
    })
  })

  describe('the dashboard offers no control for refused work', () => {
    it('drops Branches from the project sidebar off Cloud', () => {
      const nav = code('components/shell/ProjectSidebar.tsx')
      expect(nav).toMatch(/CLOUD_CONTROL_PLANE[\s\S]{0,200}id: 'branches'/)
    })

    it('drops Usage, Members and Billing from the org nav off Cloud', () => {
      const nav = code('components/shell/OrgShell.tsx')
      const guardAt = nav.indexOf('CLOUD_CONTROL_PLANE')
      for (const id of ["id: 'usage'", "id: 'members'", "id: 'billing'"]) {
        const at = nav.indexOf(id)
        expect(at).toBeGreaterThan(-1)
        expect(at).toBeGreaterThan(guardAt)
      }
    })

    it('guards the pages themselves, not only the nav', () => {
      // A typed URL or an old bookmark still resolves; without this the page
      // renders a shell whose every call answers 404.
      for (const rel of ['app/app/projects/[id]/branches/page.tsx', 'app/app/usage/page.tsx']) {
        const src = code(rel)
        expect(src).toMatch(/CLOUD_CONTROL_PLANE/)
        expect(src).toMatch(/notFound\(\)/)
      }
    })

    it('drops the Cloud command-palette entries off Cloud', () => {
      const palette = code('components/app/CommandPalette.tsx')
      for (const id of ["id: 'p-branches'", "id: 'a-members'", "id: 'a-billing'"]) {
        const at = palette.indexOf(id)
        expect(at).toBeGreaterThan(-1)
        const before = palette.slice(Math.max(0, at - 400), at)
        expect(before).toMatch(/CLOUD_CONTROL_PLANE/)
      }
    })
  })
})

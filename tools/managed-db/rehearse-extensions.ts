/**
 * LAYER 2 REHEARSAL — prove extension provisioning in a throwaway database.
 *
 * Runs inside a one-shot staging Fargate task. Everything it mutates lives in a
 * scratch database this run created and drops; the real staging database is
 * never touched, and Layer 3 and Layer 4 are not involved at all.
 *
 * What it has to establish before Layer 2 may go near a real database:
 *
 *   the preconditions are what capability discovery said they were
 *   provisioning makes all three extensions operational, proven by real reads
 *   name, version AND schema are recorded, because schema matters for lineage
 *   a second run changes nothing
 *   the scratch database is gone, and none are left behind
 */

import { captureCapabilities, type CapabilityReport } from '../migration-lineage/probe/capabilities'
import { capabilityStatus } from '../migration-lineage/probe/capabilities'
import { clientConfig, connect, type DbTarget, type PgClient, type TlsPolicy } from '../migration-lineage/probe/connect'
import { REQUIRED_EXTENSION_NAMES } from './extension-spec'
import {
  extensionIdentities,
  planExtensionProvisioning,
  provisionExtensions,
  ProvisionRefusal,
  type ExtensionIdentity,
  type ProvisionOutcome,
} from './provision-extensions'
import { listScratchDatabases, withScratchDatabase, type ScratchCleanup } from './scratch-database'

export interface ExtensionRehearsalResult {
  rehearsal: 'layer2-extensions'
  version: 1
  startedAt: string
  finishedAt: string
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  failures: string[]
  inconclusive: string[]
  before: CapabilityReport | null
  beforeStatuses: Array<{ name: string; status: string }>
  firstRun: ProvisionOutcome | null
  identitiesAfterFirst: ExtensionIdentity[]
  secondRun: ProvisionOutcome | null
  identitiesAfterSecond: ExtensionIdentity[]
  idempotent: boolean | null
  scratch: ScratchCleanup | null
  scratchDatabasesAfter: string[] | null
  error: string | null
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function rehearseExtensions(
  admin: PgClient,
  target: DbTarget,
  policy: TlsPolicy,
): Promise<ExtensionRehearsalResult> {
  const r: ExtensionRehearsalResult = {
    rehearsal: 'layer2-extensions',
    version: 1,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    verdict: 'INCONCLUSIVE',
    failures: [],
    inconclusive: [],
    before: null,
    beforeStatuses: [],
    firstRun: null,
    identitiesAfterFirst: [],
    secondRun: null,
    identitiesAfterSecond: [],
    idempotent: null,
    scratch: null,
    scratchDatabasesAfter: null,
    error: null,
  }

  try {
    const out = await withScratchDatabase(admin, 'ext', async name => {
      const scratch = await connect(clientConfig(target, policy, { database: name }))
      try {
        const before = await captureCapabilities(scratch, REQUIRED_EXTENSION_NAMES)
        r.before = before
        r.beforeStatuses = before.extensions.map(e => ({ name: e.name, status: capabilityStatus(e) }))

        // A fresh database must start from the state discovery described. If it
        // does not, the plan this rehearsal would prove is not the plan that
        // would run later.
        const plan = planExtensionProvisioning(before)
        if (plan.installable.length !== REQUIRED_EXTENSION_NAMES.length) {
          throw new ProvisionRefusal(
            `a fresh database should need all ${REQUIRED_EXTENSION_NAMES.length} extensions installed, plan says ${JSON.stringify(plan.steps)}`,
          )
        }

        const recapture = (c: PgClient) => captureCapabilities(c, REQUIRED_EXTENSION_NAMES)
        const firstRun = await provisionExtensions(scratch, before, recapture)
        const identitiesAfterFirst = await extensionIdentities(scratch)

        // Idempotence is the property that decides whether this may ever run
        // against a real database twice.
        const beforeSecond = await recapture(scratch)
        const secondRun = await provisionExtensions(scratch, beforeSecond, recapture)
        const identitiesAfterSecond = await extensionIdentities(scratch)

        return { firstRun, identitiesAfterFirst, secondRun, identitiesAfterSecond }
      } finally {
        await scratch.end().catch(() => {})
      }
    })

    r.scratch = out.cleanup
    if (out.error) r.inconclusive.push(`rehearsal did not complete: ${out.error}`)
    if (out.value) {
      r.firstRun = out.value.firstRun
      r.identitiesAfterFirst = out.value.identitiesAfterFirst
      r.secondRun = out.value.secondRun
      r.identitiesAfterSecond = out.value.identitiesAfterSecond

      for (const f of out.value.firstRun.failures) r.failures.push(`first run: ${f}`)
      for (const f of out.value.secondRun.failures) r.failures.push(`second run: ${f}`)

      if (out.value.firstRun.executed.length !== REQUIRED_EXTENSION_NAMES.length) {
        r.failures.push(`first run installed ${out.value.firstRun.executed.length} of ${REQUIRED_EXTENSION_NAMES.length}`)
      }
      if (out.value.secondRun.executed.length !== 0) {
        r.failures.push(`second run executed ${JSON.stringify(out.value.secondRun.executed)}; it should have had nothing to do`)
      }

      r.idempotent =
        JSON.stringify(out.value.identitiesAfterFirst) === JSON.stringify(out.value.identitiesAfterSecond)
      if (!r.idempotent) r.failures.push('a second provisioning run changed the extensions')

      if (out.value.identitiesAfterFirst.length !== REQUIRED_EXTENSION_NAMES.length) {
        r.failures.push('not every required extension is present after provisioning')
      }
    }

    r.scratchDatabasesAfter = await listScratchDatabases(admin)
  } catch (err) {
    r.error = message(err)
    if (err instanceof ProvisionRefusal) r.failures.push(`refused: ${r.error}`)
    else r.inconclusive.push(`rehearsal error: ${r.error}`)
  }

  if (r.scratch?.created && !r.scratch.dropped) {
    r.failures.push(`scratch database ${r.scratch.name} was not dropped: ${r.scratch.error}`)
  }
  if (r.scratchDatabasesAfter?.length) {
    r.failures.push(`lineage scratch databases still exist: ${r.scratchDatabasesAfter.join(', ')}`)
  }

  r.finishedAt = new Date().toISOString()
  r.verdict = r.failures.length ? 'FAIL' : r.inconclusive.length ? 'INCONCLUSIVE' : 'PASS'
  return r
}

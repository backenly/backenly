/**
 * The lineage report.
 *
 *   npx tsx tools/migration-lineage/report.ts --results <dir> [--manifests <dir>] [--out <file>]
 *
 * Reads the task results written by scripts/run-migration-lineage-fargate.ts,
 * compares them locally, attributes what staging holds beyond the current model,
 * and applies the gate. Comparison happens here rather than inside a task so it
 * is reproducible from the recorded results, and so a change to the comparison
 * does not mean running against staging again.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attribute, type Attribution, type Manifest } from './attribute'
import { assertRepoRoot, verifiedEvidence } from './build-inputs'
import { countByKind, diffSnapshots, type Difference } from './diff'
import { gate, type Evidence } from './gate'
import type { Snapshot } from './probe/capture'
import type { ProbeResult } from './probe/run'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function load(dir: string, name: string): ProbeResult | null {
  const path = join(dir, `${name}.json`)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ProbeResult) : null
}

function loadManifests(dir: string | null): Manifest[] {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Manifest)
}

/**
 * The replayed chain must be the hashed evidence, byte for byte.
 *
 * `ok: null` means there was nothing to verify because the chain was not
 * replayed in this run, which is a different fact from a file failing its hash.
 * Since staging was baselined the chain is forensic evidence rather than a
 * lineage input, so a run that omits it is normal; reporting that as a hash
 * mismatch would be a false statement about the evidence.
 */
function verifyChainInputs(root: string, chain: ProbeResult | null): { ok: boolean | null; problems: string[] } {
  if (!chain?.input) return { ok: null, problems: ['the legacy chain was not replayed in this run'] }
  const sums = verifiedEvidence(root)
  const problems: string[] = []
  for (const file of chain.input.files) {
    const expected = sums.get(`legacy-prisma-chain/${file.name}/migration.sql`)
    if (!expected) problems.push(`${file.name} is not in SHA256SUMS`)
    else if (expected !== file.sha256) problems.push(`${file.name} replayed ${file.sha256}, evidence says ${expected}`)
  }
  if (chain.input.files.length !== 18) problems.push(`replayed ${chain.input.files.length} files, evidence holds 18`)
  return { ok: problems.length === 0, problems }
}

function section(title: string): void {
  console.log(`\n${title}\n${'='.repeat(title.length)}`)
}

function printDifferences(differences: Difference[], limit = 40): void {
  for (const d of differences.slice(0, limit)) {
    const detail = d.fields ? d.fields.map(f => `${f.field}: ${JSON.stringify(f.left)} -> ${JSON.stringify(f.right)}`).join(', ') : ''
    console.log(`    ${d.status.padEnd(18)} ${d.key}${detail ? `  (${detail})` : ''}`)
  }
  if (differences.length > limit) console.log(`    … and ${differences.length - limit} more`)
}

function main(): void {
  const results = arg('--results')
  if (!results) {
    console.error('usage: report.ts --results <dir> [--manifests <dir>] [--out <file>]')
    process.exit(2)
  }
  const root = process.cwd()
  assertRepoRoot(root)

  const tlsRls = load(results, 'tls-rls')
  const staging = load(results, 'capture-staging')
  const chain = load(results, 'replay-chain')
  const push = load(results, 'replay-push')
  const manifests = loadManifests(arg('--manifests'))
  const inputs = verifyChainInputs(root, chain)

  section('LINEAGE PROBE')
  console.log(`results   ${results}`)
  console.log(`manifests ${manifests.length} (${manifests.map(m => m.id).join(', ') || 'none'})`)

  section('TLS')
  if (tlsRls?.tls && 'authorized' in tlsRls.tls) {
    console.log(`  authorized=${tlsRls.tls.authorized} server.ssl=${tlsRls.tls.server.ssl} ${tlsRls.tls.protocol} ${tlsRls.tls.server.cipher}`)
    console.log(`  chain ${tlsRls.tls.chain.map(c => c.subject).join(' <- ')}`)
  } else {
    console.log('  no TLS observation')
  }
  for (const c of tlsRls?.tlsControls ?? []) {
    console.log(`  control ${c.refusedByVerification ? 'REFUSED' : 'NOT REFUSED'}  ${c.label} (${c.code ?? 'no code'})`)
  }

  section('RLS VISIBILITY')
  const rls = staging?.rls ?? tlsRls?.rls
  if (rls) {
    console.log(`  consistent=${rls.consistent} pg_policy=${rls.policiesTotalUnjoined} joined=${rls.policiesTotalJoined} view=${rls.policiesTotalView}`)
    for (const s of rls.bySchema) {
      console.log(`    ${s.schema.padEnd(24)} tables=${String(s.tables).padStart(4)} rls=${s.rlsEnabled} forced=${s.rlsForced} policies=${s.policiesFromCatalog}  ${s.classification}`)
    }
  }
  if (tlsRls?.rlsControl) {
    console.log(`  positive control: ${tlsRls.rlsControl.failures.length === 0 && !tlsRls.rlsControl.error ? 'observed' : 'NOT observed'}`)
  }

  section('REPLAY')
  console.log(`  chain       ${chain?.replay ? `${chain.replay.status} ${chain.replay.applied}/${chain.replay.total}` : 'absent'}`)
  console.log(`  projection  ${push?.replay ? `${push.replay.status} ${push.replay.applied}/${push.replay.total}` : 'absent'}`)
  console.log(`  inputs      ${inputs.ok ? 'match the hashed evidence' : `PROBLEM: ${inputs.problems.join('; ')}`}`)

  let aToP: Difference[] = []
  if (chain?.snapshot && push?.snapshot) {
    aToP = diffSnapshots(chain.snapshot, push.snapshot)
    section('A -> P   how far the legacy chain fell behind the current model (reported, not gating)')
    for (const c of countByKind(aToP)) {
      console.log(`  ${c.kind.padEnd(14)} only in chain ${String(c.missing).padStart(4)}   differs ${String(c.differs).padStart(4)}   only in model ${String(c.extra).padStart(4)}`)
    }
  }

  let pToC: Difference[] = []
  let attributions: Attribution[] = []
  if (push?.snapshot && staging?.snapshot) {
    pToC = diffSnapshots(push.snapshot, staging.snapshot)
    attributions = attribute(pToC, manifests)

    section('P -> C   what staging holds beyond or below the current model (gating)')
    for (const c of countByKind(pToC)) {
      console.log(`  ${c.kind.padEnd(14)} missing ${String(c.missing).padStart(4)}   differs ${String(c.differs).padStart(4)}   extra ${String(c.extra).padStart(4)}`)
    }

    const bad = pToC.filter(d => d.status !== 'extra_in_right')
    if (bad.length) {
      console.log('\n  missing from staging, or defined differently:')
      printDifferences(bad)
    }

    section('ATTRIBUTION')
    const inBoth = (push.snapshot ? countObjects(push.snapshot) : 0) - pToC.filter(d => d.status !== 'extra_in_right').length
    console.log(`  represented_in_schema_prisma       ${inBoth}`)
    const byBucket = new Map<string, Attribution[]>()
    for (const a of attributions) byBucket.set(a.bucket, [...(byBucket.get(a.bucket) ?? []), a])
    for (const bucket of ['known_legacy_sql_effect', 'known_provisioning_effect', 'expected_environmental_difference', 'unexplained_divergence']) {
      const list = byBucket.get(bucket) ?? []
      console.log(`  ${bucket.padEnd(34)} ${list.length}`)
    }
    const unexplained = byBucket.get('unexplained_divergence') ?? []
    if (unexplained.length) {
      console.log('\n  unexplained:')
      for (const a of unexplained.slice(0, 60)) console.log(`    ${a.difference.key}  (${a.reason})`)
      if (unexplained.length > 60) console.log(`    … and ${unexplained.length - 60} more`)
    }
  }

  const evidence: Evidence = {
    tlsRls: tlsRls?.verdict ?? null,
    captureStaging: Boolean(staging?.snapshot) && staging?.verdict === 'PASS',
    chainReplay: chain?.replay?.status ?? null,
    pushReplay: push?.replay?.status ?? null,
    inputsVerified: inputs.ok,
  }
  const result = gate(pToC, attributions, evidence)

  section('VERDICT')
  console.log(`  ${result.verdict}`)
  for (const r of result.reasons) console.log(`    - ${r}`)
  for (const n of result.notes) console.log(`    note: ${n}`)
  console.log(`\n  scoped to staging. It says nothing about production, whose provisioning lineage is unknown.`)

  const out = arg('--out')
  if (out) {
    writeFileSync(
      out,
      JSON.stringify({ generatedAt: new Date().toISOString(), evidence, gate: result, aToP, pToC, attributions, manifests: manifests.map(m => ({ id: m.id, source: m.source, bucket: m.bucket, derivation: m.derivation, confidence: m.confidence, entries: m.entries.length })) }, null, 2),
    )
    console.log(`\n  wrote ${out}`)
  }
  process.exitCode = result.verdict === 'STAGING_BASELINE_ELIGIBLE' ? 0 : 1
}

function countObjects(snapshot: Snapshot): number {
  const collections: Array<keyof Snapshot> = [
    'tables', 'columns', 'constraints', 'indexes', 'types', 'sequences',
    'policies', 'triggers', 'routines', 'views', 'eventTriggers', 'extensions',
  ]
  return collections.reduce((n, k) => n + ((snapshot[k] as unknown[] | undefined)?.length ?? 0), 0)
}

main()

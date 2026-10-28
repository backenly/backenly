/**
 * THE IMAGES TRUST EXACTLY THE PINNED RDS ROOTS
 * =============================================
 *
 * Both runtime images set NODE_EXTRA_CA_CERTS to the RDS roots of every
 * Backenly Cloud region, so node-postgres can verify an RDS certificate chain.
 * Without them, every `pg.Pool` failed against RDS with "self-signed
 * certificate in certificate chain" — and because the autonomy probes run
 * through that pool, the loop recorded fourteen errored invariants, saw no
 * gaps, and healed nothing while every health check stayed green (AWS staging,
 * 2026-09-22). RDS roots are per region: the home region's alone cannot verify
 * a regional project's database, which the console and MCP connect to, nor the
 * database a regional task serves from.
 *
 * Three things must not drift silently:
 *
 *   - the home bundle must be byte-identical to the pinned set the lineage
 *     tooling already verifies, so there is one reviewed copy of the trust
 *     material, not two that can diverge (each other region's bundle is pinned
 *     in regional-bootstrap.spec.ts);
 *   - every region a project can be created in has its bundle in the images;
 *   - both Dockerfiles must actually point Node at all of them. Deleting the
 *     ENV line would reintroduce the blind loop with no build or test failure
 *     at all.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CLOUD_REGIONS } from '../../lib/regions'
import { RDS_CA_PIN_SHA256_BASE64, loadRdsCa } from '../../tools/migration-lineage/probe/rds-ca'

const root = join(__dirname, '..', '..')
const HOME_BUNDLE = 'docker/certs/rds-ca-ap-south-1.pem'
const IN_IMAGE = '/app/certs/rds-ca-cloud-regions.pem'
const REGION_IDS = CLOUD_REGIONS.map((region) => region.id)

describe('the RDS CA bundles baked into the images', () => {
  const pem = readFileSync(join(root, HOME_BUNDLE), 'utf8')

  it('has the home region bundle byte for byte as pinned', () => {
    const actual = createHash('sha256').update(pem).digest('base64')
    expect(actual).toBe(RDS_CA_PIN_SHA256_BASE64)
    expect(pem).toBe(loadRdsCa())
  })

  it('holds the three ap-south-1 roots and nothing else in the home bundle', () => {
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(3)
  })

  it('has a committed bundle for every Cloud region', () => {
    for (const id of REGION_IDS) expect(existsSync(join(root, `docker/certs/rds-ca-${id}.pem`))).toBe(true)
  })

  it.each(['docker/web.Dockerfile', 'docker/runtime.Dockerfile'])(
    '%s copies every region bundle, joins them, and points Node at the result',
    (dockerfile) => {
      const src = readFileSync(join(root, dockerfile), 'utf8')
      const copy = src.split('\n').find((line) => line.startsWith('COPY docker/certs/'))
      expect(copy).toBeDefined()
      expect(copy!.trim().split(/\s+/).slice(1, -1).sort()).toEqual(REGION_IDS.map((id) => `docker/certs/rds-ca-${id}.pem`).sort())
      expect(copy!.trim().endsWith(' /app/certs/')).toBe(true)

      const join_ = src.split('\n').find((line) => line.startsWith('RUN cat /app/certs/'))
      expect(join_).toBeDefined()
      const [inputs, output] = join_!.replace(/^RUN cat /, '').split(' > ')
      expect(inputs.trim().split(/\s+/).sort()).toEqual(REGION_IDS.map((id) => `/app/certs/rds-ca-${id}.pem`).sort())
      expect(output.trim()).toBe(IN_IMAGE)

      expect(src).toMatch(new RegExp(`NODE_EXTRA_CA_CERTS=${IN_IMAGE.replace(/\//g, '\\/')}`))
    },
  )
})

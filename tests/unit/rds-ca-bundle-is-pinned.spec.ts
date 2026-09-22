/**
 * THE IMAGES TRUST EXACTLY THE PINNED RDS ROOTS
 * =============================================
 *
 * Both runtime images set NODE_EXTRA_CA_CERTS to docker/certs/rds-ca-ap-south-1.pem
 * so node-postgres can verify an RDS certificate chain. Without it, every
 * `pg.Pool` failed against RDS with "self-signed certificate in certificate
 * chain" — and because the autonomy probes run through that pool, the loop
 * recorded fourteen errored invariants, saw no gaps, and healed nothing while
 * every health check stayed green (AWS staging, 2026-09-22).
 *
 * Two things must not drift silently:
 *
 *   - the bundle the images trust must be byte-identical to the pinned set the
 *     lineage tooling already verifies, so there is one reviewed copy of the
 *     trust material, not two that can diverge;
 *   - both Dockerfiles must actually point Node at it. Deleting the ENV line
 *     would reintroduce the blind loop with no build or test failure at all.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RDS_CA_PIN_SHA256_BASE64, loadRdsCa } from '../../tools/migration-lineage/probe/rds-ca'

const root = join(__dirname, '..', '..')
const BUNDLE = 'docker/certs/rds-ca-ap-south-1.pem'
const IN_IMAGE = '/app/certs/rds-ca-ap-south-1.pem'

describe('the RDS CA bundle baked into the images', () => {
  const pem = readFileSync(join(root, BUNDLE), 'utf8')

  it('matches the pinned bundle byte for byte', () => {
    const actual = createHash('sha256').update(pem).digest('base64')
    expect(actual).toBe(RDS_CA_PIN_SHA256_BASE64)
    expect(pem).toBe(loadRdsCa())
  })

  it('holds the three ap-south-1 roots and nothing else', () => {
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(3)
  })

  it.each(['docker/web.Dockerfile', 'docker/runtime.Dockerfile'])(
    '%s copies the bundle and points Node at it',
    dockerfile => {
      const src = readFileSync(join(root, dockerfile), 'utf8')
      expect(src).toContain(`COPY ${BUNDLE} ${IN_IMAGE}`)
      expect(src).toMatch(new RegExp(`NODE_EXTRA_CA_CERTS=${IN_IMAGE.replace(/\//g, '\\/')}`))
    },
  )
})

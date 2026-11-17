/**
 * WHAT A PROJECT MAY ALLOW TO CONNECT TO ITS DATABASE, AND HOW MANY
 * ================================================================
 *
 * The region's database endpoint is shared by every project there, so an
 * allowed address is one public IPv4 address or a range no wider than /16,
 * normalised to the network it names (lib/security/allowed-address.ts); and a
 * project may allow up to its plan's number: Free 2, Pro 10, Enterprise 50
 * (lib/entitlements/direct-postgres.ts; owner's decision, 2026-11-17).
 */

import { addressInRange, parseAllowedAddress } from '@/lib/security/allowed-address'
import { directPostgresAllowance } from '@/lib/entitlements/direct-postgres'

/** An address built from its octets, for the few outside the documentation ranges. */
const ip = (...octets: number[]) => octets.join('.')

const cidr = (input: string) => {
  const parsed = parseAllowedAddress(input)
  return parsed.ok ? parsed.cidr : parsed.code
}

describe('an address to allow', () => {
  it('is one address (a /32) or a range, normalised to the network it names', () => {
    expect(cidr('203.0.113.7')).toBe('203.0.113.7/32')
    expect(cidr(' 203.0.113.7/32 ')).toBe('203.0.113.7/32')
    expect(cidr('203.0.113.77/24')).toBe('203.0.113.0/24')
    expect(cidr('198.19.255.255/16')).toBe('198.19.0.0/16')
  })

  it('is never wider than /16, and never every address', () => {
    expect(cidr('198.18.0.0/16')).toBe('198.18.0.0/16')
    expect(cidr('198.18.0.0/15')).toBe('ADDRESS_RANGE_TOO_WIDE')
    expect(cidr('8.0.0.0/8')).toBe('ADDRESS_RANGE_TOO_WIDE')
    expect(cidr('0.0.0.0/0')).toBe('ADDRESS_RANGE_TOO_WIDE')
    expect(cidr('203.0.113.7/0')).toBe('ADDRESS_RANGE_TOO_WIDE')
    expect(parseAllowedAddress('0.0.0.0/0')).toEqual({
      ok: false,
      code: 'ADDRESS_RANGE_TOO_WIDE',
      message: '0.0.0.0/0 is every address on the internet. Allow only the addresses you connect from: one address, or a range no wider than /16.',
    })
  })

  it('is public: private, loopback, link-local, carrier-grade NAT, multicast and reserved ranges never connect from the internet', () => {
    for (const range of ['10.0.0.1', '10.200.0.0/16', '172.16.0.1', '172.31.255.0/24', '192.168.0.0/16', '127.0.0.1', '169.254.169.254', '100.64.0.1', '100.127.0.0/16', '224.0.0.1', '240.0.0.1', '255.255.255.255', '0.1.2.3']) {
      expect([range, cidr(range)]).toEqual([range, 'ADDRESS_NOT_PUBLIC'])
    }
    // Next to a private range is not inside it.
    expect(cidr(ip(172, 32, 0, 1))).toBe(`${ip(172, 32, 0, 1)}/32`)
    expect(cidr(ip(100, 128, 0, 1))).toBe(`${ip(100, 128, 0, 1)}/32`)
    expect(cidr('11.0.0.0/16')).toBe('11.0.0.0/16')
  })

  it('is IPv4: an IPv6 address is refused with what to send instead', () => {
    expect(parseAllowedAddress('2001:db8::1')).toMatchObject({ ok: false, code: 'IPV6_NOT_SUPPORTED' })
    expect(parseAllowedAddress('::ffff:203.0.113.7')).toMatchObject({ ok: false, code: 'IPV6_NOT_SUPPORTED' })
  })

  it('is an address: anything else is refused, never guessed at', () => {
    for (const input of ['', 'db.example.com', '203.0.113', '203.0.113.256', '203.0.113.07', '203.0.113.7/33', '203.0.113.7/', '203.0.113.7/24/8', '203.0.113.7/ 24', null, 42]) {
      expect([input, cidr(input as string)]).toEqual([input, 'INVALID_ADDRESS'])
    }
  })

  it('knows whether an address is inside a range', () => {
    expect(addressInRange('198.51.100.23', '198.51.100.0/24')).toBe(true)
    expect(addressInRange('198.51.101.23', '198.51.100.0/24')).toBe(false)
    expect(addressInRange('198.51.100.23', '198.51.100.23/32')).toBe(true)
    expect(addressInRange('2001:db8::1', '198.51.100.0/24')).toBe(false)
  })
})

describe('how many a plan allows', () => {
  it.each([
    ['SANDBOX', 2],
    ['FREE', 2],
    ['BUILDER', 10],
    ['PRO', 10],
    ['SCALE', 50],
    ['SELF_HOSTED', 50],
  ])('%s: %i addresses per project', (plan, allowed) => {
    expect(directPostgresAllowance(plan).allowedAddresses).toBe(allowed)
  })

  it('gives a plan it does not know, or none, the least', () => {
    expect(directPostgresAllowance('SOMETHING_NEW')).toEqual({ planName: 'SANDBOX', allowedAddresses: 2 })
    expect(directPostgresAllowance(null)).toEqual({ planName: 'SANDBOX', allowedAddresses: 2 })
  })
})

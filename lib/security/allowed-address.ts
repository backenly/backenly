/**
 * An address a project may allow to connect to its database directly, read
 * from what a person or an agent typed (lib/services/direct-access-addresses.ts).
 *
 *   - IPv4 only, one address ("203.0.113.7", which is 203.0.113.7/32) or a
 *     CIDR range no wider than /16 (65,536 addresses). 0.0.0.0/0 and every
 *     range wider than /16 are refused: the database endpoint is shared by
 *     every project in its region, and a login's password would be all that
 *     stands between it and the rest of the internet.
 *   - Public addresses only. A private, loopback, link-local, carrier-grade
 *     NAT, multicast or reserved range never reaches the endpoint from the
 *     internet, and would take a place on the region's shared list for
 *     nothing. Supabase's network restrictions refuse private ranges the same way.
 *   - Normalised to the network the range names (203.0.113.7/24 is
 *     203.0.113.0/24), so one range is one entry however it was typed.
 *
 * Pure, with no Node built-ins, so the console can use it as well.
 */

export type AddressRefusalCode =
  | 'INVALID_ADDRESS'
  | 'IPV6_NOT_SUPPORTED'
  | 'ADDRESS_RANGE_TOO_WIDE'
  | 'ADDRESS_NOT_PUBLIC'

export type ParsedAddress =
  | { ok: true; cidr: string }
  | { ok: false; code: AddressRefusalCode; message: string }

/** The widest range a project may allow: /16, 65,536 addresses. */
export const WIDEST_PREFIX = 16

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`)

/**
 * Ranges that never connect from the internet, with what each is called. A
 * range no wider than /16 lies wholly inside one of these or wholly outside
 * every one, since none of them is narrower than /16.
 */
const NOT_PUBLIC: ReadonlyArray<[network: string, prefix: number, called: string]> = [
  ['0.0.0.0', 8, 'a reserved range'],
  ['10.0.0.0', 8, 'a private network range'],
  ['100.64.0.0', 10, 'a carrier-grade NAT range'],
  ['127.0.0.0', 8, 'a loopback range (this computer only)'],
  ['169.254.0.0', 16, 'a link-local range'],
  ['172.16.0.0', 12, 'a private network range'],
  ['192.168.0.0', 16, 'a private network range'],
  ['224.0.0.0', 4, 'a multicast range'],
  ['240.0.0.0', 4, 'a reserved range'],
]

export function isIPv4(value: string): boolean {
  return IPV4.test(value)
}

function toInt(address: string): number {
  return address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0)
}

function fromInt(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.')
}

/** The first address of the /prefix network `n` is in. */
function networkOf(n: number, prefix: number): number {
  const size = 2 ** (32 - prefix)
  return n - (n % size)
}

/**
 * Read what was typed as an address to allow. Answers the normalised CIDR, or
 * why it cannot be allowed, in a sentence that says what to send instead.
 */
export function parseAllowedAddress(input: unknown): ParsedAddress {
  const raw = typeof input === 'string' ? input.trim() : ''
  const shown = raw.length > 64 ? `${raw.slice(0, 64)}…` : raw
  const invalid = (): ParsedAddress => ({
    ok: false,
    code: 'INVALID_ADDRESS',
    message: `${shown ? `"${shown}" is not` : 'That is not'} an IPv4 address or range. Give one address, such as 203.0.113.7, or a range, such as 203.0.113.0/24.`,
  })
  if (!raw || raw.length > 64) return invalid()

  const parts = raw.split('/')
  if (parts.length > 2) return invalid()
  const [address, maskText] = parts
  if (address.includes(':')) {
    return {
      ok: false,
      code: 'IPV6_NOT_SUPPORTED',
      message: `${shown} is an IPv6 address. Direct Postgres connections come in over IPv4 only, so allow the IPv4 address you connect from.`,
    }
  }
  if (!isIPv4(address)) return invalid()
  if (maskText !== undefined && !/^\d{1,2}$/.test(maskText)) return invalid()
  const prefix = maskText === undefined ? 32 : Number(maskText)
  if (prefix > 32) return invalid()

  const network = networkOf(toInt(address), prefix)
  const cidr = `${fromInt(network)}/${prefix}`
  if (prefix === 0) {
    return {
      ok: false,
      code: 'ADDRESS_RANGE_TOO_WIDE',
      message: `${cidr} is every address on the internet. Allow only the addresses you connect from: one address, or a range no wider than /${WIDEST_PREFIX}.`,
    }
  }
  if (prefix < WIDEST_PREFIX) {
    return {
      ok: false,
      code: 'ADDRESS_RANGE_TOO_WIDE',
      message:
        `${cidr} covers ${(2 ** (32 - prefix)).toLocaleString('en-US')} addresses. A range can be at most /${WIDEST_PREFIX} ` +
        `(65,536 addresses): allow only the addresses you connect from.`,
    }
  }
  for (const [block, blockPrefix, called] of NOT_PUBLIC) {
    if (networkOf(network, blockPrefix) === toInt(block)) {
      return {
        ok: false,
        code: 'ADDRESS_NOT_PUBLIC',
        message: `${cidr} is ${called}, which never connects from the internet. Allow the public IPv4 address you connect from.`,
      }
    }
  }
  return { ok: true, cidr }
}

/** Whether `address` (a bare IPv4 address) is inside `cidr`. */
export function addressInRange(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/')
  if (!isIPv4(address) || !isIPv4(network)) return false
  const prefix = prefixText === undefined ? 32 : Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  return networkOf(toInt(address), prefix) === networkOf(toInt(network), prefix)
}

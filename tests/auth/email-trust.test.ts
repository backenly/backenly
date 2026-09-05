import { assessEmailTrust } from '@/lib/trust/email-trust'

// DNS is skipped throughout so the suite is deterministic and runs offline.
// That makes these assertions a *floor*: with MX resolution enabled several of
// the abusive addresses score higher still (cropimg.com's Cloudflare catch-all
// routing pushes it from 55 to 85, i.e. from `challenge` to `deny`).
const opts = { skipDns: true }

describe('assessEmailTrust', () => {
  describe('real users already in the production database', () => {
    // These are the addresses that must never be turned away. Several of them
    // look machine-generated on purpose — that is the point. The mailbox
    // provider credit is what keeps shape heuristics from convicting them.
    const legitimate = [
      'sandranair1661@gmail.com',
      'sandranairpg@gmail.com',
      'adhuadarshzz1@gmail.com',
      'yingquan526@gmail.com',
      'roma.gamer.2017@gmail.com',
      'beau.t.wino@gmail.com',
      'kyawswarno825@gmail.com',
      'lakshmikoonath@gmail.com',
      'adarshcj@hanyang.ac.kr',
    ]

    it.each(legitimate)('allows %s', async (email) => {
      const result = await assessEmailTrust(email, opts)
      expect(result.verdict).toBe('allow')
    })
  })

  describe('founders on their own domains', () => {
    // An unrecognised domain is worth 20 points on its own — deliberately well
    // below the challenge threshold, so a two-week-old company domain is not
    // treated as an attack.
    const customDomains = [
      'adarsh@mystartup.io',
      'hello@acme.co',
      'j.doe@some-agency.dev',
    ]

    it.each(customDomains)('allows %s', async (email) => {
      const result = await assessEmailTrust(email, opts)
      expect(result.verdict).toBe('allow')
    })
  })

  describe('the addresses that got through the old gate', () => {
    it('denies a local part that is our own hostname (form-filler bot)', async () => {
      const result = await assessEmailTrust('backenly.com@gravik.org', opts)
      expect(result.verdict).toBe('deny')
      expect(result.signals).toContain('brand_in_local_part')
    })

    it('flags a random base36 local part', async () => {
      const result = await assessEmailTrust('mrej6qi3ucj1@cropimg.com', opts)
      expect(result.verdict).not.toBe('allow')
      expect(result.signals).toContain('random_local_part')
    })

    it.each([
      'nehafic171@aganseo.com',
      'neliyit144@dysonc.com',
    ])('flags the generator shape in %s', async (email) => {
      const result = await assessEmailTrust(email, opts)
      expect(result.verdict).not.toBe('allow')
      expect(result.signals).toContain('generated_local_part')
    })
  })

  describe('classic disposable services', () => {
    it.each([
      'someone@mailinator.com',
      'someone@guerrillamail.com',
      'someone@yopmail.com',
      'test@sharklasers.com',
    ])('denies %s', async (email) => {
      const result = await assessEmailTrust(email, opts)
      expect(result.verdict).toBe('deny')
    })

    it('denies burner local parts even on a trusted provider', async () => {
      const result = await assessEmailTrust('tempemailburner@gmail.com', opts)
      expect(result.verdict).toBe('deny')
    })
  })

  describe('malformed input', () => {
    it.each(['', 'not-an-email', 'a@', '@b.com', 'a@b'])(
      'rejects %s',
      async (email) => {
        const result = await assessEmailTrust(email, opts)
        expect(result.verdict).toBe('deny')
      },
    )
  })

  it('reports a score and signals for the security feed', async () => {
    const result = await assessEmailTrust('nehafic171@aganseo.com', opts)
    expect(result.score).toBeGreaterThan(0)
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

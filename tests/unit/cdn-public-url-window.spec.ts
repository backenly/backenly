/**
 * A public file's signed CDN URL repeats for a window, so a browser can reuse
 * it (lib/storage/cdn.ts windowedPublicCdnUrl). Signed afresh on every request,
 * every view of a public image was a new URL that nothing could keep.
 */
import crypto from 'crypto'
import { cannedPolicy, windowedPublicCdnUrl, type SignedCdnConfig } from '@/lib/storage/cdn'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const config: SignedCdnConfig = { baseUrl: 'https://cdn.example.test', keyPairId: 'K-TEST', privateKey }
const at = (seconds: number) => new Date(seconds * 1000)
const WINDOW = 900
const START = 1_794_182_400 // a window boundary

const parts = (url: string) => {
  const u = new URL(url)
  return {
    resource: `${u.origin}${u.pathname}`,
    expires: Number(u.searchParams.get('Expires')),
    signature: u.searchParams.get('Signature')!,
  }
}

it('is the same URL for every request in one window', () => {
  const a = windowedPublicCdnUrl('p/mug.png', config, at(START + 1), WINDOW)
  const b = windowedPublicCdnUrl('p/mug.png', config, at(START + WINDOW - 1), WINDOW)
  expect(b.url).toBe(a.url)
})

it('says how long the redirect may be kept: the rest of the window', () => {
  expect(windowedPublicCdnUrl('p/mug.png', config, at(START + 1), WINDOW).maxAge).toBe(WINDOW - 1)
  expect(windowedPublicCdnUrl('p/mug.png', config, at(START + WINDOW - 1), WINDOW).maxAge).toBe(1)
})

it('stays valid a full window past the one it was handed out in', () => {
  const { expires } = parts(windowedPublicCdnUrl('p/mug.png', config, at(START + 10), WINDOW).url)
  expect(expires).toBe(START + 2 * WINDOW)
})

it('moves to a new URL in the next window', () => {
  const a = windowedPublicCdnUrl('p/mug.png', config, at(START + 1), WINDOW)
  const b = windowedPublicCdnUrl('p/mug.png', config, at(START + WINDOW), WINDOW)
  expect(b.url).not.toBe(a.url)
})

it('carries a signature CloudFront can verify for exactly that URL and expiry', () => {
  const { resource, expires, signature } = parts(windowedPublicCdnUrl('p/mug.png', config, at(START + 1), WINDOW).url)
  const raw = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64')
  const verifier = crypto.createVerify('RSA-SHA1')
  verifier.update(cannedPolicy(resource, expires))
  expect(verifier.verify(publicKey, raw)).toBe(true)
})

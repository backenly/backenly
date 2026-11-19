/**
 * Sign-in checks a stored bcrypt hash only at a cost Backenly would keep
 * (lib/auth/password.ts MAX_VERIFIED_BCRYPT_COST). Every sign-in in a process
 * shares its few hash slots, whatever the project, and a hash's own cost sets
 * how long its check holds one, so a hash dearer than 14 is answered no at once,
 * without hashing. The import reads only hashes sign-in would check.
 */

import bcrypt from 'bcrypt'
import { bcryptCost, MAX_VERIFIED_BCRYPT_COST, verifyPassword } from '@/lib/auth/password'
import { BCRYPT_HASH } from '@/lib/import/pg-source'

const hashAt = (cost: string) => `$2b$${cost}$${'a'.repeat(22)}${'b'.repeat(31)}`

it('reads the cost a bcrypt hash declares, and nothing from any other hash', () => {
  expect(bcryptCost(hashAt('12'))).toBe(12)
  expect(bcryptCost(hashAt('31'))).toBe(31)
  expect(bcryptCost('$firebase-scrypt$v=1$mem=14,rounds=8$a$b$c$d')).toBeNull()
  expect(bcryptCost('plain')).toBeNull()
})

it('answers a hash dearer than 14 with no, at once, without hashing', async () => {
  expect(MAX_VERIFIED_BCRYPT_COST).toBe(14)
  const spy = jest.spyOn(bcrypt, 'compare')
  const started = Date.now()
  await expect(verifyPassword('anything', hashAt('31'))).resolves.toBe(false)
  await expect(verifyPassword('anything', hashAt('15'))).resolves.toBe(false)
  expect(Date.now() - started).toBeLessThan(500)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})

it('still checks every hash Backenly makes, and a cheaper one moved in', async () => {
  const made = await bcrypt.hash('correct horse', 12)
  await expect(verifyPassword('correct horse', made)).resolves.toBe(true)
  await expect(verifyPassword('wrong', made)).resolves.toBe(false)
  const movedIn = await bcrypt.hash('battery staple', 10)
  await expect(verifyPassword('battery staple', movedIn)).resolves.toBe(true)
}, 30_000)

it('reads a source user’s password only at a cost sign-in checks', () => {
  const source = new RegExp(BCRYPT_HASH)
  for (const c of ['04', '10', '12', '14']) expect(source.test(hashAt(c))).toBe(true)
  for (const c of ['03', '15', '31']) expect(source.test(hashAt(c))).toBe(false)
})

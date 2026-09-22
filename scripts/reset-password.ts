#!/usr/bin/env tsx
/**
 * Reset a Backenly account's password from the server itself.
 *
 * The recovery path for a self-hosted deployment with no email configured,
 * which is most of them: the reset page cannot send a code there, and until
 * this existed an operator who forgot their password had to edit the users
 * table by hand. Access to this machine and its database is the authority, the
 * same trust `npm run selfhost` and the setup token already rest on. Grafana
 * (`grafana-cli admin reset-admin-password`), GitLab (`gitlab-rake
 * gitlab:password:reset`) and n8n (`user-management:reset`) do the same.
 *
 * Every existing session for the account ends, and a lockout from failed
 * sign-ins is lifted.
 *
 * Usage:
 *   npm run auth:reset-password -- --email you@example.com
 *       prompts for the new password (not echoed)
 *   npm run auth:reset-password -- --email you@example.com --generate
 *       generates a strong password and prints it once
 *   echo 'N3w-Passw0rd!x' | npm run auth:reset-password -- --email you@example.com
 *       reads the password from standard input
 *
 * Exit codes: 0 reset, 1 refused (no such account, weak password), 2 usage.
 */
import { randomBytes } from 'crypto'
import * as readline from 'readline'
import { prisma } from '@/lib/db/prisma'
import { hashPassword } from '@/lib/auth/password'
import { validatePasswordStrength, PASSWORD_POLICY_HINT } from '@/lib/auth/password-policy'

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const

function argValue(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function usage(message: string): never {
  console.error(`${message}\n\nUsage: npm run auth:reset-password -- --email you@example.com [--generate]`)
  process.exit(EXIT.USAGE)
}

/** Meets the policy by construction, and is checked against it anyway. */
function generatePassword(): string {
  for (;;) {
    const candidate = `${randomBytes(15).toString('base64url')}-Aa9`
    if (validatePasswordStrength(candidate).valid) return candidate
  }
}

function promptHidden(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // Print the question, echo nothing the operator types.
    ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.startsWith(question)) process.stdout.write(question)
    }
    rl.question(question, answer => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? ''
}

async function choosePassword(): Promise<{ password: string; generated: boolean }> {
  if (process.argv.includes('--generate')) return { password: generatePassword(), generated: true }
  if (!process.stdin.isTTY) return { password: await readStdinLine(), generated: false }

  console.log(`New password: ${PASSWORD_POLICY_HINT}`)
  const first = await promptHidden('New password: ')
  const second = await promptHidden('Repeat it:    ')
  if (first !== second) {
    console.error('The two passwords did not match. Nothing was changed.')
    process.exit(EXIT.REFUSED)
  }
  return { password: first, generated: false }
}

async function main(): Promise<void> {
  const email = argValue('--email')?.trim().toLowerCase()
  if (!email || !email.includes('@')) usage('--email is required.')

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    select: { id: true, email: true },
  })
  if (!user) {
    console.error(`No account with the email ${email} exists on this deployment. Nothing was changed.`)
    process.exit(EXIT.REFUSED)
  }

  const { password, generated } = await choosePassword()
  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    console.error(`${strength.message}. Nothing was changed.`)
    process.exit(EXIT.REFUSED)
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: await hashPassword(password),
      tokenVersion: { increment: 1 },
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  })
  const ended = await prisma.session.deleteMany({ where: { userId: user.id } })
  // A reset code mailed earlier must not still work after the password moved.
  await prisma.authEmailCode.deleteMany({ where: { purpose: 'password_reset', email } })
  await prisma.auditLog.create({
    data: {
      action: 'Password reset completed',
      type: 'cli',
      userId: user.id,
      userEmail: user.email,
      details: 'Password reset from the server with npm run auth:reset-password; all sessions ended',
    },
  })

  console.log(`Password reset for ${user.email}. ${ended.count} session(s) ended.`)
  if (generated) {
    console.log(`\n  New password: ${password}\n\nIt is shown once and stored nowhere. Sign in and change it if you like.`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(EXIT.OK))
  .catch(async error => {
    console.error('Password reset failed:', error instanceof Error ? error.message : error)
    await prisma.$disconnect().catch(() => {})
    process.exit(EXIT.REFUSED)
  })

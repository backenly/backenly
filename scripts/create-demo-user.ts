/**
 * Create demo user for Paddle verification
 * Usage: npx ts-node scripts/create-demo-user.ts
 */

import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/prisma'
import { resolveFreePlan } from '@/lib/billing'

async function createDemoUser() {
  try {
    const email = 'demo@backenly.com'
    const password = 'Demo123!'
    const name = 'Demo User'

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    })

    if (existingUser) {
      console.log('Demo user already exists, updating password...')
      const hashedPassword = await bcrypt.hash(password, 10)
      await prisma.user.update({
        where: { email },
        data: { password: hashedPassword }
      })
      console.log('✅ Demo user password updated')
    } else {
      console.log('Creating demo user...')
      const hashedPassword = await bcrypt.hash(password, 10)
      
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          emailVerified: true,
          provider: 'email'
        }
      })

      // Free subscription, resolved through the one canonical rule
      // (SANDBOX, then legacy FREE). This used to look up FREE directly, which
      // prisma/seed-billing.ts does not create, so the demo user was silently
      // left with no subscription at all.
      const freePlan = await resolveFreePlan()

      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: freePlan.id,
          status: 'FREE'
        }
      })
      console.log(`✅ ${freePlan.name} subscription created`)

      console.log('✅ Demo user created successfully')
    }

    console.log('\nDemo Credentials:')
    console.log('Email: demo@backenly.com')
    console.log('Password: Demo123!')

  } catch (error) {
    console.error('Error creating demo user:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

createDemoUser()

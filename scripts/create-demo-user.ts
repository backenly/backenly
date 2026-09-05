/**
 * Create demo user for Paddle verification
 * Usage: npx ts-node scripts/create-demo-user.ts
 */

import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/prisma'
import { initializeAccountEntitlements } from '@/lib/entitlements'

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

      // Entitle the account through the seam rather than resolving a Plan row
      // here. A no-op in a public checkout, where there is nothing to bill;
      // composed Cloud creates the free subscription it always did.
      await initializeAccountEntitlements(user.id)
      console.log('✅ Account entitlements initialised')

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

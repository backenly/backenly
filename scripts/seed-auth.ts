/**
 * Seed script for default roles and auth providers
 * Run with: npx tsx scripts/seed-auth.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding default roles...')
  
  // Create default roles
  const roles = [
    {
      name: 'Administrator',
      description: 'Full access to all resources and settings',
      permissions: ['read', 'write', 'delete', 'admin', 'manage-users'],
    },
    {
      name: 'Developer',
      description: 'Can read and write data, deploy functions',
      permissions: ['read', 'write', 'deploy'],
    },
    {
      name: 'Read-Only',
      description: 'Can only view data and logs',
      permissions: ['read'],
    },
    {
      name: 'AI Service',
      description: 'Limited to AI generation and analysis operations',
      permissions: ['ai-generate', 'ai-analyze'],
    },
  ]
  
  for (const roleData of roles) {
    await prisma.role.upsert({
      where: { 
        name_projectId: {
          name: roleData.name,
          projectId: null,
        },
      },
      update: roleData,
      create: roleData,
    })
    console.log(`✓ Created/updated role: ${roleData.name}`)
  }
  
  console.log('\nSeeding default auth providers...')
  
  // Create default auth providers
  const providers = [
    {
      name: 'email',
      enabled: true,
      configured: true,
      type: 'email' as const,
      icon: 'Mail',
    },
    {
      name: 'google',
      enabled: false,
      configured: false,
      type: 'oauth' as const,
      icon: 'Chrome',
    },
    {
      name: 'github',
      enabled: false,
      configured: false,
      type: 'oauth' as const,
      icon: 'Github',
    },
    {
      name: 'microsoft',
      enabled: false,
      configured: false,
      type: 'oauth' as const,
      icon: 'Building2',
      warning: 'Email verification is disabled. This may reduce security.',
    },
  ]
  
  for (const providerData of providers) {
    await prisma.authProvider.upsert({
      where: { name: providerData.name },
      update: providerData,
      create: providerData,
    })
    console.log(`✓ Created/updated provider: ${providerData.name}`)
  }
  
  console.log('\n✅ Seeding complete!')
}

main()
  .catch((e) => {
    console.error('Error seeding:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })


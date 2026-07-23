/**
 * Update Plan Prices
 * 
 * Updates the HOBBY and PRO plan prices to match Paddle configuration
 * HOBBY: $20/month, PRO: $99/month
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('📝 Updating plan prices...\n')

  // Update HOBBY plan to $20
  const hobbyPlan = await prisma.plan.update({
    where: { name: 'HOBBY' },
    data: { priceCents: 2000 }
  })
  console.log(`✅ HOBBY plan updated: $${hobbyPlan.priceCents / 100}/month`)

  // Update PRO plan to $99
  const proPlan = await prisma.plan.update({
    where: { name: 'PRO' },
    data: { priceCents: 9900 }
  })
  console.log(`✅ PRO plan updated: $${proPlan.priceCents / 100}/month`)

  console.log('\n✨ Plan prices updated successfully!')
}

main()
  .catch((e) => {
    console.error('❌ Update failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

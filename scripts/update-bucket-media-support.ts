/**
 * Script to update bucket security policies to support media files
 * 
 * Usage:
 *   npx ts-node scripts/update-bucket-media-support.ts --bucket=videos
 *   npx ts-node scripts/update-bucket-media-support.ts --bucket=images --preset=media
 *   npx ts-node scripts/update-bucket-media-support.ts --all --preset=unrestricted
 */

import { PrismaClient } from '@prisma/client'

// Security presets (inlined to avoid module resolution issues)
const STORAGE_SECURITY_PRESETS = {
  images: {
    name: 'Images Only',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
    blockExecutables: true,
  },
  media: {
    name: 'Images & Videos',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/wav', 'audio/ogg'],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.ogv', '.mp3', '.wav', '.ogg'],
    blockExecutables: true,
  },
  unrestricted: {
    name: 'Unrestricted',
    allowedMimeTypes: [],
    allowedExtensions: [],
    blockExecutables: false,
  },
}

const prisma = new PrismaClient()

async function main() {
  const args = process.argv.slice(2)
  const bucketName = args.find(arg => arg.startsWith('--bucket='))?.split('=')[1]
  const presetName = args.find(arg => arg.startsWith('--preset='))?.split('=')[1] || 'media'
  const updateAll = args.includes('--all')

  if (!updateAll && !bucketName) {
    console.error('❌ Error: Must specify --bucket=NAME or --all')
    console.log('\nUsage:')
    console.log('  npx ts-node scripts/update-bucket-media-support.ts --bucket=videos')
    console.log('  npx ts-node scripts/update-bucket-media-support.ts --bucket=images --preset=media')
    console.log('  npx ts-node scripts/update-bucket-media-support.ts --all --preset=unrestricted')
    console.log('\nAvailable presets:', Object.keys(STORAGE_SECURITY_PRESETS).join(', '))
    process.exit(1)
  }

  const preset = STORAGE_SECURITY_PRESETS[presetName as keyof typeof STORAGE_SECURITY_PRESETS]
  if (!preset) {
    console.error(`❌ Error: Preset "${presetName}" not found`)
    console.log('Available presets:', Object.keys(STORAGE_SECURITY_PRESETS).join(', '))
    process.exit(1)
  }

  console.log(`\n🔧 Updating bucket(s) with preset: "${preset.name}"`)
  console.log(`   Allowed extensions: ${preset.allowedExtensions.join(', ') || 'All'}`)
  console.log(`   Allowed MIME types: ${preset.allowedMimeTypes.join(', ') || 'All'}`)
  console.log(`   Block executables: ${preset.blockExecutables}`)

  let buckets
  if (updateAll) {
    buckets = await prisma.storageBucket.findMany()
    console.log(`\n📦 Found ${buckets.length} bucket(s) to update`)
  } else {
    buckets = await prisma.storageBucket.findMany({
      where: { name: bucketName }
    })
    
    if (buckets.length === 0) {
      console.error(`\n❌ Error: No bucket found with name "${bucketName}"`)
      
      // Show available buckets
      const allBuckets = await prisma.storageBucket.findMany({
        select: { name: true, projectId: true }
      })
      if (allBuckets.length > 0) {
        console.log('\nAvailable buckets:')
        allBuckets.forEach(b => console.log(`  - ${b.name} (Project: ${b.projectId})`))
      }
      process.exit(1)
    }
    console.log(`\n📦 Found ${buckets.length} bucket(s) named "${bucketName}"`)
  }

  for (const bucket of buckets) {
    console.log(`\n⏳ Updating bucket: ${bucket.name} (${bucket.id})`)
    
    await prisma.storageBucket.update({
      where: { id: bucket.id },
      data: {
        allowedMimeTypes: preset.allowedMimeTypes,
        allowedExtensions: preset.allowedExtensions,
        blockExecutables: preset.blockExecutables,
      }
    })
    
    console.log(`   ✅ Updated successfully`)
  }

  console.log(`\n✨ Done! Updated ${buckets.length} bucket(s)\n`)
}

main()
  .catch((error) => {
    console.error('\n❌ Error:', error.message)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

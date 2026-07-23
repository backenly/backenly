import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const buckets = await prisma.storageBucket.findMany({
    where: { name: 'videos' }
  })
  
  console.log('Videos bucket(s):')
  buckets.forEach(b => {
    console.log('\nBucket:', b.name)
    console.log('ID:', b.id)
    console.log('Project:', b.projectId)
    console.log('Allowed Extensions:', b.allowedExtensions)
    console.log('Allowed MIME Types:', b.allowedMimeTypes)
    console.log('Block Executables:', b.blockExecutables)
  })
}

main()
  .finally(() => prisma.$disconnect())
